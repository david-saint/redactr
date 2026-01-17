import { writable } from 'svelte/store';

export type Tool = 'hand' | 'rect' | 'brush';
export type RedactTool = 'rect' | 'brush';
export type RedactionStyle = 'solid' | 'pixelate' | 'blur';

export interface Settings {
  tool: Tool;
  lastRedactTool: RedactTool; // Remember last used redact tool for V shortcut
  style: RedactionStyle;
  intensity: number; // 1-100, maps to block size or blur radius
  brushSize: number; // 5-100px
  fillColor: string; // For solid fill
}

const initialSettings: Settings = {
  tool: 'rect',
  lastRedactTool: 'rect',
  style: 'solid',
  intensity: 50,
  brushSize: 20,
  fillColor: '#000000'
};

function createSettingsStore() {
  const { subscribe, set, update } = writable<Settings>(initialSettings);

  return {
    subscribe,
    setTool: (tool: Tool) => update(s => ({
      ...s,
      tool,
      // Track last redact tool when switching to rect/brush
      lastRedactTool: (tool === 'rect' || tool === 'brush') ? tool : s.lastRedactTool
    })),
    switchToHandTool: () => update(s => ({ ...s, tool: 'hand' })),
    switchToRedactTool: () => update(s => ({ ...s, tool: s.lastRedactTool })),
    setStyle: (style: RedactionStyle) => update(s => ({ ...s, style })),
    setIntensity: (intensity: number) => update(s => ({ ...s, intensity: Math.max(1, Math.min(100, intensity)) })),
    setBrushSize: (brushSize: number) => update(s => ({ ...s, brushSize: Math.max(5, Math.min(100, brushSize)) })),
    setFillColor: (fillColor: string) => update(s => ({ ...s, fillColor })),
    reset: () => set(initialSettings)
  };
}

export const settingsStore = createSettingsStore();
