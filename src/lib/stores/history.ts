import { writable, derived, get } from 'svelte/store';

export interface RedactionCommand {
  id: string;
  type: 'rect' | 'brush';
  style: 'solid' | 'pixelate' | 'blur';
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  points: number[] | null;
  brushSize?: number;
  intensity: number;
  color: string;
  timestamp: number;
}

interface HistoryState {
  commands: RedactionCommand[];
  currentIndex: number;
  version: number; // Increments on undo/redo to trigger reactivity
}

const initialState: HistoryState = {
  commands: [],
  currentIndex: -1,
  version: 0
};

function createHistoryStore() {
  const { subscribe, set, update } = writable<HistoryState>(initialState);

  return {
    subscribe,
    push: (command: Omit<RedactionCommand, 'id' | 'timestamp'>) => {
      update(state => {
        const commands = state.commands.slice(0, state.currentIndex + 1);
        const newCommand: RedactionCommand = {
          ...command,
          id: crypto.randomUUID(),
          timestamp: Date.now()
        };
        return {
          commands: [...commands, newCommand],
          currentIndex: commands.length,
          version: state.version + 1
        };
      });
    },
    undo: () => {
      update(state => {
        if (state.currentIndex < 0) return state;
        return {
          ...state,
          currentIndex: state.currentIndex - 1,
          version: state.version + 1
        };
      });
    },
    redo: () => {
      update(state => {
        if (state.currentIndex >= state.commands.length - 1) return state;
        return {
          ...state,
          currentIndex: state.currentIndex + 1,
          version: state.version + 1
        };
      });
    },
    clear: () => set(initialState),
    getActiveCommands: () => {
      const state = get({ subscribe });
      return state.commands.slice(0, state.currentIndex + 1);
    }
  };
}

export const historyStore = createHistoryStore();

export const canUndo = derived(historyStore, $history => $history.currentIndex >= 0);
export const canRedo = derived(
  historyStore,
  $history => $history.currentIndex < $history.commands.length - 1
);
export const activeCommands = derived(
  historyStore,
  $history => $history.commands.slice(0, $history.currentIndex + 1)
);
