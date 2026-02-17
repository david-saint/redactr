import { writable } from 'svelte/store';

export type Tool = 'hand' | 'rect' | 'brush';
export type RedactTool = 'rect' | 'brush';
export type RedactionStyle = 'solid' | 'pixelate' | 'blur';

export interface Settings {
  tool: Tool;
  lastRedactTool: RedactTool;
  style: RedactionStyle;
  intensity: number;
  brushSize: number;
  fillColor: string;
  eyedropperMode: boolean;
  toolBeforeEyedropper: Tool | null;
}

const initialSettings: Settings = {
  tool: 'rect',
  lastRedactTool: 'rect',
  style: 'solid',
  intensity: 50,
  brushSize: 20,
  fillColor: '#000000',
  eyedropperMode: false,
  toolBeforeEyedropper: null
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
    enterEyedropperMode: () => update(s => ({
      ...s,
      eyedropperMode: true,
      toolBeforeEyedropper: s.tool
    })),
    exitEyedropperMode: () => update(s => ({
      ...s,
      eyedropperMode: false,
      tool: s.toolBeforeEyedropper ?? s.tool
    })),
    cancelEyedropperMode: () => update(s => ({
      ...s,
      eyedropperMode: false
    })),
    reset: () => set(initialSettings)
  };
}

export const settingsStore = createSettingsStore();
