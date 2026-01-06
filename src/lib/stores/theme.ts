import { writable } from 'svelte/store';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'redactr-theme';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'system';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function createThemeStore() {
  const { subscribe, set, update } = writable<Theme>(getInitialTheme());

  return {
    subscribe,
    set: (value: Theme) => {
      localStorage.setItem(STORAGE_KEY, value);
      applyTheme(value);
      set(value);
    },
    toggle: () => {
      update(current => {
        const next: Theme = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
        localStorage.setItem(STORAGE_KEY, next);
        applyTheme(next);
        return next;
      });
    },
    init: () => {
      const theme = getInitialTheme();
      applyTheme(theme);
    }
  };
}

export const theme = createThemeStore();
