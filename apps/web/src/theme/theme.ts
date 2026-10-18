import { create } from 'zustand';
import type { Theme } from './tokens';

// Stored per device, not per user: the night helm phone and the saloon laptop
// want different settings.
const KEY = 'dh.theme';

function load(): Theme {
  try {
    return localStorage.getItem(KEY) === 'night' ? 'night' : 'day';
  } catch {
    return 'day';
  }
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'night' ? '#000000' : '#0E1A22');
}

interface ThemeState {
  theme: Theme;
  setTheme(theme: Theme): void;
  toggle(): void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const initial = load();
  apply(initial);
  return {
    theme: initial,
    setTheme(theme) {
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        // Private mode or blocked storage: the theme still applies for this session.
      }
      apply(theme);
      set({ theme });
    },
    toggle() {
      get().setTheme(get().theme === 'night' ? 'day' : 'night');
    },
  };
});
