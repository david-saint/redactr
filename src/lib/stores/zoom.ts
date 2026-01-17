import { writable, derived } from 'svelte/store';

export interface ZoomState {
  zoom: number;       // 1.0 = 100%, multiplier on base scale
  panX: number;       // Pan offset in screen pixels
  panY: number;       // Pan offset in screen pixels
  isPanning: boolean; // True when actively panning
}

// Zoom constraints
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;

const initialState: ZoomState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false
};

function createZoomStore() {
  const { subscribe, set, update } = writable<ZoomState>(initialState);

  return {
    subscribe,

    zoomIn: () => update(s => ({
      ...s,
      zoom: Math.min(MAX_ZOOM, s.zoom + ZOOM_STEP)
    })),

    zoomOut: () => update(s => ({
      ...s,
      zoom: Math.max(MIN_ZOOM, s.zoom - ZOOM_STEP)
    })),

    setZoom: (zoom: number) => update(s => ({
      ...s,
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
    })),

    // Zoom centered on a point (for mouse wheel zoom)
    // centerX, centerY are relative to the container
    zoomAtPoint: (delta: number, centerX: number, centerY: number) => update(s => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom + delta));
      if (newZoom === s.zoom) return s;

      const zoomRatio = newZoom / s.zoom;

      // Adjust pan to keep the point under cursor stable
      // The math: the point at (centerX, centerY) in screen space should stay fixed
      // After zoom, we need to adjust pan so that same image point remains under cursor
      const newPanX = centerX - (centerX - s.panX) * zoomRatio;
      const newPanY = centerY - (centerY - s.panY) * zoomRatio;

      return {
        ...s,
        zoom: newZoom,
        panX: newPanX,
        panY: newPanY
      };
    }),

    pan: (deltaX: number, deltaY: number) => update(s => ({
      ...s,
      panX: s.panX + deltaX,
      panY: s.panY + deltaY
    })),

    setPan: (panX: number, panY: number) => update(s => ({
      ...s,
      panX,
      panY
    })),

    setPanning: (isPanning: boolean) => update(s => ({ ...s, isPanning })),

    reset: () => set(initialState)
  };
}

export const zoomStore = createZoomStore();

// Derived store for zoom percentage display
export const zoomPercent = derived(zoomStore, $zoom => Math.round($zoom.zoom * 100));
