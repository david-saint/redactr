// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const wasm = {
  decodeGif: vi.fn()
};

vi.mock('../wasm/redactor', () => ({
  wasmReady: Promise.resolve(),
  decodeGif: (...args) => wasm.decodeGif(...args)
}));

import {
  isGifFile,
  playbackDelay,
  openGif,
  exportGif,
  renderGifThumbnails,
  trackGif,
  GifError,
  GifJobCancelled
} from '../gif';

function fakeDocument() {
  return {
    width: 2,
    height: 1,
    frameCount: 3,
    repeat: -1,
    delays: new Uint16Array([10, 0, 25]),
    renderFrame: vi.fn((i: number) => new Uint8Array(8).fill(i + 1)),
    free: vi.fn()
  };
}

const gifFile = () => new File([new Uint8Array([0x47, 0x49, 0x46])], 'loop.gif', { type: 'image/gif' });

describe('isGifFile', () => {
  it('should detect GIFs by MIME type', () => {
    expect(isGifFile(new File([''], 'anim', { type: 'image/gif' }))).toBe(true);
  });

  it('should fall back to the .gif extension for empty or generic MIME types', () => {
    expect(isGifFile(new File([''], 'anim.GIF', { type: '' }))).toBe(true);
    expect(isGifFile(new File([''], 'anim.gif', { type: 'application/octet-stream' }))).toBe(true);
  });

  it('should not detect other images or mislabeled files', () => {
    expect(isGifFile(new File([''], 'photo.png', { type: 'image/png' }))).toBe(false);
    expect(isGifFile(new File([''], 'fake.gif', { type: 'image/png' }))).toBe(false);
    expect(isGifFile(new File([''], 'notes.txt', { type: '' }))).toBe(false);
  });
});

describe('playbackDelay', () => {
  it('should convert hundredths of a second to milliseconds', () => {
    expect(playbackDelay(4)).toBe(40);
    expect(playbackDelay(100)).toBe(1000);
  });

  it('should play delays of 10ms or less at 100ms, like browsers', () => {
    expect(playbackDelay(0)).toBe(100);
    expect(playbackDelay(1)).toBe(100);
  });
});

describe('openGif', () => {
  beforeEach(() => {
    wasm.decodeGif.mockReset();
  });

  it('should expose the decoded frames as ImageData', async () => {
    const doc = fakeDocument();
    wasm.decodeGif.mockReturnValue(doc);

    const source = await openGif(gifFile());

    expect(wasm.decodeGif.mock.calls[0][0]).toEqual(new Uint8Array([0x47, 0x49, 0x46]));
    expect(source).toMatchObject({ width: 2, height: 1, frameCount: 3, repeat: -1 });
    expect(source.delays).toEqual([10, 0, 25]);
    expect(source.bytes.byteLength).toBe(3);

    const frame = source.renderFrame(2);
    expect(doc.renderFrame).toHaveBeenCalledWith(2);
    expect(frame.width).toBe(2);
    expect(frame.height).toBe(1);
    expect(Array.from(frame.data)).toEqual(new Array(8).fill(3));
  });

  it('should turn decoder messages into GifErrors', async () => {
    wasm.decodeGif.mockImplementation(() => {
      throw 'GIF is too large to edit in the browser';
    });

    const error = await openGif(gifFile()).catch((e) => e);
    expect(error).toBeInstanceOf(GifError);
    expect(error.message).toBe('GIF is too large to edit in the browser');
  });

  it('should free the decoder once and refuse to render afterwards', async () => {
    const doc = fakeDocument();
    wasm.decodeGif.mockReturnValue(doc);
    const source = await openGif(gifFile());

    source.destroy();
    source.destroy();

    expect(doc.free).toHaveBeenCalledTimes(1);
    expect(() => source.renderFrame(0)).toThrow('closed');
  });
});

// A stand-in for the module worker: records what it was sent and lets tests reply.
class FakeWorker {
  static instances: FakeWorker[] = [];
  url: string;
  options: WorkerOptions;
  sent: any[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  constructor(url: URL | string, options: WorkerOptions) {
    this.url = String(url);
    this.options = options;
    FakeWorker.instances.push(this);
  }
  postMessage(data: any, transfer: Transferable[] = []) {
    this.sent.push(data);
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: any) {
    this.onmessage?.({ data });
  }
}

describe('worker jobs', () => {
  const bytes = () => new Uint8Array([1, 2, 3]).buffer;

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should export in a module worker and resolve with a GIF blob', async () => {
    const source = bytes();
    const commands = [{ id: 'a', type: 'rect', frames: { start: 1, end: 2 } }];
    const progress = vi.fn();

    const job = exportGif(source, commands, progress);
    const worker = FakeWorker.instances[0];

    expect(worker.url).toContain('gif.worker');
    expect(worker.options).toEqual({ type: 'module' });
    const request = worker.sent[0];
    expect(request).toMatchObject({ type: 'export', commands });
    expect(request.commands).not.toBe(commands);
    // The worker gets a transferred copy; the caller's bytes stay usable.
    expect(request.bytes).not.toBe(source);
    expect(worker.transfers[0]).toEqual([request.bytes]);
    expect(source.byteLength).toBe(3);

    worker.reply({ type: 'progress', done: 1, total: 2 });
    worker.reply({ type: 'exported', bytes: new Uint8Array([0x47, 0x49, 0x46]) });
    const blob = await job.promise;

    expect(progress).toHaveBeenCalledWith(1, 2);
    expect(blob.type).toBe('image/gif');
    expect(blob.size).toBe(3);
    expect(worker.terminated).toBe(true);
  });

  it('should reject with the worker\'s message and stop the worker', async () => {
    const job = exportGif(bytes(), []);
    const worker = FakeWorker.instances[0];

    worker.reply({ type: 'error', message: 'No frames to encode' });

    const error = await job.promise.catch((e) => e);
    expect(error).toBeInstanceOf(GifError);
    expect(error.message).toBe('No frames to encode');
    expect(worker.terminated).toBe(true);
  });

  it('should reject when the worker fails to run', async () => {
    const job = exportGif(bytes(), []);
    const event = { message: 'boom', preventDefault: vi.fn() };

    FakeWorker.instances[0].onerror(event);

    await expect(job.promise).rejects.toThrow('boom');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('should cancel by terminating the worker and ignore later messages', async () => {
    const progress = vi.fn();
    const job = exportGif(bytes(), [], progress);
    const worker = FakeWorker.instances[0];

    job.cancel();
    worker.reply({ type: 'progress', done: 1, total: 1 });

    await expect(job.promise).rejects.toBeInstanceOf(GifJobCancelled);
    expect(worker.terminated).toBe(true);
    expect(progress).not.toHaveBeenCalled();
  });

  it('should stream thumbnails as ImageData and finish on complete', async () => {
    const onThumbnail = vi.fn();
    const job = renderGifThumbnails(bytes(), 10, 96, 54, onThumbnail);
    const worker = FakeWorker.instances[0];

    expect(worker.sent[0]).toMatchObject({ type: 'thumbnails', count: 10, maxWidth: 96, maxHeight: 54 });

    worker.reply({
      type: 'thumbnail',
      index: 3,
      frame: 7,
      width: 2,
      height: 1,
      data: new Uint8ClampedArray(8).fill(9)
    });
    worker.reply({ type: 'complete' });
    await job.promise;

    const [index, thumbnail] = onThumbnail.mock.calls[0];
    expect(index).toBe(3);
    expect(thumbnail.frame).toBe(7);
    expect(thumbnail.image.width).toBe(2);
    expect(Array.from(thumbnail.image.data)).toEqual(new Array(8).fill(9));
    expect(worker.terminated).toBe(true);
  });

  it('should track in a worker and resolve with the per-frame result', async () => {
    const keyframes = [{ frame: 3, box: { x: 1, y: 2, width: 3, height: 4 } }];
    const progress = vi.fn();
    const job = trackGif(bytes(), keyframes, progress);
    const worker = FakeWorker.instances[0];

    expect(worker.sent[0]).toMatchObject({ type: 'track', keyframes });

    const result = { boxes: [null, { x: 1, y: 2, width: 3, height: 4 }], scores: [0, 1] };
    worker.reply({ type: 'progress', done: 2, total: 5 });
    worker.reply({ type: 'tracked', result });

    expect(await job.promise).toEqual(result);
    expect(progress).toHaveBeenCalledWith(2, 5);
    expect(worker.terminated).toBe(true);
  });
});
