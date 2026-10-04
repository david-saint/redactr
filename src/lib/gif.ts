/**
 * Animated GIF support.
 *
 * GIFs are decoded by the WASM module, which composites each frame (frames are
 * often partial patches over earlier ones) so the existing redaction pipeline
 * works on exactly what a viewer sees. Export re-encodes every frame into a
 * brand-new GIF: only pixels, frame timing and the loop count are carried over,
 * so comments, XMP and other extension data in the original are dropped.
 *
 * Export and timeline thumbnails run in a Web Worker (`gif.worker.ts`), each
 * job decoding its own copy of the file, so the editor stays responsive.
 */

import { decodeGif, wasmReady } from './wasm/redactor';
import type { GifJobRequest, GifJobResponse, Keyframe, TrackResult } from './gifJobs';
import type { RedactionCommand } from './stores/history';

const GIF_EXTENSION = /\.gif$/i;

/** Errors with a message that can be shown to the user. */
export class GifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GifError';
  }
}

export interface GifSource {
  /** The original file, for jobs that decode their own copy in a worker. */
  bytes: ArrayBuffer;
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

/** Work running in a worker; `cancel` stops it and rejects with `GifJobCancelled`. */
export interface GifJob<T> {
  promise: Promise<T>;
  cancel(): void;
}

export class GifJobCancelled extends Error {
  constructor() {
    super('GIF job was cancelled');
    this.name = 'GifJobCancelled';
  }
}

/** A small rendering of one frame, for the timeline. */
export interface FrameThumbnail {
  frame: number;
  image: ImageData;
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
  const bytes = await file.arrayBuffer();

  let doc: ReturnType<typeof decodeGif>;
  try {
    doc = decodeGif(new Uint8Array(bytes));
  } catch (e) {
    throw toError(e);
  }

  const { width, height, frameCount, repeat } = doc;
  let destroyed = false;

  return {
    bytes,
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

/**
 * Start a job in a new worker. `onMessage` handles everything but errors and
 * calls `resolve` to finish; the worker is terminated however the job ends.
 */
function runJob<T>(
  request: GifJobRequest,
  onMessage: (message: GifJobResponse, resolve: (value: T) => void) => void
): GifJob<T> {
  const worker = new Worker(new URL('./gif.worker.ts', import.meta.url), {
    type: 'module'
  });
  let settled = false;
  let cancel = () => {};

  const promise = new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      finish();
    };

    worker.onmessage = (event: MessageEvent<GifJobResponse>) => {
      // Messages already queued when the job ended are dropped.
      if (settled) return;
      const message = event.data;
      if (message.type === 'error') {
        settle(() => reject(new GifError(message.message)));
      } else {
        onMessage(message, value => settle(() => resolve(value)));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      settle(() => reject(new Error(event.message || 'GIF worker failed')));
    };
    cancel = () => settle(() => reject(new GifJobCancelled()));
  });

  // The worker gets its own copy of the file.
  const bytes = request.bytes.slice(0);
  worker.postMessage({ ...request, bytes }, [bytes]);
  return { promise, cancel: () => cancel() };
}

/**
 * Export a redacted GIF in a worker. `onProgress` is called with the number of
 * frames encoded so far.
 */
export function exportGif(
  bytes: ArrayBuffer,
  commands: RedactionCommand[],
  onProgress?: (done: number, total: number) => void
): GifJob<Blob> {
  // Plain copies: store values may not survive structured cloning as-is.
  const plainCommands = JSON.parse(JSON.stringify(commands)) as RedactionCommand[];
  return runJob<Blob>({ type: 'export', bytes, commands: plainCommands }, (message, resolve) => {
    if (message.type === 'progress') {
      onProgress?.(message.done, message.total);
    } else if (message.type === 'exported') {
      resolve(new Blob([message.bytes as Uint8Array<ArrayBuffer>], { type: 'image/gif' }));
    }
  });
}

/**
 * Render up to `count` evenly spaced frames, at most `maxWidth`×`maxHeight`,
 * in a worker. Thumbnails arrive one at a time through `onThumbnail`.
 */
export function renderGifThumbnails(
  bytes: ArrayBuffer,
  count: number,
  maxWidth: number,
  maxHeight: number,
  onThumbnail: (index: number, thumbnail: FrameThumbnail) => void
): GifJob<void> {
  return runJob<void>(
    { type: 'thumbnails', bytes, count, maxWidth, maxHeight },
    (message, resolve) => {
      if (message.type === 'thumbnail') {
        const data = new Uint8ClampedArray(message.data);
        onThumbnail(message.index, {
          frame: message.frame,
          image: new ImageData(data, message.width, message.height)
        });
      } else if (message.type === 'complete') {
        resolve();
      }
    }
  );
}

/**
 * Follow content through the animation from hand-placed keyframes, in a
 * worker. `onProgress` is called with frames done out of the total.
 */
export function trackGif(
  bytes: ArrayBuffer,
  keyframes: Keyframe[],
  onProgress?: (done: number, total: number) => void
): GifJob<TrackResult> {
  return runJob<TrackResult>({ type: 'track', bytes, keyframes }, (message, resolve) => {
    if (message.type === 'progress') {
      onProgress?.(message.done, message.total);
    } else if (message.type === 'tracked') {
      resolve(message.result);
    }
  });
}
