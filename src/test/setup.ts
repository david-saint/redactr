import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';

// Polyfill ImageData for jsdom (not available by default)
if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace: PredefinedColorSpace = 'srgb';

    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      widthOrHeight: number,
      heightOrSettings?: number | ImageDataSettings
    ) {
      if (typeof dataOrWidth === 'number') {
        // new ImageData(width, height) or new ImageData(width, height, settings)
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        // new ImageData(data, width) or new ImageData(data, width, height)
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height =
          typeof heightOrSettings === 'number'
            ? heightOrSettings
            : this.data.length / (this.width * 4);
      }
    }
  }
  globalThis.ImageData = ImageDataPolyfill as unknown as typeof ImageData;
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null)
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock
});

// Mock crypto.randomUUID
Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: vi.fn(() => `test-uuid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
  }
});

// Mock URL.createObjectURL and revokeObjectURL
globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
globalThis.URL.revokeObjectURL = vi.fn();

// Reset mocks between tests
beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});
