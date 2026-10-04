// @ts-nocheck
import { describe, it, expect, vi, beforeAll } from 'vitest';

const wasm = vi.hoisted(() => ({
  solid_fill: vi.fn(),
  pixelate: vi.fn(),
  gaussian_blur: vi.fn()
}));

vi.mock('../pkg/redactr_wasm', () => ({
  default: async () => {},
  ...wasm
}));

import { applyRectRedaction, initWasm } from '../redactor';

/** The x, y, width, height the WASM call received. */
const rectArgs = (fn) => fn.mock.calls.at(-1).slice(3, 7);

describe('applyRectRedaction coordinates', () => {
  const image = () => new ImageData(100, 50);
  const solid = { style: 'solid', intensity: 50, color: '#000000' };

  beforeAll(async () => {
    await initWasm();
  });

  it('should clip boxes that start off the left or top edge', () => {
    // Part-visible: must not be skipped (negative values would wrap around
    // in the unsigned WASM parameters).
    applyRectRedaction(image(), -30, -5, 50, 20, solid);
    expect(rectArgs(wasm.solid_fill)).toEqual([0, 0, 20, 15]);
  });

  it('should clip boxes that run off the right or bottom edge', () => {
    applyRectRedaction(image(), 90, 40, 50, 50, { ...solid, style: 'pixelate' });
    expect(rectArgs(wasm.pixelate)).toEqual([90, 40, 10, 10]);
  });

  it('should cover every pixel a fractional box touches', () => {
    applyRectRedaction(image(), 10.6, 4.2, 5.1, 2.1, { ...solid, style: 'blur' });
    // 10.6..15.7 touches pixels 10-15; 4.2..6.3 touches rows 4-6.
    expect(rectArgs(wasm.gaussian_blur)).toEqual([10, 4, 6, 3]);
  });

  it('should leave the image as it was for boxes entirely outside', () => {
    wasm.solid_fill.mockClear();
    const out = applyRectRedaction(image(), -60, 10, 50, 10, solid);
    expect(wasm.solid_fill).not.toHaveBeenCalled();
    expect(out.width).toBe(100);
  });
});
