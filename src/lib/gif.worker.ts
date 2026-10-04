/// <reference lib="webworker" />

/**
 * Runs one GIF job (export or thumbnails) per worker; see `gifJobs.ts`.
 * The worker is terminated by the page when the job ends or is cancelled.
 */

import { initWasm } from './wasm/redactor';
import {
  errorMessage,
  exportFrames,
  renderThumbnails,
  trackFrames,
  type GifJobRequest,
  type GifJobResponse
} from './gifJobs';

declare const self: DedicatedWorkerGlobalScope;

function post(message: GifJobResponse, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<GifJobRequest>) => {
  const request = event.data;
  try {
    await initWasm();

    if (request.type === 'export') {
      const bytes = exportFrames(request.bytes, request.commands, (done, total) =>
        post({ type: 'progress', done, total })
      );
      post({ type: 'exported', bytes }, [bytes.buffer]);
    } else if (request.type === 'track') {
      const result = trackFrames(request.bytes, request.keyframes, (done, total) =>
        post({ type: 'progress', done, total })
      );
      post({ type: 'tracked', result });
    } else {
      renderThumbnails(
        request.bytes,
        request.count,
        request.maxWidth,
        request.maxHeight,
        (index, frame, width, height, data) =>
          post({ type: 'thumbnail', index, frame, width, height, data }, [data.buffer])
      );
    }
    post({ type: 'complete' });
  } catch (e) {
    post({ type: 'error', message: errorMessage(e) });
  }
};
