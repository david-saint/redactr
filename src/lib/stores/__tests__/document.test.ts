// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const gifMock = {
  openGif: vi.fn(),
  createGifWriter: vi.fn()
};

// The real module loads WASM; GIF decoding and encoding are tested separately.
vi.mock('../../gif', () => ({
  isGifFile: (file: File) => file.type === 'image/gif',
  playbackDelay: (delay: number) => (delay <= 1 ? 100 : delay * 10),
  openGif: (...args) => gifMock.openGif(...args),
  createGifWriter: (...args) => gifMock.createGifWriter(...args)
}));

// Replaying commands marks the image with the number of active commands, and
// the animation frame they were replayed for (255 when none).
vi.mock('../../redaction', () => ({
  replayCommands: vi.fn((original: ImageData, commands, frame) => {
    const data = new Uint8ClampedArray(original.data);
    data[0] = 200 + commands.length;
    data[1] = frame ?? 255;
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

function createGif(frameCount = 4) {
  return {
    width: 2,
    height: 2,
    frameCount,
    delays: Array.from({ length: frameCount }, (_, i) => (i === 1 ? 0 : 5)),
    repeat: -1,
    renderFrame: vi.fn((index: number) => makeImage(10 + index)),
    destroy: vi.fn()
  };
}

function createWriter() {
  return {
    addFrame: vi.fn(),
    finish: vi.fn(() => new Blob(['GIF89a'], { type: 'image/gif' })),
    abort: vi.fn()
  };
}

const gifFile = () => new File(['GIF89a'], 'loop.gif', { type: 'image/gif' });

describe('documentStore', () => {
  let documentStore: any;
  let isPdf: any;
  let imageStore: any;
  let historyStore: any;
  let settingsStore: any;
  let isGif: any;
  let source: ReturnType<typeof createSource>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    source = createSource();
    pdfMock.openPdf.mockResolvedValue(source);

    ({ documentStore, isPdf, isGif } = await import('../document'));
    ({ imageStore } = await import('../image'));
    ({ historyStore } = await import('../history'));
    ({ settingsStore } = await import('../settings'));
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
  describe('GIFs', () => {
    let gif: ReturnType<typeof createGif>;

    beforeEach(async () => {
      gif = createGif();
      gifMock.openGif.mockResolvedValue(gif);
      await documentStore.open(gifFile());
    });

    it('should open animated GIFs on their first frame', () => {
      const state = get(documentStore);
      expect(state).toMatchObject({ kind: 'gif', frameCount: 4, currentFrame: 0, isPlaying: false });
      expect(get(isGif)).toBe(true);
      expect(get(isPdf)).toBe(false);
      expect(get(imageStore).name).toBe('loop.gif');
      expect(get(imageStore).original.data[0]).toBe(10);
    });

    it('should open single-frame GIFs as plain images', async () => {
      const still = createGif(1);
      gifMock.openGif.mockResolvedValue(still);

      await documentStore.open(gifFile());

      expect(get(documentStore).kind).toBe('image');
      expect(get(imageStore).original.data[0]).toBe(10);
      expect(still.destroy).toHaveBeenCalled();
    });

    it('should destroy the GIF when closing or opening another file', async () => {
      await documentStore.open(pdfFile());
      expect(gif.destroy).toHaveBeenCalled();
      expect(get(isGif)).toBe(false);
    });

    describe('goToFrame', () => {
      it('should show the frame with the redactions replayed for it', () => {
        historyStore.push(rect);
        const id = get(imageStore).id;

        documentStore.goToFrame(2);

        const image = get(imageStore);
        expect(get(documentStore).currentFrame).toBe(2);
        expect(image.original.data[0]).toBe(12);
        expect(image.current.data[0]).toBe(201);
        expect(image.current.data[1]).toBe(2);
        // Same image, so the editor keeps its zoom and pan.
        expect(image.id).toBe(id);
      });

      it('should share one undo history across frames', () => {
        historyStore.push(rect);
        documentStore.goToFrame(3);
        expect(get(historyStore).commands).toHaveLength(1);
      });

      it('should ignore out-of-range and current frames', () => {
        documentStore.goToFrame(-1);
        documentStore.goToFrame(4);
        documentStore.goToFrame(0);
        expect(gif.renderFrame).toHaveBeenCalledTimes(1);
      });
    });

    describe('newRedactionFrames', () => {
      it('should cover every frame by default', () => {
        documentStore.goToFrame(2);
        expect(documentStore.newRedactionFrames()).toBe(null);
      });

      it('should cover only the current frame when chosen', () => {
        settingsStore.setFrameScope('current');
        documentStore.goToFrame(2);
        expect(documentStore.newRedactionFrames()).toEqual({ start: 2, end: 2 });
      });

      it('should not limit redactions in other documents', async () => {
        settingsStore.setFrameScope('current');
        await documentStore.open(pdfFile());
        expect(documentStore.newRedactionFrames()).toBe(null);
      });
    });

    describe('playback', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('should advance frames by their delays and loop', () => {
        vi.useFakeTimers();
        documentStore.play();
        expect(get(documentStore).isPlaying).toBe(true);

        vi.advanceTimersByTime(50); // frame 0: 5/100 s
        expect(get(documentStore).currentFrame).toBe(1);
        vi.advanceTimersByTime(99); // frame 1: a 0 delay plays at 100ms
        expect(get(documentStore).currentFrame).toBe(1);
        vi.advanceTimersByTime(1);
        expect(get(documentStore).currentFrame).toBe(2);
        vi.advanceTimersByTime(100);
        expect(get(documentStore).currentFrame).toBe(0);
      });

      it('should stop when paused or closed', async () => {
        vi.useFakeTimers();
        documentStore.play();
        documentStore.pause();
        vi.advanceTimersByTime(1000);
        expect(get(documentStore)).toMatchObject({ currentFrame: 0, isPlaying: false });

        documentStore.play();
        await documentStore.close();
        vi.advanceTimersByTime(1000);
        expect(get(documentStore).isPlaying).toBe(false);
        expect(gif.renderFrame).toHaveBeenCalledTimes(1);
      });
    });

    describe('exportGif', () => {
      it('should write every frame with its redactions, delays and loop count', async () => {
        const writer = createWriter();
        gifMock.createGifWriter.mockReturnValue(writer);
        historyStore.push(rect);
        historyStore.push(rect);
        historyStore.undo();
        documentStore.goToFrame(2);

        const progress = vi.fn();
        const blob = await documentStore.exportGif(progress);

        expect(blob.type).toBe('image/gif');
        expect(gifMock.createGifWriter).toHaveBeenCalledWith(2, 2, -1);
        const frames = writer.addFrame.mock.calls.map(([image]) => Array.from(image.data.slice(0, 2)));
        expect(frames).toEqual([[201, 0], [201, 1], [201, 2], [201, 3]]);
        expect(writer.addFrame.mock.calls.map(([, delay]) => delay)).toEqual([5, 0, 5, 5]);
        expect(progress).toHaveBeenLastCalledWith(4, 4);
        expect(writer.abort).not.toHaveBeenCalled();
      });

      it('should copy frames as-is when nothing is redacted', async () => {
        const writer = createWriter();
        gifMock.createGifWriter.mockReturnValue(writer);

        await documentStore.exportGif();

        expect(writer.addFrame.mock.calls.map(([image]) => image.data[0])).toEqual([10, 11, 12, 13]);
      });

      it('should release the encoder when a frame fails', async () => {
        const writer = createWriter();
        gifMock.createGifWriter.mockReturnValue(writer);
        gif.renderFrame.mockImplementation((i) => {
          if (i === 2) throw new Error('bad frame');
          return makeImage(10 + i);
        });

        await expect(documentStore.exportGif()).rejects.toThrow('bad frame');
        expect(writer.abort).toHaveBeenCalled();
        expect(writer.finish).not.toHaveBeenCalled();
      });

      it('should fail when no GIF is open', async () => {
        await documentStore.close();
        await expect(documentStore.exportGif()).rejects.toThrow('No GIF');
      });
    });
  });
});
