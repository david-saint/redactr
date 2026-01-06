import { writable } from 'svelte/store';

export type Tool = 'select' | 'rect' | 'brush';
export type RedactionStyle = 'solid' | 'pixelate' | 'blur';

export interface Settings {
  tool: Tool;
  style: RedactionStyle;
  intensity: number; // 1-100, maps to block size or blur radius
  brushSize: number; // 5-100px
  fillColor: string; // For solid fill
}

const initialSettings: Settings = {
  tool: 'rect',
  style: 'solid',
  intensity: 50,
  brushSize: 20,
  fillColor: '#000000'
};

function createSettingsStore() {
  const { subscribe, set, update } = writable<Settings>(initialSettings);

  return {
    subscribe,
    setTool: (tool: Tool) => update(s => ({ ...s, tool })),
    setStyle: (style: RedactionStyle) => update(s => ({ ...s, style })),
    setIntensity: (intensity: number) => update(s => ({ ...s, intensity: Math.max(1, Math.min(100, intensity)) })),
    setBrushSize: (brushSize: number) => update(s => ({ ...s, brushSize: Math.max(5, Math.min(100, brushSize)) })),
    setFillColor: (fillColor: string) => update(s => ({ ...s, fillColor })),
    reset: () => set(initialSettings)
  };
}

export const settingsStore = createSettingsStore();
