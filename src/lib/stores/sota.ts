import { writable, derived, get } from "svelte/store";
import type {
  SOTAState,
  LoopStatus,
  LoopIteration,
} from "../detection/sota/types";

const SESSION_STORAGE_KEY = "redactr_openrouter_api_key";

const initialState: SOTAState = {
  apiKey: null,
  targetScore: 0.7,
  maxSteps: 5,
  isRunning: false,
  status: "idle",
  currentStep: 0,
  currentScore: null,
  iterations: [],
  error: null,
};

function loadApiKeyFromSession(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(SESSION_STORAGE_KEY);
}

function saveApiKeyToSession(key: string | null): void {
  if (typeof sessionStorage === "undefined") return;
  if (key) {
    sessionStorage.setItem(SESSION_STORAGE_KEY, key);
  } else {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

function createSOTAStore() {
  // Initialize with API key from session storage if available
  const initialWithKey: SOTAState = {
    ...initialState,
    apiKey: loadApiKeyFromSession(),
  };

  const { subscribe, set, update } = writable<SOTAState>(initialWithKey);

  return {
    subscribe,

    setApiKey: (key: string) => {
      saveApiKeyToSession(key);
      update((state) => ({
        ...state,
        apiKey: key,
        error: null,
      }));
    },

    clearApiKey: () => {
      saveApiKeyToSession(null);
      update((state) => ({
        ...state,
        apiKey: null,
        isRunning: false,
        status: "idle",
      }));
    },

    setTargetScore: (score: number) => {
      update((state) => ({
        ...state,
        targetScore: Math.max(0, Math.min(1, score)),
      }));
    },

    setMaxSteps: (steps: number) => {
      update((state) => ({
        ...state,
        maxSteps: Math.max(1, Math.min(10, steps)),
      }));
    },

    startLoop: () => {
      update((state) => ({
        ...state,
        isRunning: true,
        status: "evaluating",
        currentStep: 0,
        currentScore: null,
        iterations: [],
        error: null,
      }));
    },

    updateStatus: (status: LoopStatus) => {
      update((state) => ({
        ...state,
        status,
      }));
    },

    setCurrentStep: (step: number) => {
      update((state) => ({
        ...state,
        currentStep: step,
      }));
    },

    setCurrentScore: (score: number) => {
      update((state) => ({
        ...state,
        currentScore: score,
      }));
    },

    addIteration: (iteration: LoopIteration) => {
      update((state) => ({
        ...state,
        iterations: [...state.iterations, iteration],
      }));
    },

    setError: (error: string) => {
      update((state) => ({
        ...state,
        isRunning: false,
        status: "error",
        error,
      }));
    },

    complete: (status: "completed" | "max_steps" | "cancelled") => {
      update((state) => ({
        ...state,
        isRunning: false,
        status,
      }));
    },

    reset: () => {
      const apiKey = loadApiKeyFromSession();
      set({
        ...initialState,
        apiKey,
      });
    },

    getState: () => get({ subscribe }),
  };
}

export const sotaStore = createSOTAStore();

// Derived stores for UI convenience
export const hasApiKey = derived(
  sotaStore,
  ($sota) => $sota.apiKey !== null && $sota.apiKey.length > 0,
);
export const canStartLoop = derived(
  sotaStore,
  ($sota) =>
    $sota.apiKey !== null && $sota.apiKey.length > 0 && !$sota.isRunning,
);
export const loopProgress = derived(sotaStore, ($sota) => ({
  step: $sota.currentStep,
  maxSteps: $sota.maxSteps,
  score: $sota.currentScore,
  targetScore: $sota.targetScore,
  status: $sota.status,
}));
