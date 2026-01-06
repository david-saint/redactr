import { writable, derived } from 'svelte/store';

export interface ImageState {
  original: ImageData | null;
  current: ImageData | null;
  width: number;
  height: number;
  name: string;
}

const initialState: ImageState = {
  original: null,
  current: null,
  width: 0,
  height: 0,
  name: ''
};

function createImageStore() {
  const { subscribe, set, update } = writable<ImageState>(initialState);

  return {
    subscribe,
    load: async (file: File) => {
      return new Promise<void>((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);

        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, img.width, img.height);

          // Create a copy for current state
          const currentData = new ImageData(
            new Uint8ClampedArray(imageData.data),
            img.width,
            img.height
          );

          set({
            original: imageData,
            current: currentData,
            width: img.width,
            height: img.height,
            name: file.name
          });

          URL.revokeObjectURL(url);
          resolve();
        };

        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to load image'));
        };

        img.src = url;
      });
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
