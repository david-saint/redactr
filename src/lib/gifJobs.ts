/**
 * Long-running GIF work, run inside `gif.worker.ts` so the editor stays
 * responsive: exporting a redacted GIF and rendering timeline thumbnails.
 * Each job decodes its own copy of the file with the worker's WASM instance.
 */

import { createGifEncoder, decodeGif } from './wasm/redactor';
import { replayCommands } from './redaction';
import type { RedactionCommand } from './stores/history';

/** Messages sent to the worker. */
export type GifJobRequest =
  | { type: 'export'; bytes: ArrayBuffer; commands: RedactionCommand[] }
  | { type: 'thumbnails'; bytes: ArrayBuffer; count: number; maxWidth: number; maxHeight: number };

/** Messages sent back from the worker. */
export type GifJobResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'exported'; bytes: Uint8Array }
  | { type: 'thumbnail'; index: number; frame: number; width: number; height: number; data: Uint8ClampedArray }
  | { type: 'complete' }
  | { type: 'error'; message: string };

/** The WASM module throws plain strings; keep their message. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function frameImage(rgba: Uint8Array, width: number, height: number): ImageData {
  // wasm-bindgen returns a fresh copy backed by a plain ArrayBuffer.
  const buffer = rgba.buffer as ArrayBuffer;
  return new ImageData(
    new Uint8ClampedArray(buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height
  );
}

/**
 * Re-encode every frame with the redactions that apply to it.
 * Only pixels, frame delays and the loop count reach the new file.
 */
export function exportFrames(
  bytes: ArrayBuffer,
  commands: RedactionCommand[],
  onProgress: (done: number, total: number) => void
): Uint8Array {
  const doc = decodeGif(new Uint8Array(bytes));
  let encoder: ReturnType<typeof createGifEncoder> | null = null;
  try {
    const { width, height, frameCount } = doc;
    const delays = doc.delays;
    encoder = createGifEncoder(width, height, doc.repeat);

    for (let i = 0; i < frameCount; i++) {
      let frame = frameImage(doc.renderFrame(i), width, height);
      if (commands.length) frame = replayCommands(frame, commands, i);
      encoder.addFrame(
        new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
        delays[i]
      );
      onProgress(i + 1, frameCount);
    }

    // `finish` consumes the encoder, even when it fails.
    const finished = encoder;
    encoder = null;
    return finished.finish();
  } finally {
    encoder?.free();
    doc.free();
  }
}

/** Frames to sample for `count` thumbnails, evenly spread and including both ends. */
export function thumbnailFrames(frameCount: number, count: number): number[] {
  const n = Math.max(1, Math.min(frameCount, Math.floor(count)));
  if (n === 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.round((i * (frameCount - 1)) / (n - 1)));
}

/** Largest size within the bounds that keeps the aspect ratio, at least 1×1. */
export function thumbnailSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Shrink RGBA pixels by averaging each target pixel's source area. Colors are
 * weighted by alpha so transparent pixels don't darken edges.
 */
export function downscale(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty++) {
    const y0 = Math.floor((ty * height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx++) {
      const x0 = Math.floor((tx * width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / targetWidth));
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const alpha = src[i + 3];
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (ty * targetWidth + tx) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a / ((x1 - x0) * (y1 - y0));
      }
    }
  }
  return out;
}

/** Render up to `count` evenly spaced frames as small thumbnails. */
export function renderThumbnails(
  bytes: ArrayBuffer,
  count: number,
  maxWidth: number,
  maxHeight: number,
  onThumbnail: (index: number, frame: number, width: number, height: number, data: Uint8ClampedArray) => void
): void {
  const doc = decodeGif(new Uint8Array(bytes));
  try {
    const { width, height } = doc;
    const size = thumbnailSize(width, height, maxWidth, maxHeight);
    thumbnailFrames(doc.frameCount, count).forEach((frame, index) => {
      const rgba = frameImage(doc.renderFrame(frame), width, height);
      onThumbnail(index, frame, size.width, size.height, downscale(rgba.data, width, height, size.width, size.height));
    });
  } finally {
    doc.free();
  }
}
