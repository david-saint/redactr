import type { RedactionCommand } from './stores/history';
import { applyRectRedaction, applyBrushRedaction } from './wasm/redactor';

/**
 * Rebuild a redacted image by replaying commands on a copy of the original.
 * The original ImageData is never mutated.
 */
export function replayCommands(
  original: ImageData,
  commands: RedactionCommand[]
): ImageData {
  let currentData = new ImageData(
    new Uint8ClampedArray(original.data),
    original.width,
    original.height
  );

  for (const cmd of commands) {
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
