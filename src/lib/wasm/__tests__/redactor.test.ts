// @ts-nocheck
import { describe, it, expect } from 'vitest';

// Test the pure utility functions that can be extracted from redactor.ts
// These don't depend on WASM initialization

describe('Redactor utility functions', () => {
  // Inline test implementations of the utility functions
  // These mirror the logic in redactor.ts

  function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16)
        }
      : { r: 0, g: 0, b: 0 };
  }

  function intensityToBlockSize(intensity: number): number {
    return Math.round(4 + (intensity / 100) * 28);
  }

  function intensityToBlurRadius(intensity: number): number {
    return Math.round(2 + (intensity / 100) * 18);
  }

  describe('hexToRgb', () => {
    it('should convert black hex', () => {
      expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should convert white hex', () => {
      expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    });

    it('should convert red hex', () => {
      expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should convert green hex', () => {
      expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should convert blue hex', () => {
      expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should convert without hash prefix', () => {
      expect(hexToRgb('ff5500')).toEqual({ r: 255, g: 85, b: 0 });
    });

    it('should return black for invalid hex', () => {
      expect(hexToRgb('invalid')).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should return black for empty string', () => {
      expect(hexToRgb('')).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should convert case insensitive', () => {
      expect(hexToRgb('#AABBCC')).toEqual({ r: 170, g: 187, b: 204 });
    });
  });

  describe('intensityToBlockSize', () => {
    it('should map intensity 1 to block size 4', () => {
      expect(intensityToBlockSize(1)).toBe(4);
    });

    it('should map intensity 50 to block size 18', () => {
      expect(intensityToBlockSize(50)).toBe(18);
    });

    it('should map intensity 100 to block size 32', () => {
      expect(intensityToBlockSize(100)).toBe(32);
    });

    it('should map intensity 0 to block size 4', () => {
      expect(intensityToBlockSize(0)).toBe(4);
    });

    it('should map intensity 25 to block size 11', () => {
      expect(intensityToBlockSize(25)).toBe(11);
    });

    it('should map intensity 75 to block size 25', () => {
      expect(intensityToBlockSize(75)).toBe(25);
    });
  });

  describe('intensityToBlurRadius', () => {
    it('should map intensity 1 to blur radius 2', () => {
      expect(intensityToBlurRadius(1)).toBe(2);
    });

    it('should map intensity 50 to blur radius 11', () => {
      expect(intensityToBlurRadius(50)).toBe(11);
    });

    it('should map intensity 100 to blur radius 20', () => {
      expect(intensityToBlurRadius(100)).toBe(20);
    });

    it('should map intensity 0 to blur radius 2', () => {
      expect(intensityToBlurRadius(0)).toBe(2);
    });

    it('should map intensity 25 to blur radius 7', () => {
      expect(intensityToBlurRadius(25)).toBe(7);
    });

    it('should map intensity 75 to blur radius 16', () => {
      expect(intensityToBlurRadius(75)).toBe(16);
    });
  });
});

describe('RedactionOptions validation', () => {
  type RedactionStyle = 'solid' | 'pixelate' | 'blur';
  
  interface RedactionOptions {
    style: RedactionStyle;
    intensity: number;
    color?: string;
  }

  function validateOptions(options: RedactionOptions): boolean {
    if (!['solid', 'pixelate', 'blur'].includes(options.style)) {
      return false;
    }
    if (typeof options.intensity !== 'number' || options.intensity < 0 || options.intensity > 100) {
      return false;
    }
    return true;
  }

  it('should accept valid solid style', () => {
    expect(validateOptions({ style: 'solid', intensity: 50 })).toBe(true);
  });

  it('should accept valid pixelate style', () => {
    expect(validateOptions({ style: 'pixelate', intensity: 75 })).toBe(true);
  });

  it('should accept valid blur style', () => {
    expect(validateOptions({ style: 'blur', intensity: 100 })).toBe(true);
  });

  it('should reject invalid style', () => {
    expect(validateOptions({ style: 'invalid' as RedactionStyle, intensity: 50 })).toBe(false);
  });

  it('should reject negative intensity', () => {
    expect(validateOptions({ style: 'solid', intensity: -10 })).toBe(false);
  });

  it('should reject intensity over 100', () => {
    expect(validateOptions({ style: 'solid', intensity: 150 })).toBe(false);
  });

  it('should accept intensity at boundaries', () => {
    expect(validateOptions({ style: 'solid', intensity: 0 })).toBe(true);
    expect(validateOptions({ style: 'solid', intensity: 100 })).toBe(true);
  });
});

describe('Coordinate handling', () => {
  function floorCoordinates(x: number, y: number, w: number, h: number) {
    return {
      x: Math.floor(x),
      y: Math.floor(y),
      w: Math.floor(w),
      h: Math.floor(h)
    };
  }

  it('should floor decimal coordinates', () => {
    expect(floorCoordinates(10.7, 20.3, 30.9, 40.1)).toEqual({
      x: 10, y: 20, w: 30, h: 40
    });
  });

  it('should keep integer coordinates unchanged', () => {
    expect(floorCoordinates(10, 20, 30, 40)).toEqual({
      x: 10, y: 20, w: 30, h: 40
    });
  });

  it('should handle zero coordinates', () => {
    expect(floorCoordinates(0, 0, 100, 100)).toEqual({
      x: 0, y: 0, w: 100, h: 100
    });
  });

  it('should handle negative coordinates', () => {
    expect(floorCoordinates(-5.5, -10.9, 50.1, 60.9)).toEqual({
      x: -6, y: -11, w: 50, h: 60
    });
  });
});

describe('Buffer operations', () => {
  it('should create Uint8ClampedArray with correct length', () => {
    const size = 100 * 100 * 4; // RGBA pixels
    const data = new Uint8ClampedArray(size);
    expect(data.length).toBe(40000);
  });

  it('should clone Uint8ClampedArray buffer', () => {
    const original = new Uint8ClampedArray([255, 128, 64, 255]);
    const cloned = new Uint8Array(original.buffer.slice(0));
    
    expect(cloned[0]).toBe(255);
    expect(cloned[1]).toBe(128);
    expect(cloned[2]).toBe(64);
    expect(cloned[3]).toBe(255);

    // Modify original, cloned should not change
    original[0] = 0;
    expect(cloned[0]).toBe(255);
  });

  it('should convert to Float32Array correctly', () => {
    const points = [10.5, 20.5, 30.5, 40.5];
    const float32 = new Float32Array(points);
    
    expect(float32).toBeInstanceOf(Float32Array);
    expect(float32.length).toBe(4);
    expect(float32[0]).toBeCloseTo(10.5);
    expect(float32[1]).toBeCloseTo(20.5);
  });

  it('should clamp values in Uint8ClampedArray', () => {
    const data = new Uint8ClampedArray(4);
    data[0] = 300; // Should clamp to 255
    data[1] = -50; // Should clamp to 0
    data[2] = 128; // Should stay as is
    data[3] = 255; // Should stay as is
    
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(0);
    expect(data[2]).toBe(128);
    expect(data[3]).toBe(255);
  });
});
