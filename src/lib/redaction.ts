import type { Box, FrameRange, RedactionCommand } from './stores/history';
import { applyRectRedaction, applyBrushRedaction } from './wasm/redactor';

/**
 * Extra coverage around a tracked redaction, in pixels at the size it was
 * drawn, since a tracked box can be off by a pixel or two.
 */
export const TRACK_PADDING = 3;

/** Whether a redaction applies to the given 0-based animation frame. */
export function appliesToFrame(command: RedactionCommand, frame: number): boolean {
  const range = command.frames;
  if (range && (frame < range.start || frame > range.end)) return false;
  return !isTracked(command) || !!command.track!.boxes[frame];
}

/** Whether a redaction has tracking results to place it by. */
export function isTracked(command: RedactionCommand): boolean {
  return !!command.track && command.track.boxes.length > 0;
}

/** The first and last frames a tracked redaction has a box on. */
export function trackedSpan(command: RedactionCommand): FrameRange | null {
  const boxes = command.track?.boxes ?? [];
  const first = boxes.findIndex(Boolean);
  if (first < 0) return null;
  let last = boxes.length - 1;
  while (!boxes[last]) last--;
  return { start: first, end: last };
}

/** The box around a redaction's shape: its region, or its brush stroke. */
export function commandBounds(cmd: RedactionCommand): Box | null {
  if (cmd.region) return cmd.region;
  if (!cmd.points || cmd.points.length < 2) return null;
  const pad = (cmd.brushSize || 20) / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < cmd.points.length; i += 2) {
    minX = Math.min(minX, cmd.points[i]);
    maxX = Math.max(maxX, cmd.points[i]);
    minY = Math.min(minY, cmd.points[i + 1]);
    maxY = Math.max(maxY, cmd.points[i + 1]);
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2
  };
}

/**
 * The redaction as drawn on an animation frame: null when it doesn't apply
 * there, moved and scaled (with padding) when it follows moving content.
 */
export function placeOnFrame(
  cmd: RedactionCommand,
  frame: number
): RedactionCommand | null {
  if (!appliesToFrame(cmd, frame)) return null;
  // Not tracked (yet, or tracking failed): it stays where it was drawn.
  if (!isTracked(cmd)) return cmd;
  const track = cmd.track!;

  const box = track.boxes[frame]!;
  const { anchor } = track;
  const sx = box.width / anchor.width;
  const sy = box.height / anchor.height;
  const mapX = (x: number) => box.x + (x - anchor.x) * sx;
  const mapY = (y: number) => box.y + (y - anchor.y) * sy;
  // Tracking errors are in frame pixels, so the padding never drops below
  // TRACK_PADDING frame pixels when the content has shrunk.
  const padX = TRACK_PADDING * Math.max(sx, 1);
  const padY = TRACK_PADDING * Math.max(sy, 1);

  if (cmd.region) {
    const { x, y, width, height } = cmd.region;
    return {
      ...cmd,
      region: {
        x: mapX(x) - padX,
        y: mapY(y) - padY,
        width: width * sx + padX * 2,
        height: height * sy + padY * 2
      }
    };
  }
  return {
    ...cmd,
    points: cmd.points?.map((v, i) => (i % 2 === 0 ? mapX(v) : mapY(v))) ?? null,
    brushSize: (cmd.brushSize || 20) * Math.max(sx, sy) + TRACK_PADDING * 2 * Math.max(sx, sy, 1)
  };
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

  for (const command of commands) {
    const cmd = frame === undefined ? command : placeOnFrame(command, frame);
    if (!cmd) continue;

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
