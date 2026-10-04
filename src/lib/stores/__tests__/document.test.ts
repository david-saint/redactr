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
  exportGif: vi.fn(),
  renderGifThumbnails: vi.fn(),
  trackGif: vi.fn()
};

// The real module loads WASM and workers; those are tested separately.
vi.mock('../../gif', () => ({
  isGifFile: (file: File) => file.type === 'image/gif',
  playbackDelay: (delay: number) => (delay <= 1 ? 100 : delay * 10),
  openGif: (...args) => gifMock.openGif(...args),
  exportGif: (...args) => gifMock.exportGif(...args),
  renderGifThumbnails: (...args) => gifMock.renderGifThumbnails(...args),
  trackGif: (...args) => gifMock.trackGif(...args),
  GifJobCancelled: class GifJobCancelled extends Error {}
}));

// The mocked module's cancellation error, so cancelled jobs look real.
let GifJobCancelled: any = Error;

/** A worker job the test settles by hand; cancelling rejects it. */
function deferredJob() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
    cancel: vi.fn(() => reject(new GifJobCancelled('cancelled')))
  };
}

// Replaying commands marks the image with the number of active commands, and
// the animation frame they were replayed for (255 when none).
vi.mock('../../redaction', () => ({
  replayCommands: vi.fn((original: ImageData, commands, frame) => {
    const data = new Uint8ClampedArray(original.data);
    data[0] = 200 + commands.length;
    data[1] = frame ?? 255;
    return new ImageData(data, original.width, original.height);
  }),
  commandBounds: (cmd) => cmd.region
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
    bytes: new ArrayBuffer(6),
    width: 2,
    height: 2,
    frameCount,
    delays: Array.from({ length: frameCount }, (_, i) => (i === 1 ? 0 : 5)),
    repeat: -1,
    renderFrame: vi.fn((index: number) => makeImage(10 + index)),
    destroy: vi.fn()
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
  let frameThumbnails: any;
  let trackingStatus: any;
  let source: ReturnType<typeof createSource>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    source = createSource();
    pdfMock.openPdf.mockResolvedValue(source);

    ({ GifJobCancelled } = await import('../../gif'));
    gifMock.renderGifThumbnails.mockImplementation(() => deferredJob());
    ({ documentStore, isPdf, isGif, frameThumbnails, trackingStatus } = await import(
      '../document'
    ));
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

    it('should start each GIF with new redactions covering every frame', async () => {
      settingsStore.setFrameScope('current');
      gifMock.openGif.mockResolvedValue(createGif());

      await documentStore.open(gifFile());

      expect(get(settingsStore).frameScope).toBe('all');
    });

    it('should keep the last of two quickly opened files', async () => {
      // A PDF whose teardown is slow, so the first open is still closing it.
      await documentStore.open(pdfFile());
      let finishDestroy;
      source.destroy.mockImplementationOnce(() => new Promise((r) => (finishDestroy = r)));
      const gifA = createGif();
      const gifB = createGif(3);
      gifMock.openGif.mockImplementation(async (file) => (file.name === 'a.gif' ? gifA : gifB));

      const first = documentStore.open(new File(['GIF89a'], 'a.gif', { type: 'image/gif' }));
      const second = documentStore.open(new File(['GIF89a'], 'b.gif', { type: 'image/gif' }));
      await second;
      finishDestroy();
      await first;

      expect(get(imageStore).name).toBe('b.gif');
      expect(get(documentStore).frameCount).toBe(3);
      expect(gifMock.openGif.mock.calls.map(([f]) => f.name)).not.toContain('a.gif');
      expect(gifB.destroy).not.toHaveBeenCalled();
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

    describe('thumbnails', () => {
      it('should render thumbnails in a worker and collect them', () => {
        const [bytes, count, maxWidth, maxHeight, onThumbnail] =
          gifMock.renderGifThumbnails.mock.calls[0];
        expect(bytes).toBe(gif.bytes);
        expect(count).toBe(4);
        expect([maxWidth, maxHeight]).toEqual([192, 80]);
        expect(get(frameThumbnails).count).toBe(4);

        const thumbnail = { frame: 2, image: makeImage(5) };
        onThumbnail(2, thumbnail);
        onThumbnail(9, thumbnail);

        expect(get(frameThumbnails).items[2]).toBe(thumbnail);
        expect(get(frameThumbnails).items.filter(Boolean)).toHaveLength(1);
      });

      it('should cancel rendering and drop late thumbnails when the GIF closes', async () => {
        const job = gifMock.renderGifThumbnails.mock.results[0].value;
        const onThumbnail = gifMock.renderGifThumbnails.mock.calls[0][4];

        await documentStore.close();
        onThumbnail(0, { frame: 0, image: makeImage(5) });

        expect(job.cancel).toHaveBeenCalled();
        expect(get(frameThumbnails)).toEqual({ count: 0, items: [] });
      });
    });

    describe('tracking', () => {
      const flush = () => new Promise((r) => setTimeout(r, 0));
      const at = (x: number) => ({ x, y: 0, width: 1, height: 1 });
      let jobs;

      beforeEach(() => {
        jobs = [];
        gifMock.trackGif.mockImplementation(() => {
          const job = deferredJob();
          jobs.push(job);
          return job;
        });
      });

      it('should follow a redaction from the frame on screen', async () => {
        documentStore.goToFrame(2);
        const id = historyStore.push(rect);

        documentStore.trackRedaction(id);

        const [bytes, keyframes] = gifMock.trackGif.mock.calls[0];
        expect(bytes).toBe(gif.bytes);
        expect(keyframes).toEqual([{ frame: 2, box: rect.region }]);
        expect(get(trackingStatus).running).toMatchObject({ id });

        const result = { boxes: [null, at(1), at(2), at(3)], scores: [0, 0.9, 1, 0.4] };
        jobs[0].resolve(result);
        await flush();

        const cmd = historyStore.getActiveCommands()[0];
        expect(cmd.track).toEqual({ anchor: rect.region, keyframes, ...result });
        expect(cmd.frames).toEqual({ start: 1, end: 3 });
        expect(get(trackingStatus).running).toBe(null);
      });

      it('should cover every frame when the content never leaves', async () => {
        const id = historyStore.push(rect);
        documentStore.trackRedaction(id);
        jobs[0].resolve({ boxes: [at(0), at(1), at(2), at(3)], scores: [1, 1, 1, 1] });
        await flush();

        expect(historyStore.getActiveCommands()[0].frames ?? null).toBe(null);
      });

      it('should track one redaction at a time, in order', async () => {
        const first = historyStore.push(rect);
        const second = historyStore.push(rect);

        documentStore.trackRedaction(first);
        documentStore.trackRedaction(second);
        expect(gifMock.trackGif).toHaveBeenCalledTimes(1);
        expect(get(trackingStatus).queued).toEqual([second]);

        jobs[0].resolve({ boxes: [at(0), null, null, null], scores: [1, 0, 0, 0] });
        await flush();

        expect(gifMock.trackGif).toHaveBeenCalledTimes(2);
        expect(get(trackingStatus).running.id).toBe(second);
      });

      it('should start a queued track from the frame shown when it was asked for', async () => {
        const first = historyStore.push(rect);
        const second = historyStore.push(rect);
        documentStore.goToFrame(1);
        documentStore.trackRedaction(first);
        documentStore.trackRedaction(second);
        documentStore.goToFrame(3);

        jobs[0].resolve({ boxes: [null, at(1), null, null], scores: [0, 1, 0, 0] });
        await flush();

        expect(gifMock.trackGif.mock.calls[1][1]).toEqual([{ frame: 1, box: rect.region }]);
      });

      it('should report a failure and carry on with the queue', async () => {
        const first = historyStore.push(rect);
        const second = historyStore.push(rect);
        documentStore.trackRedaction(first);
        documentStore.trackRedaction(second);

        jobs[0].reject(new Error('There is no detail under the box to follow'));
        await flush();

        expect(get(trackingStatus).error).toEqual({
          id: first,
          message: 'There is no detail under the box to follow'
        });
        expect(historyStore.getActiveCommands()[0].track ?? null).toBe(null);
        expect(get(trackingStatus).running.id).toBe(second);
      });

      it('should re-track from all keyframes when a box is placed by hand', async () => {
        const id = historyStore.push(rect);
        documentStore.trackRedaction(id);
        jobs[0].resolve({ boxes: [at(0), at(1), at(2), at(3)], scores: [1, 1, 1, 1] });
        await flush();

        documentStore.goToFrame(3);
        documentStore.placeKeyframe(id, at(9));

        expect(gifMock.trackGif.mock.calls[1][1]).toEqual([
          { frame: 0, box: rect.region },
          { frame: 3, box: at(9) }
        ]);
      });

      it('should stop following and keep the frame range', async () => {
        const id = historyStore.push(rect);
        documentStore.trackRedaction(id);
        jobs[0].resolve({ boxes: [null, at(1), at(2), null], scores: [0, 1, 1, 0] });
        await flush();

        documentStore.untrack(id);

        const cmd = historyStore.getActiveCommands()[0];
        expect(cmd.track).toBe(null);
        expect(cmd.frames).toEqual({ start: 1, end: 2 });
      });

      it('should only follow new redactions in the follow scope', () => {
        const id = historyStore.push(rect);
        documentStore.followIfNeeded(id);
        expect(gifMock.trackGif).not.toHaveBeenCalled();

        settingsStore.setFrameScope('follow');
        documentStore.goToFrame(1);
        expect(documentStore.newRedactionFrames()).toEqual({ start: 1, end: 1 });
        documentStore.followIfNeeded(id);
        expect(gifMock.trackGif).toHaveBeenCalledTimes(1);
      });

      it('should cancel tracking and drop the queue when the GIF closes', async () => {
        documentStore.trackRedaction(historyStore.push(rect));
        documentStore.trackRedaction(historyStore.push(rect));

        await documentStore.close();
        await flush();

        expect(jobs[0].cancel).toHaveBeenCalled();
        expect(gifMock.trackGif).toHaveBeenCalledTimes(1);
        expect(get(trackingStatus)).toEqual({ running: null, queued: [], error: null });
      });
    });

    describe('exportGif', () => {
      it('should export in a worker with a snapshot of the active redactions', async () => {
        const blob = new Blob(['GIF89a'], { type: 'image/gif' });
        gifMock.exportGif.mockReturnValue({ promise: Promise.resolve(blob), cancel: vi.fn() });
        historyStore.push(rect);
        historyStore.push(rect);
        historyStore.undo();
        documentStore.play();

        const progress = vi.fn();
        const result = await documentStore.exportGif(progress);

        expect(result).toBe(blob);
        const [bytes, commands, onProgress] = gifMock.exportGif.mock.calls[0];
        expect(bytes).toBe(gif.bytes);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject(rect);
        expect(onProgress).toBe(progress);
        expect(get(documentStore).isPlaying).toBe(false);
      });

      it('should cancel the export when the document closes', async () => {
        const job = deferredJob();
        gifMock.exportGif.mockReturnValue(job);

        const exporting = documentStore.exportGif();
        await documentStore.close();

        expect(job.cancel).toHaveBeenCalled();
        await expect(exporting).rejects.toThrow('cancelled');
      });

      it('should fail when no GIF is open', async () => {
        await documentStore.close();
        await expect(documentStore.exportGif()).rejects.toThrow('No GIF');
      });
    });
  });
});
