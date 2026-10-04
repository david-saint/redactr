import { writable, derived, get } from 'svelte/store';
import { imageStore } from './image';
import {
  historyStore,
  resolveCommands,
  type Box,
  type FrameRange,
  type HistorySnapshot
} from './history';
import { settingsStore } from './settings';
import { commandBounds, replayCommands } from '../redaction';
import type { Keyframe, TrackResult } from '../gifJobs';
import {
  isGifFile,
  openGif,
  exportGif as exportGifInWorker,
  renderGifThumbnails,
  trackGif,
  playbackDelay,
  GifJobCancelled,
  type FrameThumbnail,
  type GifJob,
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

/** Timeline thumbnails are rendered for at most this many frames... */
const MAX_THUMBNAILS = 120;
/** ...at most this size (CSS pixels, rendered at 2x for sharp displays). */
export const THUMBNAIL_HEIGHT = 40;
const THUMBNAIL_MAX_WIDTH = 96;

/**
 * Thumbnails of evenly spaced frames of the open GIF, filled in as a worker
 * renders them. `count` is how many are coming.
 */
export interface ThumbnailState {
  count: number;
  items: (FrameThumbnail | undefined)[];
}

function createThumbnailStore() {
  const { subscribe, set, update } = writable<ThumbnailState>({ count: 0, items: [] });
  return {
    subscribe,
    reset: (count = 0) => set({ count, items: new Array(count) }),
    add: (index: number, thumbnail: FrameThumbnail) =>
      update(s => {
        if (index < 0 || index >= s.count) return s;
        const items = s.items.slice();
        items[index] = thumbnail;
        return { ...s, items };
      })
  };
}

export const frameThumbnails = createThumbnailStore();

/** Progress of the tracking job running for a redaction, and the last failure. */
export interface TrackingStatus {
  running: { id: string; done: number; total: number } | null;
  /** Redactions waiting their turn. */
  queued: string[];
  error: { id: string; message: string } | null;
}

const idleTracking: TrackingStatus = { running: null, queued: [], error: null };

export const trackingStatus = writable<TrackingStatus>(idleTracking);

/**
 * Set to a redaction's id while the user draws where it belongs on the frame
 * on screen; the next rectangle drawn becomes that redaction's keyframe.
 */
export const boxPlacement = writable<string | null>(null);

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
  // Redactions waiting to be tracked, with the keyframes to track from.
  let trackQueue: { id: string; keyframes?: Keyframe[] }[] = [];
  let trackJob: GifJob<TrackResult> | null = null;
  // Worker jobs for the open GIF, cancelled when it closes.
  const jobs = new Set<GifJob<unknown>>();

  function track<T>(job: GifJob<T>): GifJob<T> {
    jobs.add(job);
    job.promise.then(
      () => jobs.delete(job),
      () => jobs.delete(job)
    );
    return job;
  }

  async function close() {
    token++;
    await teardown();
  }

  /** Release the open document; callers bump `token` first. */
  async function teardown() {
    stopTimer();
    boxPlacement.set(null);
    trackQueue = [];
    trackingStatus.set(idleTracking);
    for (const job of jobs) job.cancel();
    jobs.clear();
    frameThumbnails.reset();
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
    // A "This frame" choice from a previous GIF must not silently carry over.
    settingsStore.setFrameScope('all');
    set({
      ...initialState,
      kind: 'gif',
      pageCount: 1,
      frameCount: source.frameCount
    });
    loadThumbnails(source);
  }

  function loadThumbnails(source: GifSource) {
    const count = Math.min(source.frameCount, MAX_THUMBNAILS);
    frameThumbnails.reset(count);
    const job = renderGifThumbnails(
      source.bytes,
      count,
      THUMBNAIL_MAX_WIDTH * 2,
      THUMBNAIL_HEIGHT * 2,
      (index, thumbnail) => {
        if (gif === source) frameThumbnails.add(index, thumbnail);
      }
    );
    track(job).promise.catch(e => {
      // Thumbnails are a convenience; the timeline works without them.
      if (!(e instanceof GifJobCancelled)) console.warn('Failed to render thumbnails:', e);
    });
  }

  async function open(file: File) {
    // Claim the token before tearing down: if another open() starts while we
    // wait, it takes over and this one stops.
    const openToken = ++token;
    await teardown();
    if (openToken !== token) return;

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
    // A redaction that will follow its content starts on this frame only,
    // until tracking finds where else it is.
    return { start: state.currentFrame, end: state.currentFrame };
  }

  /** Start following a newly added redaction if the user asked for that. */
  function followIfNeeded(id: string) {
    if (get({ subscribe }).kind === 'gif' && get(settingsStore).frameScope === 'follow') {
      trackRedaction(id);
    }
  }

  function updateTracking(fn: (s: TrackingStatus) => TrackingStatus) {
    trackingStatus.update(fn);
  }

  /**
   * Make a redaction follow the content under it through the animation. With
   * no keyframes, it starts from where it sits on the frame on screen (or
   * re-tracks from its existing keyframes). Jobs run one at a time.
   */
  function trackRedaction(id: string, keyframes?: Keyframe[]) {
    if (!gif || get({ subscribe }).kind !== 'gif') return;
    // A new track starts from the frame on screen now, not when its turn comes.
    if (!keyframes) {
      const cmd = historyStore.getActiveCommands().find(c => c.id === id);
      const bounds = cmd && !cmd.track ? commandBounds(cmd) : null;
      if (bounds) keyframes = [{ frame: get({ subscribe }).currentFrame, box: bounds }];
    }
    trackQueue = [...trackQueue.filter(q => q.id !== id), { id, keyframes }];
    updateTracking(s => ({
      ...s,
      queued: trackQueue.map(q => q.id),
      error: s.error?.id === id ? null : s.error
    }));
    if (!trackJob) void runNextTrack();
  }

  /** Place a redaction's box on the frame on screen by hand, and re-track. */
  function placeKeyframe(id: string, box: Box) {
    const cmd = historyStore.getActiveCommands().find(c => c.id === id);
    if (!cmd) return;
    const frame = get({ subscribe }).currentFrame;
    const existing = cmd.track?.keyframes ?? [];
    trackRedaction(id, [...existing.filter(k => k.frame !== frame), { frame, box }]);
  }

  /** Stop following content; the redaction keeps its frame range. */
  function untrack(id: string) {
    const cmd = historyStore.getActiveCommands().find(c => c.id === id);
    if (!cmd?.track) return;
    trackQueue = trackQueue.filter(q => q.id !== id);
    if (get(trackingStatus).running?.id === id) trackJob?.cancel();
    historyStore.setTrack(id, null, cmd.frames ?? null);
  }

  function cancelTracking() {
    trackQueue = [];
    trackJob?.cancel();
    updateTracking(() => idleTracking);
  }

  async function runNextTrack() {
    const source = gif;
    const next = trackQueue.shift();
    if (!source || !next) {
      updateTracking(s => ({ ...s, running: null, queued: [] }));
      return;
    }
    updateTracking(s => ({
      ...s,
      running: { id: next.id, done: 0, total: 0 },
      queued: trackQueue.map(q => q.id)
    }));

    const cmd = historyStore.getActiveCommands().find(c => c.id === next.id);
    const bounds = cmd && (cmd.track?.anchor ?? commandBounds(cmd));
    if (!cmd || !bounds) {
      void runNextTrack();
      return;
    }
    const keyframes = next.keyframes ??
      cmd.track?.keyframes ?? [{ frame: get({ subscribe }).currentFrame, box: bounds }];

    const job = trackGif(source.bytes, keyframes, (done, total) =>
      updateTracking(s => ({ ...s, running: { id: next.id, done, total } }))
    );
    trackJob = job;
    try {
      const result = await track(job).promise;
      if (gif !== source) return;
      const shown = result.boxes.flatMap((b, i) => (b ? [i] : []));
      const frames =
        shown.length === 0
          ? null
          : shown[0] === 0 && shown[shown.length - 1] === source.frameCount - 1
            ? null
            : { start: shown[0], end: shown[shown.length - 1] };
      historyStore.setTrack(
        next.id,
        { anchor: bounds, keyframes, boxes: result.boxes, scores: result.scores },
        frames
      );
    } catch (e) {
      // A closed GIF's tracking result or failure no longer matters.
      if (gif === source && !(e instanceof GifJobCancelled)) {
        updateTracking(s => ({
          ...s,
          error: { id: next.id, message: e instanceof Error ? e.message : String(e) }
        }));
      }
    } finally {
      if (trackJob === job) trackJob = null;
    }
    // Carry on with the queue unless the GIF was closed meanwhile.
    if (gif === source) void runNextTrack();
  }

  /**
   * Export the GIF with redactions applied to every frame. A worker encodes
   * the file from scratch, keeping only pixels, frame delays and the loop
   * count. `onProgress` is called with the number of frames encoded so far.
   * Closing the document cancels the export.
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
    return track(exportGifInWorker(source.bytes, commands, onProgress)).promise;
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
    followIfNeeded,
    trackRedaction,
    placeKeyframe,
    untrack,
    cancelTracking,
    exportGif
  };
}

export const documentStore = createDocumentStore();

export const isPdf = derived(documentStore, $doc => $doc.kind === 'pdf');

export const isGif = derived(documentStore, $doc => $doc.kind === 'gif');
