import type { RedactionCommand } from './stores/history';
import { applyRectRedaction, applyBrushRedaction } from './wasm/redactor';

/** Whether a redaction applies to the given 0-based animation frame. */
export function appliesToFrame(command: RedactionCommand, frame: number): boolean {
  const range = command.frames;
  return !range || (frame >= range.start && frame <= range.end);
}

/**
 * Rebuild a redacted image by replaying commands on a copy of the original.
 * The original ImageData is never mutated. For an animation frame, pass its
 * index so redactions limited to other frames are skipped.
 */
export function replayCommands(
  original: ImageData,
  commands: RedactionCommand[],
  frame?: number
): ImageData {
  let currentData = new ImageData(
    new Uint8ClampedArray(original.data),
    original.width,
    original.height
  );

  for (const cmd of commands) {
    if (frame !== undefined && !appliesToFrame(cmd, frame)) continue;

    const options = {
      style: cmd.style,
      intensity: cmd.intensity,
      color: cmd.color
    };

    if (cmd.type === 'rect' && cmd.region) {
      currentData = applyRectRedaction(
        currentData,
        cmd.region.x,
        cmd.region.y,
        cmd.region.width,
        cmd.region.height,
        options
      );
    } else if (cmd.type === 'brush' && cmd.points) {
      currentData = applyBrushRedaction(
        currentData,
        cmd.points,
        cmd.brushSize || 20,
        options
      );
    }
  }

  return currentData;
}
