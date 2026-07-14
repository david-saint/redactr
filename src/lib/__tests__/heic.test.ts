import { describe, it, expect, vi, afterEach } from 'vitest';
import { isHeicFile, decodeHeic } from '../heic';

vi.mock('heic-decode', () => ({
  default: vi.fn(async ({ buffer }: { buffer: Uint8Array }) => {
    if (buffer.length === 0) {
      throw new TypeError('input buffer is not a HEIC image');
    }
    return {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(2 * 2 * 4).fill(128).buffer
    };
  })
}));

describe('isHeicFile', () => {
  it.each([
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence'
  ])('should detect HEIC by MIME type %s', (type) => {
    const file = new File([''], 'photo', { type });
    expect(isHeicFile(file)).toBe(true);
  });

  it('should detect HEIC by uppercase MIME type', () => {
    const file = new File([''], 'photo', { type: 'image/HEIC' as string });
    expect(isHeicFile(file)).toBe(true);
  });

  it('should fall back to .heic extension when MIME type is empty', () => {
    const file = new File([''], 'photo.heic', { type: '' });
    expect(isHeicFile(file)).toBe(true);
  });

  it('should fall back to .heif extension when MIME type is generic', () => {
    const file = new File([''], 'photo.heif', {
      type: 'application/octet-stream'
    });
    expect(isHeicFile(file)).toBe(true);
  });

  it('should match extensions case-insensitively', () => {
    const file = new File([''], 'IMG_1234.HEIC', { type: '' });
    expect(isHeicFile(file)).toBe(true);
  });

  it('should not detect regular image files', () => {
    const file = new File([''], 'photo.png', { type: 'image/png' });
    expect(isHeicFile(file)).toBe(false);
  });

  it('should not detect unknown files without a HEIC extension', () => {
    const file = new File([''], 'document.pdf', { type: '' });
    expect(isHeicFile(file)).toBe(false);
  });

  it('should trust a known non-HEIC MIME type over the extension', () => {
    const file = new File([''], 'photo.heic', { type: 'image/png' });
    expect(isHeicFile(file)).toBe(false);
  });
});

describe('decodeHeic', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should decode a HEIC file to ImageData', async () => {
    const file = new File([new Uint8Array(16)], 'photo.heic', { type: '' });

    const imageData = await decodeHeic(file);

    expect(imageData).toBeInstanceOf(ImageData);
    expect(imageData.width).toBe(2);
    expect(imageData.height).toBe(2);
    expect(imageData.data.length).toBe(2 * 2 * 4);
    expect(imageData.data[0]).toBe(128);
  });

  it('should propagate decoder errors', async () => {
    const file = new File([''], 'not-heic.heic', { type: '' });

    await expect(decodeHeic(file)).rejects.toThrow(
      'input buffer is not a HEIC image'
    );
  });
});
