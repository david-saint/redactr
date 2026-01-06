// TypeScript wrapper for WASM redaction functions
// The actual WASM module will be at ./pkg after running wasm-pack

let wasmModule: typeof import('./pkg/redactr_wasm') | null = null;

// Auto-initialize WASM when module is imported
const initPromise: Promise<void> = (async () => {
  try {
    const wasm = await import('./pkg/redactr_wasm');
    await wasm.default();
    wasmModule = wasm;
    console.log('WASM module initialized successfully');
  } catch (e) {
    console.error('Failed to load WASM module:', e);
    throw e;
  }
})();

// Export the init promise so callers can wait for it if needed
export async function initWasm(): Promise<void> {
  return initPromise;
}

// Export a ready promise for components that need to wait
export const wasmReady = initPromise;

export function isWasmReady(): boolean {
  return wasmModule !== null;
}

export interface RedactionOptions {
  style: 'solid' | 'pixelate' | 'blur';
  intensity: number; // 1-100
  color?: string; // For solid fill (hex)
}

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
  // Map 1-100 to 4-32 block size
  return Math.round(4 + (intensity / 100) * 28);
}

function intensityToBlurRadius(intensity: number): number {
  // Map 1-100 to 2-20 blur radius
  return Math.round(2 + (intensity / 100) * 18);
}

export function applyRectRedaction(
  imageData: ImageData,
  x: number,
  y: number,
  width: number,
  height: number,
  options: RedactionOptions
): ImageData {
  if (!wasmModule) {
    throw new Error('WASM module not initialized');
  }

  // Clone the image data - cast to Uint8Array for WASM compatibility
  const data = new Uint8Array(imageData.data.buffer.slice(0));

  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iw = Math.floor(width);
  const ih = Math.floor(height);

  switch (options.style) {
    case 'solid': {
      const rgb = hexToRgb(options.color || '#000000');
      wasmModule.solid_fill(
        data,
        imageData.width,
        imageData.height,
        ix,
        iy,
        iw,
        ih,
        rgb.r,
        rgb.g,
        rgb.b
      );
      break;
    }
    case 'pixelate': {
      const blockSize = intensityToBlockSize(options.intensity);
      wasmModule.pixelate(data, imageData.width, imageData.height, ix, iy, iw, ih, blockSize);
      break;
    }
    case 'blur': {
      const radius = intensityToBlurRadius(options.intensity);
      wasmModule.gaussian_blur(data, imageData.width, imageData.height, ix, iy, iw, ih, radius);
      break;
    }
  }

  return new ImageData(new Uint8ClampedArray(data.buffer), imageData.width, imageData.height);
}

export function applyBrushRedaction(
  imageData: ImageData,
  points: number[],
  brushSize: number,
  options: RedactionOptions
): ImageData {
  if (!wasmModule) {
    throw new Error('WASM module not initialized');
  }

  // Clone the image data - cast to Uint8Array for WASM compatibility
  const data = new Uint8Array(imageData.data.buffer.slice(0));
  const pointsF32 = new Float32Array(points);

  switch (options.style) {
    case 'solid': {
      const rgb = hexToRgb(options.color || '#000000');
      wasmModule.brush_solid_fill(
        data,
        imageData.width,
        imageData.height,
        pointsF32,
        brushSize,
        rgb.r,
        rgb.g,
        rgb.b
      );
      break;
    }
    case 'pixelate': {
      const blockSize = intensityToBlockSize(options.intensity);
      wasmModule.brush_pixelate(
        data,
        imageData.width,
        imageData.height,
        pointsF32,
        brushSize,
        blockSize
      );
      break;
    }
    case 'blur': {
      // For brush blur, we fall back to pixelate since blur is expensive per-stroke
      const blockSize = intensityToBlockSize(options.intensity);
      wasmModule.brush_pixelate(
        data,
        imageData.width,
        imageData.height,
        pointsF32,
        brushSize,
        blockSize
      );
      break;
    }
  }

  return new ImageData(new Uint8ClampedArray(data.buffer), imageData.width, imageData.height);
}
