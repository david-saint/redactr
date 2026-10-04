import { writable, derived, get } from 'svelte/store';

/** Inclusive range of 0-based animation frames. */
export interface FrameRange {
  start: number;
  end: number;
}

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
  /** Frames of an animation this applies to; omitted or null means every frame. */
  frames?: FrameRange | null;
  timestamp: number;
}

/**
 * The redactions in effect for a stack of commands. Editing a redaction (e.g.
 * changing its frame range) pushes a new version with the same id, so the edit
 * can be undone; the latest version takes the original's place in the drawing
 * order.
 */
export function resolveCommands(commands: RedactionCommand[]): RedactionCommand[] {
  const resolved: RedactionCommand[] = [];
  for (const command of commands) {
    const index = resolved.findIndex(c => c.id === command.id);
    if (index >= 0) {
      resolved[index] = command;
    } else {
      resolved.push(command);
    }
  }
  return resolved;
}

interface HistoryState {
  commands: RedactionCommand[];
  currentIndex: number;
  version: number; // Increments on undo/redo to trigger reactivity
}

/** A page's undo/redo stack, saved while another page is being edited. */
export interface HistorySnapshot {
  commands: RedactionCommand[];
  currentIndex: number;
}

function sameFrames(a: FrameRange | null, b: FrameRange | null): boolean {
  if (!a || !b) return a === b;
  return a.start === b.start && a.end === b.end;
}

const initialState: HistoryState = {
  commands: [],
  currentIndex: -1,
  version: 0
};

function createHistoryStore() {
  const { subscribe, set, update } = writable<HistoryState>(initialState);

  function append(command: RedactionCommand) {
    update(state => {
      const commands = state.commands.slice(0, state.currentIndex + 1);
      return {
        commands: [...commands, command],
        currentIndex: commands.length,
        version: state.version + 1
      };
    });
  }

  return {
    subscribe,
    push: (command: Omit<RedactionCommand, 'id' | 'timestamp'>) => {
      append({ ...command, id: crypto.randomUUID(), timestamp: Date.now() });
    },
    /**
     * Change which frames an active redaction applies to, as an undoable step.
     * `frames` of null means every frame.
     */
    setFrames: (id: string, frames: FrameRange | null) => {
      const state = get({ subscribe });
      const target = resolveCommands(
        state.commands.slice(0, state.currentIndex + 1)
      ).find(c => c.id === id);
      if (!target || sameFrames(target.frames ?? null, frames)) return;
      append({ ...target, frames, timestamp: Date.now() });
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
    snapshot: (): HistorySnapshot => {
      const state = get({ subscribe });
      return { commands: state.commands, currentIndex: state.currentIndex };
    },
    restore: (snapshot: HistorySnapshot | null) => {
      // Always bump the version so subscribers rebuild from the new stack.
      update(state => ({
        commands: snapshot ? [...snapshot.commands] : [],
        currentIndex: snapshot ? snapshot.currentIndex : -1,
        version: state.version + 1
      }));
    },
    /** Redactions in effect, with edits resolved. */
    getActiveCommands: () => {
      const state = get({ subscribe });
      return resolveCommands(state.commands.slice(0, state.currentIndex + 1));
    }
  };
}

export const historyStore = createHistoryStore();

export const canUndo = derived(historyStore, $history => $history.currentIndex >= 0);
export const canRedo = derived(
  historyStore,
  $history => $history.currentIndex < $history.commands.length - 1
);
export const activeCommands = derived(historyStore, $history =>
  resolveCommands($history.commands.slice(0, $history.currentIndex + 1))
);

/** The redaction highlighted in the frame timeline and on the canvas. */
export const selectedRedactionId = writable<string | null>(null);
