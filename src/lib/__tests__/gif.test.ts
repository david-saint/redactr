// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';

const wasm = {
  decodeGif: vi.fn(),
  createGifEncoder: vi.fn()
};

vi.mock('../wasm/redactor', () => ({
  wasmReady: Promise.resolve(),
  decodeGif: (...args) => wasm.decodeGif(...args),
  createGifEncoder: (...args) => wasm.createGifEncoder(...args)
}));

import { isGifFile, playbackDelay, openGif, createGifWriter, GifError } from '../gif';

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

function fakeEncoder() {
  return {
    addFrame: vi.fn(),
    finish: vi.fn(() => new Uint8Array([0x47, 0x49, 0x46])),
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

describe('createGifWriter', () => {
  beforeEach(() => {
    wasm.createGifEncoder.mockReset();
  });

  it('should pass frames to the encoder and return a GIF blob', async () => {
    const encoder = fakeEncoder();
    wasm.createGifEncoder.mockReturnValue(encoder);

    const writer = createGifWriter(2, 1, 0);
    writer.addFrame(new ImageData(new Uint8ClampedArray(8).fill(7), 2, 1), 12);
    const blob = writer.finish();

    expect(wasm.createGifEncoder).toHaveBeenCalledWith(2, 1, 0);
    const [pixels, delay] = encoder.addFrame.mock.calls[0];
    expect(Array.from(pixels)).toEqual(new Array(8).fill(7));
    expect(delay).toBe(12);
    expect(blob.type).toBe('image/gif');
    expect(blob.size).toBe(3);
  });

  it('should not free the encoder after finishing, since finishing consumes it', () => {
    const encoder = fakeEncoder();
    encoder.finish.mockImplementation(() => {
      throw 'No frames to encode';
    });
    wasm.createGifEncoder.mockReturnValue(encoder);

    const writer = createGifWriter(2, 1, -1);
    expect(() => writer.finish()).toThrow(GifError);
    writer.abort();

    expect(encoder.free).not.toHaveBeenCalled();
    expect(() => writer.addFrame(new ImageData(2, 1), 1)).toThrow('already');
  });

  it('should free the encoder when aborted', () => {
    const encoder = fakeEncoder();
    wasm.createGifEncoder.mockReturnValue(encoder);

    const writer = createGifWriter(2, 1, -1);
    writer.abort();
    writer.abort();

    expect(encoder.free).toHaveBeenCalledTimes(1);
  });
});
