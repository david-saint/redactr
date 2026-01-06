// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

describe('settingsStore', () => {
  let settingsStore: any;

  beforeEach(async () => {
    vi.resetModules();
    const module = await import('../settings');
    settingsStore = module.settingsStore;
  });

  describe('initial state', () => {
    it('should have correct default values', () => {
      const state = get(settingsStore);
      expect(state.tool).toBe('rect');
      expect(state.style).toBe('solid');
      expect(state.intensity).toBe(50);
      expect(state.brushSize).toBe(20);
      expect(state.fillColor).toBe('#000000');
    });
  });

  describe('setTool', () => {
    it('should change tool to select', () => {
      settingsStore.setTool('select');
      expect(get(settingsStore).tool).toBe('select');
    });

    it('should change tool to rect', () => {
      settingsStore.setTool('brush');
      settingsStore.setTool('rect');
      expect(get(settingsStore).tool).toBe('rect');
    });

    it('should change tool to brush', () => {
      settingsStore.setTool('brush');
      expect(get(settingsStore).tool).toBe('brush');
    });
  });

  describe('setStyle', () => {
    it('should change style to solid', () => {
      settingsStore.setStyle('pixelate');
      settingsStore.setStyle('solid');
      expect(get(settingsStore).style).toBe('solid');
    });

    it('should change style to pixelate', () => {
      settingsStore.setStyle('pixelate');
      expect(get(settingsStore).style).toBe('pixelate');
    });

    it('should change style to blur', () => {
      settingsStore.setStyle('blur');
      expect(get(settingsStore).style).toBe('blur');
    });
  });

  describe('setIntensity', () => {
    it('should set intensity within range', () => {
      settingsStore.setIntensity(75);
      expect(get(settingsStore).intensity).toBe(75);
    });

    it('should clamp intensity to minimum of 1', () => {
      settingsStore.setIntensity(0);
      expect(get(settingsStore).intensity).toBe(1);
      
      settingsStore.setIntensity(-10);
      expect(get(settingsStore).intensity).toBe(1);
    });

    it('should clamp intensity to maximum of 100', () => {
      settingsStore.setIntensity(150);
      expect(get(settingsStore).intensity).toBe(100);
      
      settingsStore.setIntensity(1000);
      expect(get(settingsStore).intensity).toBe(100);
    });

    it('should handle boundary values', () => {
      settingsStore.setIntensity(1);
      expect(get(settingsStore).intensity).toBe(1);
      
      settingsStore.setIntensity(100);
      expect(get(settingsStore).intensity).toBe(100);
    });
  });

  describe('setBrushSize', () => {
    it('should set brush size within range', () => {
      settingsStore.setBrushSize(50);
      expect(get(settingsStore).brushSize).toBe(50);
    });

    it('should clamp brush size to minimum of 5', () => {
      settingsStore.setBrushSize(0);
      expect(get(settingsStore).brushSize).toBe(5);
      
      settingsStore.setBrushSize(3);
      expect(get(settingsStore).brushSize).toBe(5);
      
      settingsStore.setBrushSize(-20);
      expect(get(settingsStore).brushSize).toBe(5);
    });

    it('should clamp brush size to maximum of 100', () => {
      settingsStore.setBrushSize(150);
      expect(get(settingsStore).brushSize).toBe(100);
      
      settingsStore.setBrushSize(500);
      expect(get(settingsStore).brushSize).toBe(100);
    });

    it('should handle boundary values', () => {
      settingsStore.setBrushSize(5);
      expect(get(settingsStore).brushSize).toBe(5);
      
      settingsStore.setBrushSize(100);
      expect(get(settingsStore).brushSize).toBe(100);
    });
  });

  describe('setFillColor', () => {
    it('should set fill color', () => {
      settingsStore.setFillColor('#ff0000');
      expect(get(settingsStore).fillColor).toBe('#ff0000');
    });

    it('should accept various color formats', () => {
      settingsStore.setFillColor('#abc');
      expect(get(settingsStore).fillColor).toBe('#abc');
      
      settingsStore.setFillColor('#aabbcc');
      expect(get(settingsStore).fillColor).toBe('#aabbcc');
      
      settingsStore.setFillColor('rgb(255, 0, 0)');
      expect(get(settingsStore).fillColor).toBe('rgb(255, 0, 0)');
    });
  });

  describe('reset', () => {
    it('should reset all settings to defaults', () => {
      // Change all settings
      settingsStore.setTool('brush');
      settingsStore.setStyle('blur');
      settingsStore.setIntensity(90);
      settingsStore.setBrushSize(80);
      settingsStore.setFillColor('#ffffff');

      // Reset
      settingsStore.reset();

      // Verify defaults
      const state = get(settingsStore);
      expect(state.tool).toBe('rect');
      expect(state.style).toBe('solid');
      expect(state.intensity).toBe(50);
      expect(state.brushSize).toBe(20);
      expect(state.fillColor).toBe('#000000');
    });
  });
});
