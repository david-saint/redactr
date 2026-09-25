/**
 * PDF support.
 *
 * PDFs are opened with PDF.js, and each page is rasterized to ImageData so the
 * existing redaction pipeline can operate on it unchanged. Export rebuilds a
 * brand-new PDF where every page is a single flattened image: the original
 * text layer, fonts, annotations, form data and document metadata are not
 * carried over, so redacted content cannot be recovered by selecting or
 * extracting text.
 *
 * PDF.js is imported lazily so its chunk and worker are only fetched when a
 * PDF is actually opened. Everything runs locally in the browser.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_EXTENSION = /\.pdf$/i;

/** Pages are rasterized at 2x (144 DPI) for crisp text... */
const RENDER_SCALE = 2;
/** ...unless that would exceed this many pixels on the longest side. */
const MAX_RENDER_DIMENSION = 4096;

/** Directory (relative to the app base URL) where PDF.js data files are served. */
const PDFJS_ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

export interface PdfPageSize {
  /** Page width in PDF points (1/72 inch), after applying page rotation. */
  width: number;
  /** Page height in PDF points (1/72 inch), after applying page rotation. */
  height: number;
}

export interface PdfSource {
  pageCount: number;
  pageSizes: PdfPageSize[];
  /** Rasterize a page (0-based index) to ImageData. */
  renderPage(index: number): Promise<ImageData>;
  destroy(): Promise<void>;
}

export class PdfPasswordError extends Error {
  constructor() {
    super('Password-protected PDFs are not supported');
    this.name = 'PdfPasswordError';
  }
}

/**
 * Detect PDF files by MIME type, falling back to the file extension for
 * platforms that report an empty or generic MIME type.
 */
export function isPdfFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === 'application/pdf') return true;
  return (
    (type === '' || type === 'application/octet-stream') &&
    PDF_EXTENSION.test(file.name)
  );
}

/**
 * Scale factor for rasterizing a page of the given size (in points), capped so
 * very large pages (posters, drawings) don't produce enormous canvases.
 */
export function getRenderScale(size: PdfPageSize): number {
  const longest = Math.max(size.width, size.height);
  if (longest <= 0) return RENDER_SCALE;
  return Math.min(RENDER_SCALE, MAX_RENDER_DIMENSION / longest);
}

async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/**
 * Open a PDF file and read its page sizes.
 * Throws `PdfPasswordError` for encrypted documents that need a password.
 */
export async function openPdf(file: File): Promise<PdfSource> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());

  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
    iccUrl: `${PDFJS_ASSET_BASE}iccs/`
  });

  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (e) {
    await loadingTask.destroy().catch(() => {});
    if (e instanceof pdfjs.PasswordException) {
      throw new PdfPasswordError();
    }
    throw e;
  }

  const pageSizes: PdfPageSize[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { width, height } = page.getViewport({ scale: 1 });
      pageSizes.push({ width, height });
      page.cleanup();
    }
  } catch (e) {
    await loadingTask.destroy().catch(() => {});
    throw e;
  }

  return {
    pageCount: doc.numPages,
    pageSizes,
    async renderPage(index: number): Promise<ImageData> {
      const page = await doc.getPage(index + 1);
      try {
        const viewport = page.getViewport({
          scale: getRenderScale(pageSizes[index])
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));

        await page.render({ canvas, viewport, background: '#ffffff' }).promise;

        const ctx = canvas.getContext('2d')!;
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      } finally {
        page.cleanup();
      }
    },
    async destroy() {
      await loadingTask.destroy();
    }
  };
}

export interface PdfImagePage {
  /** Baseline JPEG bytes for the page image. */
  jpeg: Uint8Array;
  /** Image dimensions in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page dimensions in PDF points. */
  width: number;
  height: number;
}

function formatNumber(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/**
 * Build a minimal PDF where each page is a single full-page JPEG image.
 * No metadata (title, author, producer, dates) is written.
 */
export function buildImagePdf(pages: PdfImagePage[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };

  const beginObject = (id: number) => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
  };

  // Object layout: 1 = catalog, 2 = page tree, then 3 objects per page
  // (page, content stream, image XObject).
  const pageObjectId = (i: number) => 3 + i * 3;
  const objectCount = 2 + pages.length * 3;

  // Header; the binary comment marks the file as containing binary data.
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(1);
  write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  const kids = pages.map((_, i) => `${pageObjectId(i)} 0 R`).join(' ');
  write(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const pageId = pageObjectId(i);
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const w = formatNumber(page.width);
    const h = formatNumber(page.height);

    beginObject(pageId);
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>\nendobj\n`
    );

    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObject(contentId);
    write(`<< /Length ${encoder.encode(content).length} >>\nstream\n`);
    write(content);
    write('endstream\nendobj\n');

    beginObject(imageId);
    write(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} ` +
        `/Height ${page.pixelHeight} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
    );
    write(page.jpeg);
    write('\nendstream\nendobj\n');
  });

  const xrefOffset = length;
  write(`xref\n0 ${objectCount + 1}\n`);
  write('0000000000 65535 f \n');
  for (let id = 1; id <= objectCount; id++) {
    write(`${offsets[id].toString().padStart(10, '0')} 00000 n \n`);
  }
  write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n`);
  write(`startxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

/** Encode ImageData as JPEG bytes for embedding in a PDF. */
export async function encodeJpeg(
  imageData: ImageData,
  quality = 0.92
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode page'))),
      'image/jpeg',
      quality
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}
