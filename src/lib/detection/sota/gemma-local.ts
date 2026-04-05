import {
  FilesetResolver,
  LlmInference,
  type ProgressListener,
} from "@mediapipe/tasks-genai";
import { sotaStore } from "../../stores/sota";
import { SOTAError, type LisaEvaluation, type RalphPlan } from "./types";
import { parseJSONResponse } from "./openrouter";
import { detectFaces } from "../mediapipe-face";
import type { Detection } from "../types";
import Tesseract from "tesseract.js";
import { pipeline } from "@xenova/transformers";

const WASM_BASE_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.27/wasm";

const GEMMA_MODEL_NAME = "Gemma 4 E2B (.task)";

interface DetectionResult {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

type DetectionPipeline = (image: string) => Promise<DetectionResult[]>;

const LOCAL_LISA_SYSTEM_PROMPT = `You are Lisa, a privacy evaluation AI. Review the candidate detections and return ONLY valid JSON.

Score privacy while preserving usefulness:
- Faces that can identify a person should count as leaks.
- Readable personal text, IDs, badges, screens, documents, and license plates should count as leaks.
- Already obscured regions should be credited, not flagged.
- Only flag items that are truly identifying or readable.
- Be conservative. Generic logos, brand names, decorative text, and non-sensitive words are NOT privacy leaks.
- If the evidence is weak or ambiguous, prefer a higher score and fewer leaks.
- If there are no plausible identifying detections, return score 1.0 and an empty visibleLeaks array.

Return JSON with this exact shape:
{
  "vaguenessScore": <number 0.0-1.0>,
  "visibleLeaks": [
    {
      "type": "<face|text|license_plate|document|other>",
      "description": "<specific leak>",
      "region": {
        "x": <integer pixels>,
        "y": <integer pixels>,
        "width": <integer pixels>,
        "height": <integer pixels>
      }
    }
  ],
  "reasoning": "<brief explanation>"
}`;

const LOCAL_RALPH_SYSTEM_PROMPT = `You are Ralph, a privacy redaction planning AI. Plan MINIMAL redactions from the supplied detections and return ONLY valid JSON.

Rules:
- Redact only the specific leaks Lisa identified.
- Keep boxes tight.
- Use pixelate for faces and plates.
- Use solid for sensitive text.
- Use blur only for low-risk context.
- Stay within image bounds.

Return JSON with this exact shape:
{
  "redactions": [
    {
      "style": "<solid|pixelate|blur>",
      "x": <left integer>,
      "y": <top integer>,
      "width": <integer>,
      "height": <integer>,
      "intensity": <integer 1-100>,
      "reason": "<specific reason>"
    }
  ],
  "explanation": "<brief overview>"
}`;

type LisaRawResponse = {
  vaguenessScore: number;
  visibleLeaks?: Array<{
    type: string;
    description: string;
    region?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  reasoning: string;
};

type RalphRawResponse = {
  redactions?: Array<{
    style: string;
    x: number;
    y: number;
    width: number;
    height: number;
    intensity: number;
    reason: string;
  }>;
  explanation: string;
};

let wasmFilesetPromise: Promise<Awaited<ReturnType<typeof FilesetResolver.forGenAiTasks>>> | null = null;
let llmInference: LlmInference | null = null;
let currentModelName: string | null = null;
let tesseractWorker: Tesseract.Worker | null = null;
let objectDetector: DetectionPipeline | null = null;

const SENSITIVE_TEXT_PATTERNS = [
  /@/,
  /\d{3,}/,
  /https?:\/\//i,
  /\b(email|phone|tel|id|license|account|address|name|ssn)\b/i,
];

function ensureBrowserSupport(): void {
  if (typeof window === "undefined") {
    throw new SOTAError(
      "unknown",
      "Local Gemma can only run in the browser.",
      false,
    );
  }

  if (!("gpu" in navigator)) {
    throw new SOTAError(
      "unknown",
      "WebGPU is required for the local Gemma prototype.",
      false,
    );
  }
}

async function getWasmFileset() {
  if (!wasmFilesetPromise) {
    wasmFilesetPromise = FilesetResolver.forGenAiTasks(WASM_BASE_PATH);
  }

  return wasmFilesetPromise;
}

export function isLocalGemmaAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function unloadLocalGemmaModel(): void {
  if (llmInference) {
    llmInference.close();
    llmInference = null;
  }
  currentModelName = null;
  sotaStore.resetLocalModel();
}

export async function loadLocalGemmaModel(file: File): Promise<void> {
  ensureBrowserSupport();

  if (!file.name.endsWith(".task") && !file.name.endsWith(".litertlm")) {
    throw new SOTAError(
      "unknown",
      "Choose a Gemma 4 E2B web model file ending in .task or .litertlm.",
      false,
    );
  }

  if (llmInference) {
    llmInference.close();
    llmInference = null;
  }

  sotaStore.setLocalModelLoading(file.name);

  try {
    const wasmFileset = await getWasmFileset();
    const reader = file.stream().getReader();

    llmInference = await LlmInference.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetBuffer: reader,
        delegate: "GPU",
      },
      maxTokens: 4096,
      topK: 40,
      temperature: 0.2,
      randomSeed: 7,
    });

    currentModelName = file.name;
    sotaStore.setLocalModelReady(file.name);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to load the local Gemma model.";

    llmInference = null;
    currentModelName = null;
    sotaStore.setLocalModelError(message, file.name);
    throw new SOTAError("unknown", message, true);
  }
}

function extractAssistantContent(raw: string): string {
  const withoutBos = raw.replace(/^<bos>/, "").trim();
  const modelStart = withoutBos.lastIndexOf("<|turn>model");
  const relevant = modelStart >= 0
    ? withoutBos.slice(modelStart + "<|turn>model".length)
    : withoutBos;

  const withoutTurn = relevant.replace(/<turn\|>/g, "").trim();
  return withoutTurn.replace(/<\|channel>thought[\s\S]*?<channel\|>/g, "").trim();
}

async function generateJSON(
  systemPrompt: string,
  userText: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!llmInference || !currentModelName) {
    throw new SOTAError(
      "unknown",
      `Load ${GEMMA_MODEL_NAME} before using the local Lisa/Ralph prototype.`,
      false,
    );
  }

  if (signal?.aborted) {
    throw new SOTAError("network", "Request was cancelled", false);
  }

  const onAbort = () => {
    llmInference?.cancelProcessing();
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  const listener: ProgressListener = (partialResult) => {
    responseText = partialResult;
  };

  try {
    const response = await llmInference.generateResponse(
      `<bos><|turn>system\n${systemPrompt}<turn|>\n<|turn>user\n${userText}<turn|>\n<|turn>model\n`,
      listener,
    );
    return extractAssistantContent(response || responseText);
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && /cancel/i.test(err.message))) {
      throw new SOTAError("network", "Request was cancelled", false);
    }

    throw new SOTAError(
      "unknown",
      err instanceof Error
        ? err.message
        : "Local Gemma inference failed.",
      true,
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function evaluateWithLocalGemmaLisa(
  imageData: ImageData,
  signal?: AbortSignal,
): Promise<LisaEvaluation> {
  const detections = await detectLocalCandidates(imageData);
  const detectionSummary = formatDetectionSummary(detections, imageData.width, imageData.height);

  const content = await generateJSON(
    LOCAL_LISA_SYSTEM_PROMPT,
    `Image size: ${imageData.width}x${imageData.height}.\nReview these local candidate detections and decide what is truly identifying or readable. Return JSON only.\n\n${detectionSummary}`,
    signal,
  );

  const parsed = parseJSONResponse<LisaRawResponse>(content);
  return validateLisaResponse(parsed, detections);
}

export async function planWithLocalGemmaRalph(
  imageData: ImageData,
  evaluation: LisaEvaluation,
  signal?: AbortSignal,
): Promise<RalphPlan> {
  if (evaluation.visibleLeaks.length === 0 || evaluation.vaguenessScore >= 0.9) {
    return {
      redactions: [],
      explanation: "No additional local redactions needed.",
    };
  }

  const leakSummary = evaluation.visibleLeaks
    .map((leak) => {
      const region = leak.region
        ? ` at x:${leak.region.x}, y:${leak.region.y}, ${leak.region.width}x${leak.region.height}`
        : "";
      return `- ${leak.type}: ${leak.description}${region}`;
    })
    .join("\n");

  const content = await generateJSON(
    LOCAL_RALPH_SYSTEM_PROMPT,
    `Image size: ${imageData.width}x${imageData.height}. Privacy score: ${evaluation.vaguenessScore}.\nLisa reasoning: ${evaluation.reasoning}\nLeaks:\n${leakSummary}`,
    signal,
  );

  const parsed = parseJSONResponse<RalphRawResponse>(content);
  return validateRalphResponse(parsed, imageData.width, imageData.height);
}

function validateLisaResponse(raw: LisaRawResponse, detections: Detection[]): LisaEvaluation {
  if (typeof raw.vaguenessScore !== "number" || Number.isNaN(raw.vaguenessScore)) {
    throw new SOTAError("parse", "Local Lisa response missing vaguenessScore", false);
  }

  const validTypes = [
    "face",
    "text",
    "license_plate",
    "document",
    "other",
  ] as const;

  const visibleLeaks = (raw.visibleLeaks ?? []).map((leak) => {
      const normalizedType = validTypes.includes(leak.type as (typeof validTypes)[number])
        ? (leak.type as (typeof validTypes)[number])
        : "other";
      const region = leak.region
        ? {
            x: Number(leak.region.x) || 0,
            y: Number(leak.region.y) || 0,
            width: Number(leak.region.width) || 0,
            height: Number(leak.region.height) || 0,
          }
        : findRegionForLeak(normalizedType, String(leak.description || ""), detections);

      return {
        type: normalizedType,
        description: String(leak.description || "Unknown PII"),
        ...(region ? { region } : {}),
      };
    });

  const faceDetections = detections.filter((detection) => detection.type === "face");
  const hasFaceLeak = visibleLeaks.some((leak) => leak.type === "face");

  if (faceDetections.length > 0 && !hasFaceLeak) {
    visibleLeaks.push(
      ...faceDetections.map((detection, index) => ({
        type: "face" as const,
        description: `Visible face ${index + 1}`,
        region: {
          x: Math.round(detection.bbox.x),
          y: Math.round(detection.bbox.y),
          width: Math.round(detection.bbox.width),
          height: Math.round(detection.bbox.height),
        },
      })),
    );
  }

  const leakScoreFloor = visibleLeaks.length === 0
    ? 1
    : Math.max(0.15, 1 - visibleLeaks.length * 0.18);

  return {
    vaguenessScore: Math.max(leakScoreFloor, Math.max(0, Math.min(1, raw.vaguenessScore))),
    visibleLeaks,
    reasoning:
      typeof raw.reasoning === "string" ? raw.reasoning : "No reasoning provided",
  };
}

async function detectLocalCandidates(imageData: ImageData): Promise<Detection[]> {
  let faces: Detection[] = [];

  try {
    faces = await detectFaces(imageData);
  } catch (error) {
    throw new SOTAError(
      "unknown",
      error instanceof Error
        ? `Local face detection failed: ${error.message}`
        : "Local face detection failed.",
      true,
    );
  }

  const [text, documents] = await Promise.all([
    detectTextDetections(imageData).catch((error) => {
      console.warn("Local OCR candidate detection failed", error);
      return [];
    }),
    detectDocumentCandidates(imageData).catch((error) => {
      console.warn("Local document candidate detection failed", error);
      return [];
    }),
  ]);

  return [...faces, ...text, ...documents];
}

async function detectTextDetections(imageData: ImageData): Promise<Detection[]> {
  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker("eng", 1);
  }

  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create canvas for OCR");
  }

  ctx.putImageData(imageData, 0, 0);
  const result = await tesseractWorker.recognize(canvas.toDataURL("image/png"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const words = (result.data as any).words as
    | Array<{
        confidence: number;
        text: string;
        bbox: { x0: number; y0: number; x1: number; y1: number };
      }>
    | undefined;

  if (!words) return [];

  return words
    .filter(
      (word) =>
        word.confidence > 60 &&
        isSensitiveTextCandidate(word.text.trim()),
    )
    .map((word, index) => ({
      id: `local-text-${index}`,
      type: "text" as const,
      bbox: {
        x: word.bbox.x0,
        y: word.bbox.y0,
        width: word.bbox.x1 - word.bbox.x0,
        height: word.bbox.y1 - word.bbox.y0,
      },
      confidence: word.confidence / 100,
      selected: true,
      label: word.text,
    }));
}

async function detectDocumentCandidates(imageData: ImageData): Promise<Detection[]> {
  if (!objectDetector) {
    const detector = await pipeline("object-detection", "Xenova/detr-resnet-50");
    objectDetector = detector as unknown as DetectionPipeline;
  }

  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create canvas for object detection");
  }

  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("Could not convert canvas to blob"));
    }, "image/png");
  });

  const blobUrl = URL.createObjectURL(blob);

  try {
    const results = await objectDetector(blobUrl);

    return results
      .filter((result) => {
        const label = result.label.toLowerCase();
        return ["book", "laptop", "cell phone", "tv", "monitor"].includes(label) && result.score > 0.5;
      })
      .map((result, index) => ({
        id: `local-doc-${index}`,
        type: "document" as const,
        bbox: {
          x: result.box.xmin,
          y: result.box.ymin,
          width: result.box.xmax - result.box.xmin,
          height: result.box.ymax - result.box.ymin,
        },
        confidence: result.score,
        selected: true,
        label: result.label,
      }));
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function formatDetectionSummary(
  detections: Detection[],
  imageWidth: number,
  imageHeight: number,
): string {
  if (detections.length === 0) {
    return `No local candidate detections were found in this ${imageWidth}x${imageHeight} image.`;
  }

  const lines = detections.map((detection, index) => {
    const label = detection.label ? `, label: ${detection.label}` : "";
    return `${index + 1}. type: ${detection.type}, confidence: ${(detection.confidence * 100).toFixed(0)}%, bbox: x=${Math.round(detection.bbox.x)}, y=${Math.round(detection.bbox.y)}, w=${Math.round(detection.bbox.width)}, h=${Math.round(detection.bbox.height)}${label}`;
  });

  return `Candidate detections:\n${lines.join("\n")}`;
}

function isSensitiveTextCandidate(text: string): boolean {
  if (!text) return false;

  const trimmed = text.trim();
  if (trimmed.length < 3) return false;

  return SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function findRegionForLeak(
  type: LisaEvaluation["visibleLeaks"][number]["type"],
  description: string,
  detections: Detection[],
): LisaEvaluation["visibleLeaks"][number]["region"] | undefined {
  const normalizedDescription = description.toLowerCase();
  const match = detections.find((detection) => {
    if (type !== "other" && detection.type !== type) return false;
    if (!detection.label) return true;
    return normalizedDescription.includes(detection.label.toLowerCase());
  });

  return match
    ? {
        x: Math.round(match.bbox.x),
        y: Math.round(match.bbox.y),
        width: Math.round(match.bbox.width),
        height: Math.round(match.bbox.height),
      }
    : undefined;
}

function validateRalphResponse(
  raw: RalphRawResponse,
  imageWidth: number,
  imageHeight: number,
): RalphPlan {
  const validStyles = ["solid", "pixelate", "blur"] as const;

  const redactions = (raw.redactions ?? [])
    .map((redaction) => {
      const style = validStyles.includes(
        redaction.style as (typeof validStyles)[number],
      )
        ? (redaction.style as (typeof validStyles)[number])
        : "solid";

      let x = Math.round(Number(redaction.x) || 0);
      let y = Math.round(Number(redaction.y) || 0);
      let width = Math.round(Number(redaction.width) || 1);
      let height = Math.round(Number(redaction.height) || 1);

      x = Math.max(0, Math.min(imageWidth - 1, x));
      y = Math.max(0, Math.min(imageHeight - 1, y));
      width = Math.max(1, Math.min(imageWidth - x, width));
      height = Math.max(1, Math.min(imageHeight - y, height));

      return {
        style,
        x,
        y,
        width,
        height,
        intensity: Math.max(
          1,
          Math.min(100, Math.round(Number(redaction.intensity) || 70)),
        ),
        reason:
          typeof redaction.reason === "string"
            ? redaction.reason
            : "Redacting PII",
      };
    })
    .filter((redaction) => redaction.width > 0 && redaction.height > 0);

  return {
    redactions,
    explanation:
      typeof raw.explanation === "string"
        ? raw.explanation
        : "Local redaction plan generated",
  };
}
