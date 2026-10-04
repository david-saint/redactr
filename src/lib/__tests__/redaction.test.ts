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

import { replayCommands, appliesToFrame } from '../redaction';

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
