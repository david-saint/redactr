export type DetectionType = "face" | "text" | "license_plate" | "document";

export type DetectionBackend = "webgpu" | "webgl" | "cpu";

export interface Detection {
  id: string;
  type: DetectionType;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  selected: boolean;
  label?: string; // For text OCR or document type
}

// Messages sent TO the worker
export interface DetectMessage {
  type: "detect";
  imageData: ImageData;
  enabledTypes: DetectionType[];
  requestId: string;
  isFirstRun: boolean;
}

export interface CancelMessage {
  type: "cancel";
  requestId: string;
}

export type WorkerRequest = DetectMessage | CancelMessage;

// Messages sent FROM the worker
export type WorkerResponse =
  | { type: "download_progress"; progress: number; stage: string }
  | { type: "download_complete" }
  | { type: "progress"; progress: number; stage: string }
  | { type: "results"; detections: Detection[] }
  | { type: "complete" }
  | { type: "error"; error: string }
  | { type: "model_loaded"; modelType: DetectionType }
  | { type: "run_text_detection" }
  | { type: "run_mediapipe_face_detection" }
  | { type: "cancelled" };
