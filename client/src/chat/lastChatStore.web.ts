import type { LastChatStore } from './lastChat';

// lastChat.ts's memory on web: this browser's localStorage. Every access is wrapped, so a private window, blocked site
// data or a full store reads as nothing kept and writes nothing, and the page works the same without it.

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function attempt<T>(run: (store: Storage) => T, fallback: T): T {
  try {
    const store = storage();
    return store === null ? fallback : run(store);
  } catch {
    return fallback;
  }
}

export const lastChatStore: LastChatStore = {
  read: (key) => Promise.resolve(attempt((store) => store.getItem(key), null)),
  write: (key, value) => Promise.resolve(attempt((store) => { store.setItem(key, value); }, undefined)),
  remove: (key) => Promise.resolve(attempt((store) => { store.removeItem(key); }, undefined)),
};

/** A tab closed or reloaded on the page runs no unmount: `pagehide` stands for it. */
export function onPageLeave(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  window.addEventListener('pagehide', listener);
  return () => { window.removeEventListener('pagehide', listener); };
}
