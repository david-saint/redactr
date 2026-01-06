// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

describe('historyStore', () => {
  let historyStore: any;
  let canUndo: any;
  let canRedo: any;
  let activeCommands: any;

  beforeEach(async () => {
    vi.resetModules();
    const module = await import('../history');
    historyStore = module.historyStore;
    canUndo = module.canUndo;
    canRedo = module.canRedo;
    activeCommands = module.activeCommands;
  });

  describe('initial state', () => {
    it('should start with empty commands', () => {
      const state = get(historyStore);
      expect(state.commands).toEqual([]);
      expect(state.currentIndex).toBe(-1);
    });

    it('should report canUndo as false initially', () => {
      expect(get(canUndo)).toBe(false);
    });

    it('should report canRedo as false initially', () => {
      expect(get(canRedo)).toBe(false);
    });

    it('should have empty activeCommands initially', () => {
      expect(get(activeCommands)).toEqual([]);
    });
  });

  describe('push', () => {
    it('should add a command to history', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 100, height: 100 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      const state = get(historyStore);
      expect(state.commands.length).toBe(1);
      expect(state.currentIndex).toBe(0);
      expect(state.commands[0].type).toBe('rect');
      expect(state.commands[0].style).toBe('solid');
    });

    it('should assign id and timestamp to command', () => {
      historyStore.push({
        type: 'brush',
        style: 'pixelate',
        region: null,
        points: [10, 20, 30, 40],
        brushSize: 20,
        intensity: 75,
        color: '#ff0000'
      });

      const state = get(historyStore);
      expect(state.commands[0].id).toBeDefined();
      expect(state.commands[0].timestamp).toBeDefined();
      expect(typeof state.commands[0].timestamp).toBe('number');
    });

    it('should increment version on push', () => {
      const initialVersion = get(historyStore).version;
      
      historyStore.push({
        type: 'rect',
        style: 'blur',
        region: { x: 10, y: 10, width: 50, height: 50 },
        points: null,
        intensity: 100,
        color: '#000000'
      });

      expect(get(historyStore).version).toBe(initialVersion + 1);
    });

    it('should truncate future commands when pushing after undo', () => {
      // Push 3 commands
      for (let i = 0; i < 3; i++) {
        historyStore.push({
          type: 'rect',
          style: 'solid',
          region: { x: i * 10, y: 0, width: 10, height: 10 },
          points: null,
          intensity: 50,
          color: '#000000'
        });
      }

      expect(get(historyStore).commands.length).toBe(3);

      // Undo twice
      historyStore.undo();
      historyStore.undo();

      expect(get(historyStore).currentIndex).toBe(0);

      // Push new command - should truncate
      historyStore.push({
        type: 'brush',
        style: 'pixelate',
        region: null,
        points: [100, 100],
        brushSize: 15,
        intensity: 30,
        color: '#00ff00'
      });

      const state = get(historyStore);
      expect(state.commands.length).toBe(2);
      expect(state.currentIndex).toBe(1);
      expect(state.commands[1].type).toBe('brush');
    });

    it('should enable canUndo after push', () => {
      expect(get(canUndo)).toBe(false);
      
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 50, height: 50 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      expect(get(canUndo)).toBe(true);
    });
  });

  describe('undo', () => {
    it('should decrement currentIndex', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 100, height: 100 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      expect(get(historyStore).currentIndex).toBe(0);
      
      historyStore.undo();
      
      expect(get(historyStore).currentIndex).toBe(-1);
    });

    it('should not go below -1', () => {
      historyStore.undo();
      historyStore.undo();
      historyStore.undo();

      expect(get(historyStore).currentIndex).toBe(-1);
    });

    it('should enable canRedo after undo', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 50, height: 50 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      expect(get(canRedo)).toBe(false);
      
      historyStore.undo();
      
      expect(get(canRedo)).toBe(true);
    });

    it('should update activeCommands after undo', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 50, height: 50 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      expect(get(activeCommands).length).toBe(1);
      
      historyStore.undo();
      
      expect(get(activeCommands).length).toBe(0);
    });
  });

  describe('redo', () => {
    it('should increment currentIndex', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 100, height: 100 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      historyStore.undo();
      expect(get(historyStore).currentIndex).toBe(-1);
      
      historyStore.redo();
      expect(get(historyStore).currentIndex).toBe(0);
    });

    it('should not go beyond commands length', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 100, height: 100 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      historyStore.redo();
      historyStore.redo();
      historyStore.redo();

      expect(get(historyStore).currentIndex).toBe(0);
    });

    it('should disable canRedo when at end', () => {
      historyStore.push({
        type: 'rect',
        style: 'solid',
        region: { x: 0, y: 0, width: 50, height: 50 },
        points: null,
        intensity: 50,
        color: '#000000'
      });

      historyStore.undo();
      expect(get(canRedo)).toBe(true);
      
      historyStore.redo();
      expect(get(canRedo)).toBe(false);
    });
  });

  describe('clear', () => {
    it('should reset to initial state', () => {
      // Push some commands
      for (let i = 0; i < 5; i++) {
        historyStore.push({
          type: 'rect',
          style: 'solid',
          region: { x: i * 10, y: 0, width: 10, height: 10 },
          points: null,
          intensity: 50,
          color: '#000000'
        });
      }

      expect(get(historyStore).commands.length).toBe(5);

      historyStore.clear();

      const state = get(historyStore);
      expect(state.commands).toEqual([]);
      expect(state.currentIndex).toBe(-1);
      expect(get(canUndo)).toBe(false);
      expect(get(canRedo)).toBe(false);
    });
  });

  describe('getActiveCommands', () => {
    it('should return commands up to currentIndex', () => {
      for (let i = 0; i < 3; i++) {
        historyStore.push({
          type: 'rect',
          style: 'solid',
          region: { x: i * 10, y: 0, width: 10, height: 10 },
          points: null,
          intensity: 50,
          color: '#000000'
        });
      }

      expect(historyStore.getActiveCommands().length).toBe(3);

      historyStore.undo();
      expect(historyStore.getActiveCommands().length).toBe(2);

      historyStore.undo();
      expect(historyStore.getActiveCommands().length).toBe(1);

      historyStore.undo();
      expect(historyStore.getActiveCommands().length).toBe(0);
    });
  });
});
