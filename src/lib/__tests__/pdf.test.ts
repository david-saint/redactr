import { describe, it, expect } from 'vitest';
import { isPdfFile, getRenderScale, buildImagePdf } from '../pdf';

async function blobText(blob: Blob): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // latin1 keeps a 1:1 mapping between bytes and characters for offset checks
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return { bytes, text };
}

describe('isPdfFile', () => {
  it('should detect PDFs by MIME type', () => {
    expect(isPdfFile(new File([''], 'doc', { type: 'application/pdf' }))).toBe(true);
  });

  it('should fall back to the .pdf extension for empty or generic MIME types', () => {
    expect(isPdfFile(new File([''], 'scan.PDF', { type: '' }))).toBe(true);
    expect(
      isPdfFile(new File([''], 'scan.pdf', { type: 'application/octet-stream' }))
    ).toBe(true);
  });

  it('should not detect images or mislabeled files', () => {
    expect(isPdfFile(new File([''], 'photo.png', { type: 'image/png' }))).toBe(false);
    expect(isPdfFile(new File([''], 'fake.pdf', { type: 'image/png' }))).toBe(false);
    expect(isPdfFile(new File([''], 'notes.txt', { type: '' }))).toBe(false);
  });
});

describe('getRenderScale', () => {
  it('should render regular pages at 2x', () => {
    expect(getRenderScale({ width: 612, height: 792 })).toBe(2);
  });

  it('should cap the longest side of large pages at 4096px', () => {
    const scale = getRenderScale({ width: 2384, height: 3370 }); // A0
    expect(scale).toBeLessThan(2);
    expect(Math.round(3370 * scale)).toBe(4096);
  });

  it('should fall back to the default scale for empty pages', () => {
    expect(getRenderScale({ width: 0, height: 0 })).toBe(2);
  });
});

describe('buildImagePdf', () => {
  const jpeg = (fill: number) => new Uint8Array([0xff, 0xd8, fill, fill, 0xff, 0xd9]);

  const pages = [
    { jpeg: jpeg(1), pixelWidth: 1224, pixelHeight: 1584, width: 612, height: 792 },
    { jpeg: jpeg(2), pixelWidth: 1584, pixelHeight: 1224, width: 792, height: 612.5 }
  ];

  it('should produce a PDF blob with a valid header and trailer', async () => {
    const blob = buildImagePdf(pages);
    expect(blob.type).toBe('application/pdf');

    const { text } = await blobText(blob);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).toContain('/Type /Pages /Kids [3 0 R 6 0 R] /Count 2');
    expect(text).toContain('/Size 9 /Root 1 0 R');
  });

  it('should write one page per image with the original page size', async () => {
    const { text } = await blobText(buildImagePdf(pages));
    expect(text).toContain('/MediaBox [0 0 612 792]');
    expect(text).toContain('/MediaBox [0 0 792 612.5]');
    expect(text).toContain('/Width 1224 /Height 1584');
    expect(text).toContain('/Width 1584 /Height 1224');
    expect(text).toContain('792 0 0 612.5 0 0 cm');
  });

  it('should embed the JPEG bytes unchanged', async () => {
    const { text } = await blobText(buildImagePdf(pages));
    const embedded = (fill: number) =>
      `stream\n${String.fromCharCode(0xff, 0xd8, fill, fill, 0xff, 0xd9)}\nendstream`;
    expect(text).toContain(embedded(1));
    expect(text).toContain(embedded(2));
    expect(text).toContain('/Filter /DCTDecode /Length 6');
  });

  it('should write a cross-reference table with correct byte offsets', async () => {
    const { text } = await blobText(buildImagePdf(pages));

    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 5)).toBe('xref\n');

    const entries = text
      .slice(startxref)
      .split('\n')
      .slice(3, 3 + 8);
    entries.forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      expect(text.slice(offset).startsWith(`${i + 1} 0 obj\n`)).toBe(true);
    });
  });

  it('should declare content stream lengths that match their data', async () => {
    const { text } = await blobText(buildImagePdf(pages));
    const re = /<< \/Length (\d+) >>\nstream\n/g;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = re.exec(text))) {
      const start = match.index + match[0].length;
      const length = Number(match[1]);
      expect(text.slice(start + length).startsWith('endstream')).toBe(true);
      count++;
    }
    expect(count).toBe(2);
  });

  it('should not write any document metadata', async () => {
    const { text } = await blobText(buildImagePdf(pages));
    expect(text).not.toMatch(/\/Info|\/Producer|\/Author|\/Title|\/Metadata/);
  });
});
