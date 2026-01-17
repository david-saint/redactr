// Type definitions for Ralph-Lisa Loop

import type { RedactionStyle } from "../../stores/settings";

/** Result of Lisa evaluating an image for privacy/vagueness */
export interface LisaEvaluation {
  /** 0.0 = all PII visible, 1.0 = fully private */
  vaguenessScore: number;
  /** Regions where identifiable info is still visible */
  visibleLeaks: VisibleLeak[];
  /** Lisa's reasoning about what PII remains */
  reasoning: string;
}

export interface VisibleLeak {
  type: "face" | "text" | "license_plate" | "document" | "other";
  description: string;
  /** Approximate bounding box if detectable */
  region?: BoundingBox;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single redaction operation planned by Ralph */
export interface RalphRedaction {
  style: RedactionStyle;
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
  /** Why Ralph chose to redact this region */
  reason: string;
}

/** Ralph's complete redaction plan for one iteration */
export interface RalphPlan {
  redactions: RalphRedaction[];
  /** Ralph's explanation of the overall plan */
  explanation: string;
}

/** Record of a single loop iteration */
export interface LoopIteration {
  step: number;
  evaluation: LisaEvaluation;
  plan: RalphPlan | null;
  appliedRedactions: RalphRedaction[];
  timestamp: number;
}

/** Possible loop statuses */
export type LoopStatus =
  | "idle"
  | "evaluating" // Lisa is analyzing the image
  | "planning" // Ralph is planning redactions
  | "redacting" // WASM is applying redactions
  | "completed" // Target score reached
  | "max_steps" // Max iterations reached
  | "cancelled" // User cancelled
  | "error"; // Something went wrong

/** SOTA store state */
export interface SOTAState {
  apiKey: string | null;
  targetScore: number; // 0.0-1.0, default 0.7
  maxSteps: number; // default 5
  isRunning: boolean;
  status: LoopStatus;
  currentStep: number;
  currentScore: number | null;
  iterations: LoopIteration[];
  error: string | null;
}

/** Error types from API calls */
export type APIErrorType =
  | "auth" // 401 - invalid API key
  | "rate_limit" // 429 - too many requests
  | "server" // 5xx - server errors
  | "network" // fetch failed
  | "parse" // couldn't parse response
  | "unknown";

export class SOTAError extends Error {
  constructor(
    public type: APIErrorType,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "SOTAError";
  }
}
