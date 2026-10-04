// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';

const wasm = {
  decodeGif: vi.fn(),
  createGifEncoder: vi.fn(),
  trackRegion: vi.fn()
};

vi.mock('../wasm/redactor', () => ({
  decodeGif: (...args) => wasm.decodeGif(...args),
  createGifEncoder: (...args) => wasm.createGifEncoder(...args),
  trackRegion: (...args) => wasm.trackRegion(...args)
}));

// Replaying marks the frame's first pixel with the frame index + 100.
vi.mock('../redaction', () => ({
  replayCommands: vi.fn((image: ImageData, _commands, frame: number) => {
    const data = new Uint8ClampedArray(image.data);
    data[0] = 100 + frame;
    return new ImageData(data, image.width, image.height);
  })
}));

import {
  exportFrames,
  renderThumbnails,
  thumbnailFrames,
  thumbnailSize,
  downscale,
  errorMessage,
  trackRuns,
  composeTrack,
  trackFrames
} from '../gifJobs';

function fakeDocument(frameCount = 3, width = 4, height = 2) {
  return {
    width,
    height,
    frameCount,
    repeat: 2,
    delays: new Uint16Array(Array.from({ length: frameCount }, (_, i) => 10 + i)),
    renderFrame: vi.fn((i: number) => new Uint8Array(width * height * 4).fill(i + 1)),
    free: vi.fn()
  };
}

function fakeEncoder() {
  return {
    addFrame: vi.fn(),
    finish: vi.fn(() => new Uint8Array([0x47, 0x49, 0x46])),
    free: vi.fn()
  };
}

describe('exportFrames', () => {
  beforeEach(() => {
    wasm.decodeGif.mockReset();
    wasm.createGifEncoder.mockReset();
  });

  it('should encode every frame with its redactions, delays and loop count', () => {
    const doc = fakeDocument();
    const encoder = fakeEncoder();
    wasm.decodeGif.mockReturnValue(doc);
    wasm.createGifEncoder.mockReturnValue(encoder);
    const progress = vi.fn();

    const bytes = exportFrames(new Uint8Array([1]).buffer, [{ id: 'a' }], progress);

    expect(Array.from(bytes)).toEqual([0x47, 0x49, 0x46]);
    expect(wasm.createGifEncoder).toHaveBeenCalledWith(4, 2, 2);
    expect(encoder.addFrame.mock.calls.map(([px, delay]) => [px[0], px[1], delay])).toEqual([
      [100, 1, 10],
      [101, 2, 11],
      [102, 3, 12]
    ]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    expect(doc.free).toHaveBeenCalled();
    // `finish` consumed the encoder.
    expect(encoder.free).not.toHaveBeenCalled();
  });

  it('should copy frames as-is when nothing is redacted', () => {
    const encoder = fakeEncoder();
    wasm.decodeGif.mockReturnValue(fakeDocument());
    wasm.createGifEncoder.mockReturnValue(encoder);

    exportFrames(new ArrayBuffer(1), [], () => {});

    expect(encoder.addFrame.mock.calls.map(([px]) => px[0])).toEqual([1, 2, 3]);
  });

  it('should release the decoder and encoder when a frame fails', () => {
    const doc = fakeDocument();
    const encoder = fakeEncoder();
    doc.renderFrame.mockImplementation((i) => {
      if (i === 1) throw 'Frame 1 is out of range';
      return new Uint8Array(32);
    });
    wasm.decodeGif.mockReturnValue(doc);
    wasm.createGifEncoder.mockReturnValue(encoder);

    expect(() => exportFrames(new ArrayBuffer(1), [], () => {})).toThrow();
    expect(encoder.free).toHaveBeenCalled();
    expect(encoder.finish).not.toHaveBeenCalled();
    expect(doc.free).toHaveBeenCalled();
  });
});

describe('errorMessage', () => {
  it('should keep messages from errors and thrown strings', () => {
    expect(errorMessage(new Error('bad'))).toBe('bad');
    expect(errorMessage('Not a valid GIF')).toBe('Not a valid GIF');
  });
});

describe('thumbnailFrames', () => {
  it('should spread samples evenly and include both ends', () => {
    expect(thumbnailFrames(48, 4)).toEqual([0, 16, 31, 47]);
    expect(thumbnailFrames(10, 2)).toEqual([0, 9]);
  });

  it('should never sample more frames than exist', () => {
    expect(thumbnailFrames(3, 10)).toEqual([0, 1, 2]);
    expect(thumbnailFrames(5, 1)).toEqual([0]);
    expect(thumbnailFrames(5, 0)).toEqual([0]);
  });
});

describe('thumbnailSize', () => {
  it('should fit within the bounds and keep the aspect ratio', () => {
    expect(thumbnailSize(480, 240, 96, 80)).toEqual({ width: 96, height: 48 });
    expect(thumbnailSize(100, 400, 96, 80)).toEqual({ width: 20, height: 80 });
  });

  it('should not enlarge small frames or collapse thin ones', () => {
    expect(thumbnailSize(10, 5, 96, 80)).toEqual({ width: 10, height: 5 });
    expect(thumbnailSize(4000, 1, 96, 80)).toEqual({ width: 96, height: 1 });
  });
});

describe('downscale', () => {
  it('should average each block of source pixels', () => {
    // 2x1: black and white -> 1x1 mid gray
    const src = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(Array.from(downscale(src, 2, 1, 1, 1))).toEqual([128, 128, 128, 255]);
  });

  it('should ignore the color of transparent pixels', () => {
    const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
    expect(Array.from(downscale(src, 2, 1, 1, 1))).toEqual([255, 0, 0, 128]);
  });
});

describe('renderThumbnails', () => {
  it('should render the sampled frames at thumbnail size', () => {
    const doc = fakeDocument(5, 4, 2);
    wasm.decodeGif.mockReturnValue(doc);
    const onThumbnail = vi.fn();

    renderThumbnails(new ArrayBuffer(1), 3, 2, 2, onThumbnail);

    expect(onThumbnail.mock.calls.map(([index, frame, w, h, data]) => [index, frame, w, h, data[0]])).toEqual([
      [0, 0, 2, 1, 1],
      [1, 2, 2, 1, 3],
      [2, 4, 2, 1, 5]
    ]);
    expect(doc.free).toHaveBeenCalled();
  });
});

const box = (x: number) => ({ x, y: 0, width: 10, height: 5 });

describe('trackRuns', () => {
  it('should run out from a single keyframe both ways', () => {
    expect(trackRuns(10, [{ frame: 4, box: box(1) }])).toEqual([
      { from: 4, box: box(1), to: 0 },
      { from: 4, box: box(1), to: 9 }
    ]);
  });

  it('should run between keyframes from both ends and skip empty gaps', () => {
    const runs = trackRuns(10, [
      { frame: 6, box: box(2) },
      { frame: 0, box: box(1) },
      { frame: 7, box: box(3) }
    ]);
    expect(runs.map((r) => [r.from, r.to])).toEqual([
      [0, 5],
      [6, 1],
      [7, 9]
    ]);
  });

  it('should use the latest keyframe placed on a frame', () => {
    const runs = trackRuns(3, [
      { frame: 1, box: box(1) },
      { frame: 1, box: box(9) }
    ]);
    expect(runs.every((r) => r.box.x === 9)).toBe(true);
  });
});

describe('composeTrack', () => {
  it('should keep keyframes exact and take the better of two runs', () => {
    const result = composeTrack(
      5,
      [
        { frame: 0, box: box(0) },
        { frame: 4, box: box(40) }
      ],
      [
        [
          { frame: 1, box: box(11), score: 0.9 },
          { frame: 2, box: box(21), score: 0.6 },
          { frame: 4, box: box(99), score: 0.99 }
        ],
        [
          { frame: 2, box: box(22), score: 0.8 },
          { frame: 1, box: box(12), score: 0.7 }
        ]
      ]
    );
    // Frame 3: neither run reached it, so it's interpolated between the keyframes.
    expect(result.boxes.map((b) => b.x)).toEqual([0, 11, 22, 30, 40]);
    expect(result.scores).toEqual([1, 0.9, 0.8, 0, 1]);
  });

  it('should fill gaps between keyframes by interpolation, never leaving holes', () => {
    const result = composeTrack(
      5,
      [
        { frame: 0, box: box(0) },
        { frame: 4, box: { x: 40, y: 8, width: 20, height: 9 } }
      ],
      []
    );
    expect(result.boxes[2]).toEqual({ x: 20, y: 4, width: 15, height: 7 });
    expect(result.scores[2]).toBe(0);
  });

  it('should leave frames beyond the reach of the outer runs empty', () => {
    const result = composeTrack(6, [{ frame: 2, box: box(2) }], [
      [{ frame: 1, box: box(1), score: 0.9 }],
      [{ frame: 3, box: box(3), score: 0.8 }]
    ]);
    expect(result.boxes.map((b) => b?.x ?? null)).toEqual([null, 1, 2, 3, null, null]);
  });
});

describe('trackFrames', () => {
  beforeEach(() => {
    wasm.decodeGif.mockReset();
    wasm.trackRegion.mockReset();
  });

  it('should track every run, report overall progress and compose the result', () => {
    const doc = fakeDocument(4);
    wasm.decodeGif.mockReturnValue(doc);
    wasm.trackRegion.mockImplementation((_doc, from, b, to, progress) => {
      const out = [];
      const step = to > from ? 1 : -1;
      for (let f = from + step, n = 1; step > 0 ? f <= to : f >= to; f += step, n++) {
        out.push(f, b.x + f, 0, 10, 5, 0.9);
        progress(n);
      }
      return new Float64Array(out);
    });
    const progress = vi.fn();

    const result = trackFrames(new ArrayBuffer(1), [{ frame: 1, box: box(100) }], progress);

    expect(wasm.trackRegion.mock.calls.map(([, from, , to]) => [from, to])).toEqual([
      [1, 0],
      [1, 3]
    ]);
    expect(result.boxes.map((b) => b.x)).toEqual([100, 100, 102, 103]);
    expect(result.scores).toEqual([0.9, 1, 0.9, 0.9]);
    expect(progress.mock.calls.map(([d]) => d)).toEqual([1, 2, 3, 3]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    expect(doc.free).toHaveBeenCalled();
  });

  it('should free the decoder when tracking fails', () => {
    const doc = fakeDocument(4);
    wasm.decodeGif.mockReturnValue(doc);
    wasm.trackRegion.mockImplementation(() => {
      throw 'There is no detail under the box to follow';
    });

    expect(() => trackFrames(new ArrayBuffer(1), [{ frame: 0, box: box(1) }], () => {})).toThrow();
    expect(doc.free).toHaveBeenCalled();
  });
});
