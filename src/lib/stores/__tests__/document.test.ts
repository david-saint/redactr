// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

const makeImage = (value: number, width = 2, height = 2) =>
  new ImageData(new Uint8ClampedArray(width * height * 4).fill(value), width, height);

const pdfMock = {
  openPdf: vi.fn(),
  encodeJpeg: vi.fn(async (img: ImageData) => new Uint8Array([img.data[0]])),
  buildImagePdf: vi.fn(() => new Blob(['%PDF'], { type: 'application/pdf' }))
};

vi.mock('../../pdf', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openPdf: (...args) => pdfMock.openPdf(...args),
    encodeJpeg: (...args) => pdfMock.encodeJpeg(...args),
    buildImagePdf: (...args) => pdfMock.buildImagePdf(...args)
  };
});

// Replaying commands marks the image with the number of active commands.
vi.mock('../../redaction', () => ({
  replayCommands: vi.fn((original: ImageData, commands) => {
    const data = new Uint8ClampedArray(original.data);
    data[0] = 200 + commands.length;
    return new ImageData(data, original.width, original.height);
  })
}));

function createSource(pageCount = 3) {
  return {
    pageCount,
    pageSizes: Array.from({ length: pageCount }, (_, i) => ({
      width: 600 + i,
      height: 800
    })),
    renderPage: vi.fn(async (index: number) => makeImage(index + 1)),
    destroy: vi.fn(async () => {})
  };
}

const rect = {
  type: 'rect',
  style: 'solid',
  region: { x: 0, y: 0, width: 1, height: 1 },
  points: null,
  intensity: 50,
  color: '#000000'
};

const pdfFile = () => new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' });

describe('documentStore', () => {
  let documentStore: any;
  let isPdf: any;
  let imageStore: any;
  let historyStore: any;
  let source: ReturnType<typeof createSource>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    source = createSource();
    pdfMock.openPdf.mockResolvedValue(source);

    ({ documentStore, isPdf } = await import('../document'));
    ({ imageStore } = await import('../image'));
    ({ historyStore } = await import('../history'));
  });

  describe('open', () => {
    it('should load the first page of a PDF', async () => {
      await documentStore.open(pdfFile());

      const state = get(documentStore);
      expect(state.kind).toBe('pdf');
      expect(state.pageCount).toBe(3);
      expect(state.currentPage).toBe(0);
      expect(get(isPdf)).toBe(true);

      const image = get(imageStore);
      expect(image.name).toBe('report.pdf');
      expect(image.original.data[0]).toBe(1);
      expect(source.renderPage).toHaveBeenCalledWith(0);
    });

    it('should load images through the image store', async () => {
      const load = vi.spyOn(imageStore, 'load').mockResolvedValue(undefined);
      const file = new File([''], 'photo.png', { type: 'image/png' });

      await documentStore.open(file);

      expect(load).toHaveBeenCalledWith(file);
      expect(pdfMock.openPdf).not.toHaveBeenCalled();
      expect(get(documentStore).kind).toBe('image');
      expect(get(isPdf)).toBe(false);
    });

    it('should reject and clean up PDFs without pages', async () => {
      const empty = createSource(0);
      pdfMock.openPdf.mockResolvedValue(empty);

      await expect(documentStore.open(pdfFile())).rejects.toThrow('no pages');
      expect(empty.destroy).toHaveBeenCalled();
      expect(get(documentStore).kind).toBe(null);
    });

    it('should close the previous PDF when opening another file', async () => {
      await documentStore.open(pdfFile());
      const second = createSource(1);
      pdfMock.openPdf.mockResolvedValue(second);

      await documentStore.open(pdfFile());

      expect(source.destroy).toHaveBeenCalled();
      expect(get(documentStore).pageCount).toBe(1);
    });
  });

  describe('goToPage', () => {
    beforeEach(async () => {
      await documentStore.open(pdfFile());
    });

    it('should render and show the requested page', async () => {
      await documentStore.goToPage(2);

      expect(get(documentStore).currentPage).toBe(2);
      expect(get(imageStore).original.data[0]).toBe(3);
      expect(get(documentStore).isLoadingPage).toBe(false);
    });

    it('should keep a separate undo history per page', async () => {
      historyStore.push(rect);
      historyStore.push(rect);

      await documentStore.nextPage();
      expect(get(historyStore).commands).toEqual([]);

      historyStore.push(rect);
      await documentStore.prevPage();

      const state = get(historyStore);
      expect(state.commands.length).toBe(2);
      expect(state.currentIndex).toBe(1);
    });

    it('should ignore out-of-range and current pages', async () => {
      await documentStore.goToPage(-1);
      await documentStore.goToPage(3);
      await documentStore.goToPage(0);
      await documentStore.prevPage();

      expect(source.renderPage).toHaveBeenCalledTimes(1);
      expect(get(documentStore).currentPage).toBe(0);
    });

    it('should drop a navigation superseded by a newer one', async () => {
      let resolveSlow: (img: ImageData) => void;
      source.renderPage.mockImplementationOnce(
        () => new Promise((resolve) => (resolveSlow = resolve))
      );

      const slow = documentStore.goToPage(1);
      await documentStore.goToPage(2);
      resolveSlow(makeImage(2));
      await slow;

      expect(get(documentStore).currentPage).toBe(2);
      expect(get(imageStore).original.data[0]).toBe(3);
    });

    it('should clear the loading flag when rendering fails', async () => {
      source.renderPage.mockRejectedValueOnce(new Error('bad page'));

      await expect(documentStore.goToPage(1)).rejects.toThrow('bad page');

      expect(get(documentStore).isLoadingPage).toBe(false);
      expect(get(documentStore).currentPage).toBe(0);
    });
  });

  describe('exportPdf', () => {
    beforeEach(async () => {
      await documentStore.open(pdfFile());
    });

    it('should export every page with its own redactions applied', async () => {
      // Page 1: one active command (a second one undone)
      historyStore.push(rect);
      historyStore.push(rect);
      historyStore.undo();
      await documentStore.goToPage(1);
      // Page 2: no redactions; now on page 2 with a live edit
      await documentStore.goToPage(2);
      imageStore.updateCurrent(makeImage(99));

      const progress = vi.fn();
      const blob = await documentStore.exportPdf(progress);

      expect(blob.type).toBe('application/pdf');
      const pages = pdfMock.buildImagePdf.mock.calls[0][0];
      expect(pages).toHaveLength(3);
      expect(pages.map((p) => p.jpeg[0])).toEqual([201, 2, 99]);
      expect(pages.map((p) => p.width)).toEqual([600, 601, 602]);
      expect(pages[0]).toMatchObject({ pixelWidth: 2, pixelHeight: 2, height: 800 });
      expect(progress).toHaveBeenLastCalledWith(3, 3);
    });

    it('should fail when no PDF is open', async () => {
      await documentStore.close();
      await expect(documentStore.exportPdf()).rejects.toThrow('No PDF');
    });
  });

  describe('close', () => {
    it('should destroy the PDF and reset state', async () => {
      await documentStore.open(pdfFile());
      await documentStore.close();

      expect(source.destroy).toHaveBeenCalled();
      expect(get(documentStore).kind).toBe(null);
      expect(get(isPdf)).toBe(false);
    });
  });
});
