import { get } from "svelte/store";
import { detectionStore, needsModelDownload } from "../stores/detection";
import type {
  DetectionType,
  Detection,
  DetectionBackend,
  WorkerResponse,
  DetectMessage,
  CancelMessage,
} from "./types";
import { imageStore } from "../stores/image";
import Tesseract from "tesseract.js";
import { detectFaces, isFaceDetectorReady } from "./mediapipe-face";

// Track if this is the first detection (models need download)
let isFirstRun = true;

// Worker instance
let worker: Worker | null = null;
let currentRequestId: string | null = null;

// Tesseract worker for text detection
let tesseractWorker: Tesseract.Worker | null = null;
let tesseractReady = false;

// Generate unique request ID
function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 11);
}

// Detect available backend
async function detectBackend(): Promise<DetectionBackend> {
  // Check WebGPU
  if ("gpu" in navigator) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu;
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        return "webgpu";
      }
    } catch {
      // WebGPU not available
    }
  }

  // Check WebGL
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  if (gl) {
    return "webgl";
  }

  // Fallback to CPU
  return "cpu";
}

// Initialize the detection worker
async function initWorker(): Promise<Worker> {
  if (worker) return worker;

  // Detect and set backend
  const backend = await detectBackend();
  detectionStore.setBackend(backend);

  // Create worker
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });

  // Handle worker messages
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;

    switch (message.type) {
      case "download_progress":
        detectionStore.updateDownloadProgress(message.progress, message.stage);
        break;

      case "download_complete":
        detectionStore.finishDownload();
        isFirstRun = false;
        break;

      case "progress":
        detectionStore.updateProgress(message.progress, message.stage);
        break;

      case "results":
        detectionStore.addResults(message.detections);
        break;

      case "model_loaded":
        detectionStore.setModelLoaded(message.modelType, true);
        break;

      case "complete":
        // Don't finish yet if text detection is pending
        break;

      case "run_text_detection":
        // Run text detection in main thread
        runTextDetection();
        break;

      case "run_mediapipe_face_detection":
        // Run MediaPipe face detection in main thread (doesn't support workers)
        runMediaPipeFaceDetection();
        break;

      case "error":
        detectionStore.setError(message.error);
        break;

      case "cancelled":
        detectionStore.clearResults();
        break;
    }
  };

  worker.onerror = (error) => {
    console.error("Detection worker error:", error);
    detectionStore.setError("Detection worker crashed");
  };

  return worker;
}

// Initialize Tesseract worker for text detection
async function initTesseract(): Promise<Tesseract.Worker> {
  if (tesseractWorker && tesseractReady) return tesseractWorker;

  detectionStore.updateProgress(75, "Loading text recognition model...");

  tesseractWorker = await Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && m.progress) {
        detectionStore.updateProgress(
          75 + m.progress * 20,
          "Recognizing text..."
        );
      }
    },
  });

  tesseractReady = true;
  detectionStore.setModelLoaded("text", true);

  return tesseractWorker;
}

// Run text detection using Tesseract.js
async function runTextDetection(): Promise<void> {
  const state = get(detectionStore);
  if (!state.enabledTypes.includes("text")) {
    finishDetection();
    return;
  }

  const imageData = get(imageStore).current;
  if (!imageData) {
    finishDetection();
    return;
  }

  try {
    const worker = await initTesseract();

    // Convert ImageData to canvas for Tesseract
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.putImageData(imageData, 0, 0);

    // Get data URL for Tesseract
    const dataUrl = canvas.toDataURL("image/png");

    // Recognize text
    const result = await worker.recognize(dataUrl);

    // Convert words to detections
    const textDetections: Detection[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const words = (result.data as any).words as
      | Array<{
          confidence: number;
          text: string;
          bbox: { x0: number; y0: number; x1: number; y1: number };
        }>
      | undefined;

    if (words) {
      for (const word of words) {
        if (word.confidence > 60 && word.text.trim().length > 0) {
          textDetections.push({
            id: Math.random().toString(36).substring(2, 11),
            type: "text",
            bbox: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
            },
            confidence: word.confidence / 100,
            selected: true,
            label: word.text,
          });
        }
      }
    }

    if (textDetections.length > 0) {
      detectionStore.addResults(textDetections);
    }
  } catch (error) {
    console.error("Text detection error:", error);
  }

  finishDetection();
}

// Run MediaPipe face detection in main thread
// MediaPipe doesn't support Web Workers, so we run it here
async function runMediaPipeFaceDetection(): Promise<void> {
  const state = get(detectionStore);
  if (!state.enabledTypes.includes("face")) {
    return;
  }

  const imageData = get(imageStore).current;
  if (!imageData) {
    return;
  }

  try {
    const faceDetections = await detectFaces(imageData, (progress, stage) => {
      detectionStore.updateProgress(progress, stage);
    });

    if (faceDetections.length > 0) {
      detectionStore.addResults(faceDetections);
    }

    // Mark face model as loaded
    if (!state.modelsLoaded.face) {
      detectionStore.setModelLoaded("face", true);
    }
  } catch (error) {
    console.error("MediaPipe face detection error:", error);
  }
}

// Mark detection as complete
function finishDetection(): void {
  detectionStore.finishDetection();
  currentRequestId = null;
}

// Check if models need to be downloaded
export function checkNeedsDownload(): boolean {
  return get(needsModelDownload);
}

// Start detection on current image
export async function startDetection(): Promise<void> {
  const imageData = get(imageStore).current;
  if (!imageData) {
    detectionStore.setError("No image loaded");
    return;
  }

  const state = get(detectionStore);
  if (state.isDetecting || state.isDownloading) {
    console.warn("Detection or download already in progress");
    return;
  }

  if (state.enabledTypes.length === 0) {
    detectionStore.setError("No detection types enabled");
    return;
  }

  // Check if user has given consent for model download
  const needsDownload = get(needsModelDownload);
  if (needsDownload && !state.hasUserConsent) {
    // This shouldn't happen if UI is correct, but safeguard
    detectionStore.setError("Please confirm model download first");
    return;
  }

  // If models need download, start download phase
  if (needsDownload) {
    detectionStore.startDownload();
  }

  // Start detection
  detectionStore.startDetection();
  currentRequestId = generateRequestId();

  try {
    const w = await initWorker();

    // Send detection request to worker
    w.postMessage({
      type: "detect",
      imageData: imageData,
      enabledTypes: state.enabledTypes,
      requestId: currentRequestId,
      isFirstRun: needsDownload,
    });
  } catch (error) {
    detectionStore.setError(
      error instanceof Error ? error.message : "Failed to start detection"
    );
  }
}

// Cancel ongoing detection
export function cancelDetection(): void {
  if (worker && currentRequestId) {
    worker.postMessage({
      type: "cancel",
      requestId: currentRequestId,
    });
  }
  currentRequestId = null;
}

// Cleanup resources
export async function cleanup(): Promise<void> {
  if (worker) {
    worker.terminate();
    worker = null;
  }

  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
    tesseractReady = false;
  }
}

// Check if models are cached (for offline indicator)
export function getLoadedModels(): {
  face: boolean;
  text: boolean;
  license_plate: boolean;
  document: boolean;
} {
  return get(detectionStore).modelsLoaded;
}
