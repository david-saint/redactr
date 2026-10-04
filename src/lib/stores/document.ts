import { writable, derived, get } from 'svelte/store';
import { imageStore } from './image';
import {
  historyStore,
  resolveCommands,
  type FrameRange,
  type HistorySnapshot
} from './history';
import { settingsStore } from './settings';
import { replayCommands } from '../redaction';
import {
  isGifFile,
  openGif,
  createGifWriter,
  playbackDelay,
  type GifSource
} from '../gif';
import {
  isPdfFile,
  openPdf,
  buildImagePdf,
  encodeJpeg,
  type PdfSource,
  type PdfImagePage
} from '../pdf';

/**
 * Tracks the opened file. Images are a single page; PDFs have one page loaded
 * into `imageStore`/`historyStore` at a time, with the undo stacks of the other
 * pages kept here so each page can be edited independently.
 *
 * Animated GIFs show one frame at a time, but share a single undo history:
 * each redaction applies to every frame, or to the frame range it was given.
 */
export interface DocumentState {
  kind: 'image' | 'pdf' | 'gif' | null;
  pageCount: number;
  /** 0-based index of the page shown in the editor. */
  currentPage: number;
  isLoadingPage: boolean;
  /** Number of animation frames (GIFs); 0 for other documents. */
  frameCount: number;
  /** 0-based index of the animation frame shown in the editor. */
  currentFrame: number;
  isPlaying: boolean;
}

const initialState: DocumentState = {
  kind: null,
  pageCount: 0,
  currentPage: 0,
  isLoadingPage: false,
  frameCount: 0,
  currentFrame: 0,
  isPlaying: false
};

function createDocumentStore() {
  const { subscribe, set, update } = writable<DocumentState>(initialState);

  let pdf: PdfSource | null = null;
  let gif: GifSource | null = null;
  let pageHistories: (HistorySnapshot | null)[] = [];
  let fileName = '';
  // Incremented on every navigation/open/close so stale async work is dropped.
  let token = 0;
  let playTimer: ReturnType<typeof setTimeout> | null = null;

  async function close() {
    token++;
    stopTimer();
    const previous = pdf;
    pdf = null;
    gif?.destroy();
    gif = null;
    pageHistories = [];
    fileName = '';
    set(initialState);
    if (previous) {
      await previous.destroy().catch(() => {});
    }
  }

  async function openAnimation(file: File, openToken: number) {
    const source = await openGif(file);
    if (openToken !== token) {
      source.destroy();
      return;
    }

    let firstFrame: ImageData;
    try {
      firstFrame = source.renderFrame(0);
    } catch (e) {
      source.destroy();
      throw e;
    }

    imageStore.setImage(firstFrame, file.name);
    historyStore.clear();

    // A single-frame GIF is just an image.
    if (source.frameCount < 2) {
      source.destroy();
      set({ ...initialState, kind: 'image', pageCount: 1 });
      return;
    }

    gif = source;
    fileName = file.name;
    set({
      ...initialState,
      kind: 'gif',
      pageCount: 1,
      frameCount: source.frameCount
    });
  }

  async function open(file: File) {
    await close();
    const openToken = token;

    if (isGifFile(file)) {
      await openAnimation(file, openToken);
      return;
    }

    if (!isPdfFile(file)) {
      await imageStore.load(file);
      historyStore.clear();
      set({ ...initialState, kind: 'image', pageCount: 1 });
      return;
    }

    const source = await openPdf(file);
    try {
      if (source.pageCount === 0) {
        throw new Error('PDF has no pages');
      }
      const firstPage = await source.renderPage(0);
      if (openToken !== token) {
        await source.destroy();
        return;
      }

      pdf = source;
      pageHistories = new Array(source.pageCount).fill(null);
      fileName = file.name;
      imageStore.setImage(firstPage, file.name);
      historyStore.clear();
      set({
        ...initialState,
        kind: 'pdf',
        pageCount: source.pageCount
      });
    } catch (e) {
      await source.destroy().catch(() => {});
      throw e;
    }
  }

  async function goToPage(index: number) {
    const state = get({ subscribe });
    if (
      !pdf ||
      state.kind !== 'pdf' ||
      index < 0 ||
      index >= state.pageCount ||
      index === state.currentPage
    ) {
      return;
    }

    const navToken = ++token;
    const source = pdf;
    update(s => ({ ...s, isLoadingPage: true }));

    let imageData: ImageData;
    try {
      imageData = await source.renderPage(index);
    } catch (e) {
      if (navToken === token) {
        update(s => ({ ...s, isLoadingPage: false }));
      }
      throw e;
    }

    // A newer navigation, or closing the document, supersedes this one.
    if (navToken !== token || pdf !== source) return;

    // Save the outgoing page's edits (including any made while loading).
    const current = get({ subscribe }).currentPage;
    pageHistories[current] = historyStore.snapshot();

    imageStore.setImage(imageData, fileName);
    historyStore.restore(pageHistories[index]);
    update(s => ({ ...s, currentPage: index, isLoadingPage: false }));
  }

  /**
   * Show another frame of the open GIF, with the redactions that apply to it.
   * Out-of-range indices and the current frame are ignored.
   */
  function goToFrame(index: number) {
    const state = get({ subscribe });
    if (
      !gif ||
      state.kind !== 'gif' ||
      index < 0 ||
      index >= state.frameCount ||
      index === state.currentFrame
    ) {
      return;
    }

    const original = gif.renderFrame(index);
    const commands = historyStore.getActiveCommands();
    const current = commands.length
      ? replayCommands(original, commands, index)
      : new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);

    imageStore.setFrame(original, current);
    update(s => ({ ...s, currentFrame: index }));
  }

  function stopTimer() {
    if (playTimer !== null) {
      clearTimeout(playTimer);
      playTimer = null;
    }
  }

  /** Play the animation in a loop, honoring each frame's delay. */
  function play() {
    const state = get({ subscribe });
    if (!gif || state.kind !== 'gif' || state.isPlaying) return;
    update(s => ({ ...s, isPlaying: true }));

    const source = gif;
    const tick = () => {
      const { currentFrame } = get({ subscribe });
      playTimer = setTimeout(() => {
        playTimer = null;
        if (gif !== source || !get({ subscribe }).isPlaying) return;
        try {
          goToFrame((currentFrame + 1) % source.frameCount);
        } catch (e) {
          console.error('Failed to render frame:', e);
          pause();
          return;
        }
        tick();
      }, playbackDelay(source.delays[currentFrame]));
    };
    tick();
  }

  function pause() {
    stopTimer();
    if (get({ subscribe }).isPlaying) {
      update(s => ({ ...s, isPlaying: false }));
    }
  }

  /**
   * Frames a new redaction should cover: null (every frame) unless a GIF is
   * open and the user chose to redact only the frame on screen.
   */
  function newRedactionFrames(): FrameRange | null {
    const state = get({ subscribe });
    if (state.kind !== 'gif' || get(settingsStore).frameScope === 'all') {
      return null;
    }
    return { start: state.currentFrame, end: state.currentFrame };
  }

  /**
   * Export the GIF with redactions applied to every frame. The file is encoded
   * from scratch, keeping only pixels, frame delays and the loop count.
   * `onProgress` is called with the number of frames completed so far.
   */
  async function exportGif(
    onProgress?: (done: number, total: number) => void
  ): Promise<Blob> {
    const source = gif;
    if (!source || get({ subscribe }).kind !== 'gif') {
      throw new Error('No GIF is open');
    }
    pause();

    // A consistent snapshot even if the user keeps editing while this runs.
    const commands = historyStore.getActiveCommands();
    const writer = createGifWriter(source.width, source.height, source.repeat);
    try {
      for (let i = 0; i < source.frameCount; i++) {
        const original = source.renderFrame(i);
        writer.addFrame(
          commands.length ? replayCommands(original, commands, i) : original,
          source.delays[i]
        );
        onProgress?.(i + 1, source.frameCount);

        // Let the UI show progress between frames.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (gif !== source) throw new Error('Document was closed during export');
      }
      return writer.finish();
    } catch (e) {
      writer.abort();
      throw e;
    }
  }

  /**
   * Export every page, with its redactions applied, as a flattened PDF.
   * `onProgress` is called with the number of pages completed so far.
   */
  async function exportPdf(
    onProgress?: (done: number, total: number) => void
  ): Promise<Blob> {
    const source = pdf;
    const state = get({ subscribe });
    if (!source || state.kind !== 'pdf') {
      throw new Error('No PDF document is open');
    }

    // Capture everything up front so the export is a consistent snapshot even
    // if the user keeps editing or changes page while it runs.
    const currentImage = get(imageStore).current;
    if (!currentImage) throw new Error('Current page is not loaded');
    const histories = [...pageHistories];

    const pages: PdfImagePage[] = [];
    for (let i = 0; i < source.pageCount; i++) {
      let imageData: ImageData;

      if (i === state.currentPage) {
        imageData = currentImage;
      } else {
        const original = await source.renderPage(i);
        const snapshot = histories[i];
        const commands = snapshot
          ? resolveCommands(snapshot.commands.slice(0, snapshot.currentIndex + 1))
          : [];
        imageData = commands.length
          ? replayCommands(original, commands)
          : original;
      }

      pages.push({
        jpeg: await encodeJpeg(imageData),
        pixelWidth: imageData.width,
        pixelHeight: imageData.height,
        width: source.pageSizes[i].width,
        height: source.pageSizes[i].height
      });
      onProgress?.(i + 1, source.pageCount);

      if (pdf !== source) throw new Error('Document was closed during export');
    }

    return buildImagePdf(pages);
  }

  return {
    subscribe,
    open,
    close,
    goToPage,
    nextPage: () => goToPage(get({ subscribe }).currentPage + 1),
    prevPage: () => goToPage(get({ subscribe }).currentPage - 1),
    exportPdf,
    goToFrame,
    play,
    pause,
    newRedactionFrames,
    exportGif
  };
}

export const documentStore = createDocumentStore();

export const isPdf = derived(documentStore, $doc => $doc.kind === 'pdf');

export const isGif = derived(documentStore, $doc => $doc.kind === 'gif');
