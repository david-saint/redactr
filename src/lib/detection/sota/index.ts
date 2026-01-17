// Ralph-Lisa Loop Orchestrator
// Manages the iterative process of evaluating and redacting PII

import { get } from "svelte/store";
import { sotaStore } from "../../stores/sota";
import { imageStore } from "../../stores/image";
import { historyStore } from "../../stores/history";
import { applyRectRedaction, type RedactionOptions } from "../../wasm/redactor";
import { evaluateWithLisa } from "./lisa";
import { planWithRalph } from "./ralph";
import { SOTAError, type LoopIteration, type RalphRedaction } from "./types";

// AbortController for cancellation
let currentAbortController: AbortController | null = null;

/**
 * Start the Ralph-Lisa loop
 * This will iteratively:
 * 1. Have Lisa evaluate the current image
 * 2. If score meets target, stop
 * 3. Have Ralph plan redactions based on Lisa's feedback
 * 4. Apply redactions via WASM
 * 5. Repeat until target score or max steps reached
 */
export async function startRalphLisaLoop(): Promise<void> {
  const state = sotaStore.getState();

  if (!state.apiKey) {
    sotaStore.setError("No API key configured");
    return;
  }

  const imageState = get(imageStore);
  if (!imageState.current) {
    sotaStore.setError("No image loaded");
    return;
  }

  // Create abort controller for this run
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  // Start the loop
  sotaStore.startLoop();

  try {
    for (let step = 1; step <= state.maxSteps; step++) {
      if (signal.aborted) {
        sotaStore.complete("cancelled");
        return;
      }

      sotaStore.setCurrentStep(step);

      // Get current image state (may have been modified by previous iterations)
      const currentImage = get(imageStore).current;
      if (!currentImage) {
        throw new SOTAError("unknown", "Image was cleared during loop", false);
      }

      // Step 1: Lisa evaluates
      sotaStore.updateStatus("evaluating");
      const evaluation = await evaluateWithLisa(
        state.apiKey!,
        currentImage,
        signal,
      );

      sotaStore.setCurrentScore(evaluation.vaguenessScore);

      // Check if target reached
      if (evaluation.vaguenessScore >= state.targetScore) {
        const iteration: LoopIteration = {
          step,
          evaluation,
          plan: null,
          appliedRedactions: [],
          timestamp: Date.now(),
        };
        sotaStore.addIteration(iteration);
        sotaStore.complete("completed");
        return;
      }

      if (signal.aborted) {
        sotaStore.complete("cancelled");
        return;
      }

      // Step 2: Ralph plans redactions
      sotaStore.updateStatus("planning");
      const plan = await planWithRalph(
        state.apiKey!,
        currentImage,
        evaluation,
        signal,
      );

      if (signal.aborted) {
        sotaStore.complete("cancelled");
        return;
      }

      // Step 3: Apply redactions
      sotaStore.updateStatus("redacting");
      const appliedRedactions = await applyRedactions(plan.redactions);

      // Record this iteration
      const iteration: LoopIteration = {
        step,
        evaluation,
        plan,
        appliedRedactions,
        timestamp: Date.now(),
      };
      sotaStore.addIteration(iteration);

      // If no redactions were applied, we might be stuck
      if (appliedRedactions.length === 0 && step > 1) {
        // Give it one more chance, but if still no progress, stop
        console.warn("No redactions applied in step", step);
      }
    }

    // If we get here, we hit max steps without reaching target
    sotaStore.complete("max_steps");
  } catch (err) {
    if (err instanceof SOTAError) {
      if (err.type === "auth") {
        // Clear invalid API key
        sotaStore.clearApiKey();
      }
      sotaStore.setError(err.message);
    } else if (err instanceof Error) {
      if (err.name === "AbortError") {
        sotaStore.complete("cancelled");
      } else {
        sotaStore.setError(err.message);
      }
    } else {
      sotaStore.setError("An unknown error occurred");
    }
  } finally {
    currentAbortController = null;
  }
}

/**
 * Cancel the running loop
 */
export function cancelRalphLisaLoop(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

/**
 * Apply redactions using WASM and push to history
 */
async function applyRedactions(
  redactions: RalphRedaction[],
): Promise<RalphRedaction[]> {
  if (redactions.length === 0) return [];

  const applied: RalphRedaction[] = [];
  let currentImage = get(imageStore).current;

  if (!currentImage) return [];

  for (const redaction of redactions) {
    try {
      const options: RedactionOptions = {
        style: redaction.style,
        intensity: redaction.intensity,
        color: "#000000",
      };

      // Apply redaction
      const newImageData = applyRectRedaction(
        currentImage,
        redaction.x,
        redaction.y,
        redaction.width,
        redaction.height,
        options,
      );

      // Update image store
      imageStore.updateCurrent(newImageData);
      currentImage = newImageData;

      // Push to history for undo support
      historyStore.push({
        type: "rect",
        style: redaction.style,
        region: {
          x: redaction.x,
          y: redaction.y,
          width: redaction.width,
          height: redaction.height,
        },
        points: null,
        intensity: redaction.intensity,
        color: "#000000",
      });

      applied.push(redaction);
    } catch (err) {
      console.error("Failed to apply redaction:", err);
      // Continue with other redactions
    }
  }

  return applied;
}

// Re-export types and functions for convenience
export { SOTAError } from "./types";
export type {
  LisaEvaluation,
  RalphPlan,
  RalphRedaction,
  LoopIteration,
} from "./types";
