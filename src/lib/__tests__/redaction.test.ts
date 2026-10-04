// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

// Each redaction appends its region's x to a log in the image's first pixel row.
vi.mock('../wasm/redactor', () => ({
  applyRectRedaction: vi.fn((image: ImageData, x: number) => {
    const data = new Uint8ClampedArray(image.data);
    data[data.indexOf(0)] = x;
    return new ImageData(data, image.width, image.height);
  }),
  applyBrushRedaction: vi.fn((image: ImageData, points: number[]) => {
    const data = new Uint8ClampedArray(image.data);
    data[data.indexOf(0)] = points[0];
    return new ImageData(data, image.width, image.height);
  })
}));

import { replayCommands, appliesToFrame, placeOnFrame, commandBounds, TRACK_PADDING } from '../redaction';

const rect = (x: number, frames = null) => ({
  id: `r${x}`,
  type: 'rect',
  style: 'solid',
  region: { x, y: 0, width: 1, height: 1 },
  points: null,
  intensity: 50,
  color: '#000000',
  frames,
  timestamp: 0
});

const applied = (image: ImageData) => Array.from(image.data).filter((v) => v !== 0);

describe('appliesToFrame', () => {
  it('should apply redactions without a range to every frame', () => {
    expect(appliesToFrame(rect(1), 0)).toBe(true);
    expect(appliesToFrame({ ...rect(1), frames: undefined }, 99)).toBe(true);
  });

  it('should apply ranged redactions only inside their inclusive range', () => {
    const cmd = rect(1, { start: 2, end: 4 });
    expect([1, 2, 3, 4, 5].map((f) => appliesToFrame(cmd, f))).toEqual([
      false,
      true,
      true,
      true,
      false
    ]);
  });
});

describe('replayCommands', () => {
  const original = () => new ImageData(4, 1);
  const commands = [rect(1), rect(2, { start: 0, end: 0 }), rect(3, { start: 1, end: 2 })];

  it('should replay every command, in order, when no frame is given', () => {
    expect(applied(replayCommands(original(), commands))).toEqual([1, 2, 3]);
  });

  it('should skip commands outside the given frame', () => {
    expect(applied(replayCommands(original(), commands, 0))).toEqual([1, 2]);
    expect(applied(replayCommands(original(), commands, 2))).toEqual([1, 3]);
    expect(applied(replayCommands(original(), commands, 5))).toEqual([1]);
  });

  it('should never mutate the original', () => {
    const image = original();
    replayCommands(image, commands, 1);
    expect(applied(image)).toEqual([]);
  });
});

describe('tracked redactions', () => {
  const track = (boxes) => ({
    anchor: { x: 10, y: 20, width: 40, height: 10 },
    keyframes: [{ frame: 0, box: { x: 10, y: 20, width: 40, height: 10 } }],
    boxes,
    scores: boxes.map(() => 1)
  });
  const tracked = {
    ...rect(10),
    region: { x: 10, y: 20, width: 40, height: 10 },
    track: track([
      { x: 10, y: 20, width: 40, height: 10 },
      { x: 30, y: 5, width: 80, height: 20 },
      null
    ])
  };

  it('should only apply on frames with a box', () => {
    expect([0, 1, 2].map((f) => appliesToFrame(tracked, f))).toEqual([true, true, false]);
    expect(placeOnFrame(tracked, 2)).toBe(null);
  });

  it('should respect the frame range as well', () => {
    expect(appliesToFrame({ ...tracked, frames: { start: 1, end: 1 } }, 0)).toBe(false);
  });

  it('should move and scale a box onto each frame, with padding', () => {
    const p = TRACK_PADDING;
    expect(placeOnFrame(tracked, 0).region).toEqual({
      x: 10 - p,
      y: 20 - p,
      width: 40 + 2 * p,
      height: 10 + 2 * p
    });
    // Twice the size at (30, 5)
    expect(placeOnFrame(tracked, 1).region).toEqual({
      x: 30 - 2 * p,
      y: 5 - 2 * p,
      width: 80 + 4 * p,
      height: 20 + 4 * p
    });
  });

  it('should move and scale brush strokes with the box', () => {
    const brush = {
      ...tracked,
      type: 'brush',
      region: null,
      points: [10, 20, 50, 30],
      brushSize: 4
    };
    const placed = placeOnFrame(brush, 1);
    expect(placed.points).toEqual([30, 5, 110, 25]);
    expect(placed.brushSize).toBe(8 + TRACK_PADDING * 4);
  });

  it('should replay a tracked redaction where it sits on that frame', () => {
    const image = new ImageData(4, 1);
    const moved = { ...tracked, region: { x: 10, y: 20, width: 40, height: 10 } };
    // The mock records the x of each region applied.
    expect(applied(replayCommands(image, [moved], 1))).toEqual([30 - 2 * TRACK_PADDING]);
    expect(applied(replayCommands(image, [moved], 2))).toEqual([]);
  });

  it('should bound brush strokes including their width', () => {
    expect(commandBounds({ ...rect(1), region: null, points: [10, 10, 20, 30], brushSize: 6 })).toEqual({
      x: 7,
      y: 7,
      width: 16,
      height: 26
    });
  });
});
