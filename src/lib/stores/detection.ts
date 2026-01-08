import { writable, derived } from "svelte/store";
import type {
  Detection,
  DetectionType,
  DetectionBackend,
} from "../detection/types";

export type { Detection, DetectionType, DetectionBackend };

export interface DetectionState {
  isDetecting: boolean;
  isDownloading: boolean;
  downloadProgress: number; // 0-100 for model download
  progress: number; // 0-100 for detection
  currentStage: string;
  results: Detection[];
  error: string | null;
  modelsLoaded: {
    face: boolean;
    text: boolean;
    license_plate: boolean;
    document: boolean;
  };
  hasUserConsent: boolean; // User has agreed to download models
  enabledTypes: DetectionType[];
  backend: DetectionBackend | null;
  isPanelOpen: boolean;
}

const initialState: DetectionState = {
  isDetecting: false,
  isDownloading: false,
  downloadProgress: 0,
  progress: 0,
  currentStage: "",
  results: [],
  error: null,
  modelsLoaded: {
    face: false,
    text: false,
    license_plate: false,
    document: false,
  },
  hasUserConsent: false,
  enabledTypes: ["face", "text", "license_plate", "document"],
  backend: null,
  isPanelOpen: false,
};

function createDetectionStore() {
  const { subscribe, set, update } = writable<DetectionState>(initialState);

  return {
    subscribe,

    // Panel visibility
    openPanel: () => update((s) => ({ ...s, isPanelOpen: true })),
    closePanel: () => update((s) => ({ ...s, isPanelOpen: false })),
    togglePanel: () => update((s) => ({ ...s, isPanelOpen: !s.isPanelOpen })),

    // Detection type toggles
    toggleType: (type: DetectionType) =>
      update((s) => ({
        ...s,
        enabledTypes: s.enabledTypes.includes(type)
          ? s.enabledTypes.filter((t) => t !== type)
          : [...s.enabledTypes, type],
      })),
    setEnabledTypes: (types: DetectionType[]) =>
      update((s) => ({ ...s, enabledTypes: types })),

    // User consent for model download
    giveConsent: () => update((s) => ({ ...s, hasUserConsent: true })),
    revokeConsent: () => update((s) => ({ ...s, hasUserConsent: false })),

    // Model download progress
    startDownload: () =>
      update((s) => ({
        ...s,
        isDownloading: true,
        downloadProgress: 0,
        currentStage: "Downloading AI models...",
      })),

    updateDownloadProgress: (progress: number, stage: string) =>
      update((s) => ({
        ...s,
        downloadProgress: progress,
        currentStage: stage,
      })),

    finishDownload: () =>
      update((s) => ({
        ...s,
        isDownloading: false,
        downloadProgress: 100,
      })),

    // Detection progress
    startDetection: () =>
      update((s) => ({
        ...s,
        isDetecting: true,
        progress: 0,
        currentStage: "Initializing...",
        error: null,
        results: [],
      })),

    updateProgress: (progress: number, stage: string) =>
      update((s) => ({
        ...s,
        progress,
        currentStage: stage,
      })),

    addResults: (detections: Detection[]) =>
      update((s) => ({
        ...s,
        results: [...s.results, ...detections],
      })),

    finishDetection: () =>
      update((s) => ({
        ...s,
        isDetecting: false,
        progress: 100,
        currentStage: "Complete",
      })),

    setError: (error: string) =>
      update((s) => ({
        ...s,
        isDetecting: false,
        error,
        currentStage: "Error",
      })),

    // Model loading status
    setModelLoaded: (type: DetectionType, loaded: boolean) =>
      update((s) => ({
        ...s,
        modelsLoaded: { ...s.modelsLoaded, [type]: loaded },
      })),

    // Backend detection
    setBackend: (backend: DetectionBackend) =>
      update((s) => ({ ...s, backend })),

    // Result selection
    toggleSelection: (id: string) =>
      update((s) => ({
        ...s,
        results: s.results.map((r) =>
          r.id === id ? { ...r, selected: !r.selected } : r
        ),
      })),

    selectAll: () =>
      update((s) => ({
        ...s,
        results: s.results.map((r) => ({ ...r, selected: true })),
      })),

    deselectAll: () =>
      update((s) => ({
        ...s,
        results: s.results.map((r) => ({ ...r, selected: false })),
      })),

    selectByType: (type: DetectionType) =>
      update((s) => ({
        ...s,
        results: s.results.map((r) =>
          r.type === type ? { ...r, selected: true } : r
        ),
      })),

    // Clear results
    clearResults: () =>
      update((s) => ({
        ...s,
        results: [],
        progress: 0,
        downloadProgress: 0,
        isDetecting: false,
        isDownloading: false,
        currentStage: "",
        error: null,
      })),

    // Reset to initial state
    reset: () => set(initialState),
  };
}

export const detectionStore = createDetectionStore();

// Derived stores for convenience
export const selectedDetections = derived(detectionStore, ($store) =>
  $store.results.filter((r) => r.selected)
);

export const detectionsByType = derived(detectionStore, ($store) => {
  const byType: Record<DetectionType, Detection[]> = {
    face: [],
    text: [],
    license_plate: [],
    document: [],
  };
  for (const detection of $store.results) {
    byType[detection.type].push(detection);
  }
  return byType;
});

export const detectionCounts = derived(detectionsByType, ($byType) => ({
  face: $byType.face.length,
  text: $byType.text.length,
  license_plate: $byType.license_plate.length,
  document: $byType.document.length,
  total:
    $byType.face.length +
    $byType.text.length +
    $byType.license_plate.length +
    $byType.document.length,
}));

// Check if models need to be downloaded for enabled types
export const needsModelDownload = derived(detectionStore, ($store) => {
  for (const type of $store.enabledTypes) {
    if (!$store.modelsLoaded[type]) {
      return true;
    }
  }
  return false;
});

// Estimate model download size based on enabled types (in MB)
// Estimate model download size based on enabled types (in MB)
export const estimatedDownloadSize = derived(detectionStore, ($store) => {
  let size = 0;

  // Independent models
  if ($store.enabledTypes.includes("face") && !$store.modelsLoaded.face) {
    size += 0.3; // MediaPipe Face Detector
  }

  if ($store.enabledTypes.includes("text") && !$store.modelsLoaded.text) {
    size += 5; // Tesseract
  }

  // Shared model: DETR-ResNet-50 (used for both document and vehicle/plate detection)
  const usesSharedModel =
    $store.enabledTypes.includes("license_plate") ||
    $store.enabledTypes.includes("document");

  const sharedModelLoaded =
    $store.modelsLoaded.license_plate || $store.modelsLoaded.document;

  if (usesSharedModel && !sharedModelLoaded) {
    size += 42; // DETR-ResNet-50 (Quantized) ~42MB
  }

  return size;
});
