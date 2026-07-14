/**
 * HEIC/HEIF support.
 *
 * Most browsers (everything except Safari) cannot decode HEIC natively, so we
 * decode via libheif compiled to WebAssembly (`heic-decode`). The decoder is
 * imported lazily so the ~1MB chunk is only fetched when a HEIC file is
 * actually opened; the WASM is inlined in the chunk, so decoding stays fully
 * local and works offline once the PWA is cached.
 */

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
]);

const HEIC_EXTENSION = /\.hei[cf]$/i;

/**
 * Detect HEIC/HEIF files by MIME type, falling back to the file extension —
 * browsers on platforms without native HEIC support (Windows, Linux) commonly
 * report an empty or generic MIME type for these files.
 */
export function isHeicFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (HEIC_MIME_TYPES.has(type)) return true;
  return (
    (type === '' || type === 'application/octet-stream') &&
    HEIC_EXTENSION.test(file.name)
  );
}

/**
 * Decode a HEIC/HEIF file to ImageData (primary image only).
 * Throws if the buffer is not actually a HEIC image or decoding fails.
 */
export async function decodeHeic(file: File): Promise<ImageData> {
  const { default: decode } = await import('heic-decode');
  const buffer = new Uint8Array(await file.arrayBuffer());
  const { width, height, data } = await decode({ buffer });
  return new ImageData(new Uint8ClampedArray(data), width, height);
}
