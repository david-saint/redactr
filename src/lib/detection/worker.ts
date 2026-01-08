/// <reference lib="webworker" />

import { pipeline, env } from "@xenova/transformers";

// Detection result type from transformers.js
interface DetectionResult {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

// Pipeline type
type DetectionPipeline = (image: string) => Promise<DetectionResult[]>;

import type {
  Detection,
  DetectionType,
  DetectMessage,
  CancelMessage,
  WorkerRequest,
} from "./types";

// Configure transformers.js for browser usage
env.allowLocalModels = false;
env.useBrowserCache = true;

// Model pipelines (lazy loaded)
// Note: Face detection is now handled by MediaPipe in the main thread
let objectDetector: DetectionPipeline | null = null; // For documents
let plateDetector: DetectionPipeline | null = null; // For license plates

// Track current request for cancellation
let currentRequestId: string | null = null;
let isCancelled = false;

// Utility to generate unique IDs
function generateId(): string {
  return Math.random().toString(36).substring(2, 11);
}

// Download progress reporter
function reportDownloadProgress(progress: number, stage: string) {
  self.postMessage({ type: "download_progress", progress, stage });
}

// Report download complete
function reportDownloadComplete() {
  self.postMessage({ type: "download_complete" });
}

// Progress reporter
function reportProgress(progress: number, stage: string) {
  self.postMessage({ type: "progress", progress, stage });
}

// Report detected results
function reportResults(detections: Detection[]) {
  self.postMessage({ type: "results", detections });
}

// Report completion
function reportComplete() {
  self.postMessage({ type: "complete" });
}

// Report error
function reportError(error: string) {
  self.postMessage({ type: "error", error });
}

// Report model loaded
function reportModelLoaded(modelType: DetectionType) {
  self.postMessage({ type: "model_loaded", modelType });
}

// Convert ImageData to base64 data URL for transformers.js
function imageDataToDataUrl(imageData: ImageData): string {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2d context");
  ctx.putImageData(imageData, 0, 0);

  // Convert to blob then to base64
  // Note: For now, we'll use a workaround since OffscreenCanvas.toDataURL isn't available
  // We'll pass the raw pixel data and dimensions instead
  return "";
}

// Track if models are being downloaded (first run)
let isDownloadingModels = false;

// Face detection using MediaPipe (runs in main thread)
// MediaPipe doesn't support Web Workers, so we signal the main thread to run it
async function detectFaces(
  imageData: ImageData,
  isFirstRun: boolean
): Promise<Detection[]> {
  if (isCancelled) return [];

  // Signal main thread to run MediaPipe face detection
  // This is necessary because MediaPipe requires DOM access for WASM loading
  self.postMessage({ type: "run_mediapipe_face_detection" });

  // Return empty - the main thread will handle the results
  return [];
}

// Object detection for documents only (license plates use separate detector)
async function detectDocuments(
  imageData: ImageData,
  isFirstRun: boolean
): Promise<Detection[]> {
  if (isCancelled) return [];

  const needsDownload = !objectDetector;

  if (needsDownload && isFirstRun) {
    reportDownloadProgress(
      50,
      "Downloading document detection model (~10MB)..."
    );
  } else {
    reportProgress(60, "Loading document detection model...");
  }

  try {
    if (!objectDetector) {
      const detector = await pipeline(
        "object-detection",
        "Xenova/detr-resnet-50",
        {
          progress_callback: (progress: { progress?: number }) => {
            if (progress.progress !== undefined && isFirstRun) {
              const percent = 50 + Math.round(progress.progress * 20); // 50-70%
              reportDownloadProgress(
                percent,
                `Downloading document detection model... ${percent}%`
              );
            }
          },
        }
      );
      objectDetector = detector as unknown as DetectionPipeline;
      reportModelLoaded("document");
    }

    if (isCancelled) return [];
    reportProgress(70, "Detecting documents...");

    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.putImageData(imageData, 0, 0);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const results = (await objectDetector(blobUrl)) as DetectionResult[];
      const detections: Detection[] = [];

      for (const result of results) {
        const label = result.label.toLowerCase();
        // Books, laptops, cell phones might contain documents/screens
        if (
          ["book", "laptop", "cell phone", "tv", "monitor"].includes(label) &&
          result.score > 0.5
        ) {
          detections.push({
            id: generateId(),
            type: "document",
            bbox: {
              x: result.box.xmin,
              y: result.box.ymin,
              width: result.box.xmax - result.box.xmin,
              height: result.box.ymax - result.box.ymin,
            },
            confidence: result.score,
            selected: true,
            label: result.label,
          });
        }
      }
      return detections;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (error) {
    console.error("Document detection error:", error);
    return [];
  }
}

// License plate detection using specialized YOLOS-LPD model
async function detectLicensePlates(
  imageData: ImageData,
  isFirstRun: boolean
): Promise<Detection[]> {
  if (isCancelled) return [];

  const needsDownload = !plateDetector;

  if (needsDownload && isFirstRun) {
    reportDownloadProgress(
      35,
      "Downloading license plate detection model (~25MB)..."
    );
  } else {
    reportProgress(40, "Loading license plate detection model...");
  }

  try {
    if (!plateDetector) {
      const detector = await pipeline(
        "object-detection",
        "nickmuchi/yolos-small-finetuned-license-plate-detection",
        {
          progress_callback: (progress: { progress?: number }) => {
            if (progress.progress !== undefined && isFirstRun) {
              const percent = 35 + Math.round(progress.progress * 15); // 35-50%
              reportDownloadProgress(
                percent,
                `Downloading license plate detection model... ${percent}%`
              );
            }
          },
        }
      );
      plateDetector = detector as unknown as DetectionPipeline;
      reportModelLoaded("license_plate");
    }

    if (isCancelled) return [];
    reportProgress(50, "Detecting license plates...");

    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.putImageData(imageData, 0, 0);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const results = (await plateDetector(blobUrl)) as DetectionResult[];
      const detections: Detection[] = [];

      for (const result of results) {
        // The model outputs "license-plate" or similar label
        if (result.score > 0.3) {
          detections.push({
            id: generateId(),
            type: "license_plate",
            bbox: {
              x: result.box.xmin,
              y: result.box.ymin,
              width: result.box.xmax - result.box.xmin,
              height: result.box.ymax - result.box.ymin,
            },
            confidence: result.score,
            selected: true,
            label: `License Plate (${Math.round(result.score * 100)}%)`,
          });
        }
      }
      return detections;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (error) {
    console.error("License plate detection error:", error);
    return [];
  }
}

// Text detection using Tesseract.js (run in main thread, this is a placeholder)
// Note: Tesseract.js doesn't work well in workers, so we'll handle it differently
async function detectText(imageData: ImageData): Promise<Detection[]> {
  // Text detection will be handled by the main thread using Tesseract.js
  // This is a placeholder that signals the manager to run text detection
  return [];
}

// Main detection handler
async function runDetection(message: DetectMessage) {
  currentRequestId = message.requestId;
  isCancelled = false;
  isDownloadingModels = false;

  const { imageData, enabledTypes, isFirstRun } = message;

  try {
    if (isFirstRun) {
      reportDownloadProgress(0, "Preparing to download AI models...");
    } else {
      reportProgress(0, "Starting detection...");
    }

    // Run face detection
    if (enabledTypes.includes("face") && !isCancelled) {
      const faces = await detectFaces(imageData, isFirstRun);
      if (faces.length > 0 && !isCancelled) {
        reportResults(faces);
      }
    }

    // Run license plate detection
    if (enabledTypes.includes("license_plate") && !isCancelled) {
      const plates = await detectLicensePlates(imageData, isFirstRun);
      if (plates.length > 0 && !isCancelled) {
        reportResults(plates);
      }
    }

    // Run document detection
    if (enabledTypes.includes("document") && !isCancelled) {
      const docs = await detectDocuments(imageData, isFirstRun);
      if (docs.length > 0 && !isCancelled) {
        reportResults(docs);
      }
    }

    // Report download complete if this was first run
    if (isFirstRun && !isCancelled) {
      reportDownloadProgress(85, "AI models downloaded successfully!");
      reportDownloadComplete();
    }

    // Signal that text detection should run in main thread
    if (enabledTypes.includes("text") && !isCancelled) {
      self.postMessage({ type: "run_text_detection" });
    }

    if (!isCancelled) {
      reportProgress(100, "Detection complete");
      reportComplete();
    }
  } catch (error) {
    if (!isCancelled) {
      reportError(error instanceof Error ? error.message : "Detection failed");
    }
  }

  currentRequestId = null;
}

// Message handler
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "detect":
      await runDetection(message);
      break;

    case "cancel":
      if (currentRequestId === message.requestId) {
        isCancelled = true;
        self.postMessage({ type: "cancelled" });
      }
      break;
  }
};

// Export empty object for module compatibility
export {};
