import { writable, derived, get } from 'svelte/store';
import { imageStore } from './image';
import { historyStore, type HistorySnapshot } from './history';
import { replayCommands } from '../redaction';
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
 */
export interface DocumentState {
  kind: 'image' | 'pdf' | null;
  pageCount: number;
  /** 0-based index of the page shown in the editor. */
  currentPage: number;
  isLoadingPage: boolean;
}

const initialState: DocumentState = {
  kind: null,
  pageCount: 0,
  currentPage: 0,
  isLoadingPage: false
};

function createDocumentStore() {
  const { subscribe, set, update } = writable<DocumentState>(initialState);

  let pdf: PdfSource | null = null;
  let pageHistories: (HistorySnapshot | null)[] = [];
  let fileName = '';
  // Incremented on every navigation/open/close so stale async work is dropped.
  let token = 0;

  async function close() {
    token++;
    const previous = pdf;
    pdf = null;
    pageHistories = [];
    fileName = '';
    set(initialState);
    if (previous) {
      await previous.destroy().catch(() => {});
    }
  }

  async function open(file: File) {
    await close();
    const openToken = token;

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
        kind: 'pdf',
        pageCount: source.pageCount,
        currentPage: 0,
        isLoadingPage: false
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
          ? snapshot.commands.slice(0, snapshot.currentIndex + 1)
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
    exportPdf
  };
}

export const documentStore = createDocumentStore();

export const isPdf = derived(documentStore, $doc => $doc.kind === 'pdf');
