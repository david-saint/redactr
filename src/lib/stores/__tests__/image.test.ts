// @ts-nocheck
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';

describe('imageStore', () => {
  let imageStore: any;
  let hasImage: any;
  let mockOnload: (() => void) | null = null;

  beforeEach(async () => {
    vi.resetModules();
    
    // Mock Image class with controllable loading
    class MockImage {
      onload: (() => void) | null = null;
      onerror: ((e: Error) => void) | null = null;
      width = 100;
      height = 100;
      private _src = '';

      get src() {
        return this._src;
      }

      set src(value: string) {
        this._src = value;
        // Store reference to trigger manually
        mockOnload = () => this.onload?.();
        // Trigger immediately for tests
        Promise.resolve().then(() => this.onload?.());
      }
    }
    
    vi.stubGlobal('Image', MockImage);

    const mockContext = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(100 * 100 * 4),
        width: 100,
        height: 100
      }))
    };

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => mockContext
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tag);
    });

    const module = await import('../image');
    imageStore = module.imageStore;
    hasImage = module.hasImage;
    imageStore.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockOnload = null;
  });

  describe('initial state', () => {
    it('should start with null image data', () => {
      const state = get(imageStore);
      expect(state.original).toBeNull();
      expect(state.current).toBeNull();
      expect(state.width).toBe(0);
      expect(state.height).toBe(0);
      expect(state.name).toBe('');
    });

    it('should report hasImage as false initially', () => {
      expect(get(hasImage)).toBe(false);
    });
  });

  describe('load', () => {
    it('should load an image file', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      
      await imageStore.load(file);

      const state = get(imageStore);
      expect(state.original).not.toBeNull();
      expect(state.current).not.toBeNull();
      expect(state.width).toBe(100);
      expect(state.height).toBe(100);
      expect(state.name).toBe('test.png');
    });

    it('should report hasImage as true after load', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      
      await imageStore.load(file);

      expect(get(hasImage)).toBe(true);
    });

    it('should create separate copies for original and current', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      
      await imageStore.load(file);

      const state = get(imageStore);
      expect(state.original).not.toBe(state.current);
      expect(state.original.data).not.toBe(state.current.data);
    });

    it('should revoke object URL after loading', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      
      await imageStore.load(file);

      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });

    it('should reject on image load error', async () => {
      vi.resetModules();
      
      // Override MockImage to simulate error
      class ErrorImage {
        onload: (() => void) | null = null;
        onerror: ((e: Error) => void) | null = null;
        width = 100;
        height = 100;
        private _src = '';

        get src() {
          return this._src;
        }

        set src(_value: string) {
          Promise.resolve().then(() => this.onerror?.(new Error('Load failed')));
        }
      }
      vi.stubGlobal('Image', ErrorImage);

      const module = await import('../image');
      const store = module.imageStore;

      const file = new File([''], 'invalid.png', { type: 'image/png' });
      
      await expect(store.load(file)).rejects.toThrow('Failed to load image');
    });
  });

  describe('updateCurrent', () => {
    it('should update current image data', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      await imageStore.load(file);

      const newImageData = new ImageData(50, 50);
      imageStore.updateCurrent(newImageData);

      const state = get(imageStore);
      expect(state.current).toBe(newImageData);
    });

    it('should not affect original image data', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      await imageStore.load(file);

      const originalData = get(imageStore).original;
      const newImageData = new ImageData(50, 50);
      imageStore.updateCurrent(newImageData);

      const state = get(imageStore);
      expect(state.original).toBe(originalData);
    });
  });

  describe('reset', () => {
    it('should reset current to a copy of original', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      await imageStore.load(file);

      // Modify current
      const modifiedData = new ImageData(25, 25);
      imageStore.updateCurrent(modifiedData);

      // Reset
      imageStore.reset();

      const state = get(imageStore);
      expect(state.current).not.toBe(state.original);
      expect(state.current.width).toBe(state.width);
      expect(state.current.height).toBe(state.height);
    });

    it('should do nothing if no original image', () => {
      imageStore.reset();
      
      const state = get(imageStore);
      expect(state.original).toBeNull();
      expect(state.current).toBeNull();
    });
  });

  describe('clear', () => {
    it('should reset to initial state', async () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      await imageStore.load(file);

      imageStore.clear();

      const state = get(imageStore);
      expect(state.original).toBeNull();
      expect(state.current).toBeNull();
      expect(state.width).toBe(0);
      expect(state.height).toBe(0);
      expect(state.name).toBe('');
      expect(get(hasImage)).toBe(false);
    });
  });
});
