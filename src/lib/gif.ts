/**
 * Animated GIF support.
 *
 * GIFs are decoded by the WASM module, which composites each frame (frames are
 * often partial patches over earlier ones) so the existing redaction pipeline
 * works on exactly what a viewer sees. Export re-encodes every frame into a
 * brand-new GIF: only pixels, frame timing and the loop count are carried over,
 * so comments, XMP and other extension data in the original are dropped.
 */

import { createGifEncoder, decodeGif, wasmReady } from './wasm/redactor';

const GIF_EXTENSION = /\.gif$/i;

/** Errors with a message that can be shown to the user. */
export class GifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GifError';
  }
}

export interface GifSource {
  width: number;
  height: number;
  frameCount: number;
  /** Frame delays in hundredths of a second, as stored in the file. */
  delays: number[];
  /** Loop count: -1 loops forever, 0 plays once, n repeats n more times. */
  repeat: number;
  /** Composite a frame (0-based index) to full-size ImageData. */
  renderFrame(index: number): ImageData;
  destroy(): void;
}

export interface GifWriter {
  /** Append a frame shown for `delay` hundredths of a second. */
  addFrame(frame: ImageData, delay: number): void;
  finish(): Blob;
  /** Release the encoder without producing a file. */
  abort(): void;
}

/**
 * Detect GIF files by MIME type, falling back to the file extension for
 * platforms that report an empty or generic MIME type.
 */
export function isGifFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === 'image/gif') return true;
  return (
    (type === '' || type === 'application/octet-stream') &&
    GIF_EXTENSION.test(file.name)
  );
}

/**
 * How long browsers show a frame, in milliseconds. Delays of 10ms or less are
 * played at 100ms, matching Chrome, Firefox and Safari.
 */
export function playbackDelay(delay: number): number {
  return delay <= 1 ? 100 : delay * 10;
}

/** The WASM module throws plain strings; turn them into errors. */
function toError(e: unknown): Error {
  return e instanceof Error ? e : new GifError(String(e));
}

export async function openGif(file: File): Promise<GifSource> {
  await wasmReady;
  const bytes = new Uint8Array(await file.arrayBuffer());

  let doc: ReturnType<typeof decodeGif>;
  try {
    doc = decodeGif(bytes);
  } catch (e) {
    throw toError(e);
  }

  const { width, height, frameCount, repeat } = doc;
  let destroyed = false;

  return {
    width,
    height,
    frameCount,
    repeat,
    delays: Array.from(doc.delays),
    renderFrame(index: number) {
      if (destroyed) throw new Error('GIF has been closed');
      let rgba: Uint8Array;
      try {
        rgba = doc.renderFrame(index);
      } catch (e) {
        throw toError(e);
      }
      // wasm-bindgen returns a fresh copy backed by a plain ArrayBuffer.
      const buffer = rgba.buffer as ArrayBuffer;
      return new ImageData(
        new Uint8ClampedArray(buffer, rgba.byteOffset, rgba.byteLength),
        width,
        height
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.free();
    }
  };
}

export function createGifWriter(
  width: number,
  height: number,
  repeat: number
): GifWriter {
  let encoder: ReturnType<typeof createGifEncoder>;
  try {
    encoder = createGifEncoder(width, height, repeat);
  } catch (e) {
    throw toError(e);
  }
  let done = false;

  return {
    addFrame(frame: ImageData, delay: number) {
      if (done) throw new Error('GIF has already been written');
      try {
        encoder.addFrame(
          new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
          delay
        );
      } catch (e) {
        throw toError(e);
      }
    },
    finish() {
      if (done) throw new Error('GIF has already been written');
      // `finish` consumes the encoder, even when it fails.
      done = true;
      let bytes: Uint8Array;
      try {
        bytes = encoder.finish();
      } catch (e) {
        throw toError(e);
      }
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
    },
    abort() {
      if (done) return;
      done = true;
      encoder.free();
    }
  };
}
