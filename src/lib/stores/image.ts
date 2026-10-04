import { writable, derived } from 'svelte/store';
import { isHeicFile, decodeHeic } from '../heic';

export interface ImageState {
  original: ImageData | null;
  current: ImageData | null;
  width: number;
  height: number;
  name: string;
  /**
   * Changes whenever a different image or page is loaded, but not when moving
   * between frames of an animation, so the view (zoom, pan) can be kept.
   */
  id: number;
}

const initialState: ImageState = {
  original: null,
  current: null,
  width: 0,
  height: 0,
  name: '',
  id: 0
};

let nextId = 1;

function decodeImageFile(file: File): Promise<ImageData> {
  return new Promise<ImageData>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);

      URL.revokeObjectURL(url);
      resolve(imageData);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

function createImageStore() {
  const { subscribe, set, update } = writable<ImageState>(initialState);

  /** Replace the loaded image; `current` starts as a copy of `original`. */
  function setImage(imageData: ImageData, name: string) {
    set({
      id: nextId++,
      original: imageData,
      current: new ImageData(
        new Uint8ClampedArray(imageData.data),
        imageData.width,
        imageData.height
      ),
      width: imageData.width,
      height: imageData.height,
      name
    });
  }

  return {
    subscribe,
    setImage,
    /** Show another frame of the same animation, already redacted as `current`. */
    setFrame: (original: ImageData, current: ImageData) => {
      update(state => ({ ...state, original, current }));
    },
    load: async (file: File) => {
      let imageData: ImageData;

      if (isHeicFile(file)) {
        try {
          imageData = await decodeHeic(file);
        } catch {
          // Mislabeled file or unsupported HEIC variant — the browser's
          // native decoder (e.g. Safari) may still handle it.
          imageData = await decodeImageFile(file);
        }
      } else {
        imageData = await decodeImageFile(file);
      }

      setImage(imageData, file.name);
    },
    updateCurrent: (imageData: ImageData) => {
      update(state => ({
        ...state,
        current: imageData
      }));
    },
    reset: () => {
      update(state => {
        if (!state.original) return state;
        return {
          ...state,
          current: new ImageData(
            new Uint8ClampedArray(state.original.data),
            state.width,
            state.height
          )
        };
      });
    },
    clear: () => set(initialState)
  };
}

export const imageStore = createImageStore();

export const hasImage = derived(imageStore, $image => $image.current !== null);
