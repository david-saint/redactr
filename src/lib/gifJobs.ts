/**
 * Long-running GIF work, run inside `gif.worker.ts` so the editor stays
 * responsive: exporting a redacted GIF and rendering timeline thumbnails.
 * Each job decodes its own copy of the file with the worker's WASM instance.
 */

import { createGifEncoder, decodeGif, trackRegion } from './wasm/redactor';
import { replayCommands } from './redaction';
import type { Box, RedactionCommand } from './stores/history';

export interface Keyframe {
  frame: number;
  box: Box;
}

/** A finished tracking job: a box (or null) and a score for every frame. */
export interface TrackResult {
  boxes: (Box | null)[];
  scores: number[];
}

/** Messages sent to the worker. */
export type GifJobRequest =
  | { type: 'export'; bytes: ArrayBuffer; commands: RedactionCommand[] }
  | { type: 'thumbnails'; bytes: ArrayBuffer; count: number; maxWidth: number; maxHeight: number }
  | { type: 'track'; bytes: ArrayBuffer; keyframes: Keyframe[] };

/** Messages sent back from the worker. */
export type GifJobResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'exported'; bytes: Uint8Array }
  | { type: 'thumbnail'; index: number; frame: number; width: number; height: number; data: Uint8ClampedArray }
  | { type: 'tracked'; result: TrackResult }
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

/** One tracking run: from a keyframe towards `to`, stopping early if lost. */
export interface TrackRun {
  from: number;
  box: Box;
  to: number;
}

/** A frame reached by a run, and how well it matched (0 = estimated). */
export interface TrackedFrame {
  frame: number;
  box: Box;
  score: number;
}

/** Keyframes sorted by frame, the last one winning for any repeated frame. */
function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  const byFrame = new Map<number, Keyframe>();
  for (const k of keyframes) byFrame.set(k.frame, k);
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * The runs that cover an animation from its keyframes: from each keyframe
 * back to the previous one (or the start) and on to the next (or the end).
 */
export function trackRuns(frameCount: number, keyframes: Keyframe[]): TrackRun[] {
  const sorted = sortKeyframes(keyframes);
  const runs: TrackRun[] = [];
  sorted.forEach((k, i) => {
    const prev = i > 0 ? sorted[i - 1].frame : -1;
    const next = i < sorted.length - 1 ? sorted[i + 1].frame : frameCount;
    if (k.frame - 1 > prev) runs.push({ from: k.frame, box: k.box, to: prev + 1 });
    if (k.frame + 1 < next) runs.push({ from: k.frame, box: k.box, to: next - 1 });
  });
  return runs;
}

function lerpBox(a: Box, b: Box, t: number): Box {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t
  };
}

/**
 * Combine runs into one box per frame. Keyframes are exact. Between two
 * keyframes the better of the two runs wins, and frames neither run reached
 * are interpolated between the keyframes (score 0), so the redaction never
 * has a gap between boxes placed by hand. Beyond the outer keyframes, frames
 * the runs didn't reach have no box.
 */
export function composeTrack(
  frameCount: number,
  keyframes: Keyframe[],
  results: TrackedFrame[][]
): TrackResult {
  const sorted = sortKeyframes(keyframes);
  const boxes: (Box | null)[] = new Array(frameCount).fill(null);
  const scores: number[] = new Array(frameCount).fill(0);

  for (const run of results) {
    for (const step of run) {
      if (step.frame < 0 || step.frame >= frameCount) continue;
      if (!boxes[step.frame] || step.score > scores[step.frame]) {
        boxes[step.frame] = step.box;
        scores[step.frame] = step.score;
      }
    }
  }

  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    for (let f = a.frame + 1; f < b.frame; f++) {
      if (!boxes[f]) {
        boxes[f] = lerpBox(a.box, b.box, (f - a.frame) / (b.frame - a.frame));
        scores[f] = 0;
      }
    }
  }

  for (const k of sorted) {
    if (k.frame < 0 || k.frame >= frameCount) continue;
    boxes[k.frame] = k.box;
    scores[k.frame] = 1;
  }
  return { boxes, scores };
}

/** Track content from each keyframe through the whole animation. */
export function trackFrames(
  bytes: ArrayBuffer,
  keyframes: Keyframe[],
  onProgress: (done: number, total: number) => void
): TrackResult {
  const doc = decodeGif(new Uint8Array(bytes));
  try {
    const frameCount = doc.frameCount;
    const runs = trackRuns(frameCount, keyframes);
    const total = runs.reduce((sum, r) => sum + Math.abs(r.to - r.from), 0);
    let done = 0;
    const results = runs.map(run => {
      const before = done;
      const flat = trackRegion(doc, run.from, run.box, run.to, n => {
        done = before + n;
        onProgress(done, total);
      });
      done = before + Math.abs(run.to - run.from);
      const steps: TrackedFrame[] = [];
      for (let i = 0; i + 6 <= flat.length; i += 6) {
        steps.push({
          frame: flat[i],
          box: { x: flat[i + 1], y: flat[i + 2], width: flat[i + 3], height: flat[i + 4] },
          score: flat[i + 5]
        });
      }
      return steps;
    });
    onProgress(total, total);
    return composeTrack(frameCount, keyframes, results);
  } finally {
    doc.free();
  }
}
