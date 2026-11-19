import type { ViewStore } from './dataView';

// dataView.ts's memory on web: this browser's localStorage, read at once so the page opens in the remembered view.
// Every access is wrapped, as the theme switch's is (shell/themeMode.ts): a private window, blocked site data or a full
// store reads as nothing kept and writes nothing, and the page works the same without it.

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readNow(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export const viewStore: ViewStore = {
  readNow,
  read: (key) => Promise.resolve(readNow(key)),
  write(key, value) {
    try {
      storage()?.setItem(key, value);
    } catch {
      // Kept for this page only.
    }
  },
};
