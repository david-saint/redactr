// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

// Mock document.documentElement
const mockRoot = {
  setAttribute: vi.fn(),
  removeAttribute: vi.fn()
};

describe('themeStore', () => {
  let theme: any;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    vi.clearAllMocks();
    
    // Mock document.documentElement
    vi.stubGlobal('document', {
      ...document,
      documentElement: mockRoot
    });

    const module = await import('../theme');
    theme = module.theme;
  });

  describe('initial state', () => {
    it('should default to system theme when no stored preference', () => {
      expect(get(theme)).toBe('system');
    });

    it('should load stored light theme preference', async () => {
      localStorage.setItem('redactr-theme', 'light');
      vi.resetModules();
      const module = await import('../theme');
      expect(get(module.theme)).toBe('light');
    });

    it('should load stored dark theme preference', async () => {
      localStorage.setItem('redactr-theme', 'dark');
      vi.resetModules();
      const module = await import('../theme');
      expect(get(module.theme)).toBe('dark');
    });

    it('should load stored system theme preference', async () => {
      localStorage.setItem('redactr-theme', 'system');
      vi.resetModules();
      const module = await import('../theme');
      expect(get(module.theme)).toBe('system');
    });

    it('should default to system for invalid stored value', async () => {
      localStorage.setItem('redactr-theme', 'invalid');
      vi.resetModules();
      const module = await import('../theme');
      expect(get(module.theme)).toBe('system');
    });
  });

  describe('set', () => {
    it('should set theme to light', () => {
      theme.set('light');
      expect(get(theme)).toBe('light');
      expect(localStorage.getItem('redactr-theme')).toBe('light');
    });

    it('should set theme to dark', () => {
      theme.set('dark');
      expect(get(theme)).toBe('dark');
      expect(localStorage.getItem('redactr-theme')).toBe('dark');
    });

    it('should set theme to system', () => {
      theme.set('light');
      theme.set('system');
      expect(get(theme)).toBe('system');
      expect(localStorage.getItem('redactr-theme')).toBe('system');
    });

    it('should apply light theme to document', () => {
      theme.set('light');
      expect(mockRoot.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    });

    it('should apply dark theme to document', () => {
      theme.set('dark');
      expect(mockRoot.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    });

    it('should remove data-theme for system preference', () => {
      theme.set('light');
      mockRoot.removeAttribute.mockClear();
      theme.set('system');
      expect(mockRoot.removeAttribute).toHaveBeenCalledWith('data-theme');
    });
  });

  describe('toggle', () => {
    it('should cycle light -> dark', () => {
      theme.set('light');
      theme.toggle();
      expect(get(theme)).toBe('dark');
    });

    it('should cycle dark -> system', () => {
      theme.set('dark');
      theme.toggle();
      expect(get(theme)).toBe('system');
    });

    it('should cycle system -> light', () => {
      theme.set('system');
      theme.toggle();
      expect(get(theme)).toBe('light');
    });

    it('should persist toggled value to localStorage', () => {
      theme.set('light');
      theme.toggle();
      expect(localStorage.getItem('redactr-theme')).toBe('dark');
    });

    it('should complete full cycle', () => {
      theme.set('light');
      expect(get(theme)).toBe('light');
      
      theme.toggle();
      expect(get(theme)).toBe('dark');
      
      theme.toggle();
      expect(get(theme)).toBe('system');
      
      theme.toggle();
      expect(get(theme)).toBe('light');
    });
  });

  describe('init', () => {
    it('should apply current theme to document', () => {
      theme.set('dark');
      mockRoot.setAttribute.mockClear();
      theme.init();
      expect(mockRoot.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    });

    it('should remove data-theme for system preference', () => {
      theme.set('system');
      mockRoot.removeAttribute.mockClear();
      theme.init();
      expect(mockRoot.removeAttribute).toHaveBeenCalledWith('data-theme');
    });
  });
});
