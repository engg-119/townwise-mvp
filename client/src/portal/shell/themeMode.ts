import { useSyncExternalStore } from 'react';

// The site's one light or dark mode on web, for the public pages and the portal alike (the switch, ThemeToggle, in the
// public header and the portal's top bar). Until the person picks, it follows the system's setting
// (prefers-color-scheme), live: switching the system while the page is open switches the page. A pick is kept in this
// browser's localStorage under "townwise.theme" and from then on wins over the system, on every page and on later
// visits too. A storage that is empty, holds anything else, is missing or throws (a private window, blocked site data)
// means "follow the system"; a pick still holds in memory for the page. Without matchMedia the system counts as dark.
// Native never reads it: the apps stay dark and show no switch. SiteTheme (PortalStyles.web.tsx) puts the mode on
// the page.

export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'townwise.theme';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function stored(): ThemeMode | null {
  try {
    const value = storage()?.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function systemQuery(): MediaQueryList | null {
  try {
    const match = (globalThis as { matchMedia?: (query: string) => MediaQueryList }).matchMedia;
    return typeof match === 'function' ? match(LIGHT_QUERY) : null;
  } catch {
    return null;
  }
}

/** The system's setting now: light when it asks for light, else dark. */
function systemMode(): ThemeMode {
  return systemQuery()?.matches === true ? 'light' : 'dark';
}

/** The person's pick: undefined until storage is first read, then the pick, or null for "follow the system". */
let chosen: ThemeMode | null | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The mode now: the person's pick, or the system's setting. */
export function getThemeMode(): ThemeMode {
  if (chosen === undefined) chosen = stored();
  return chosen ?? systemMode();
}

/** Picks the mode for every page now, and remembers it in this browser when it can. */
export function setThemeMode(mode: ThemeMode): void {
  chosen = mode;
  try {
    storage()?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Kept in memory only.
  }
  notify();
}

// One listener on the system's setting while anything reads the mode. A change re-renders the readers, which read
// getThemeMode again: with no pick it now gives the new system mode; with a pick it gives the same mode, so React
// keeps the render.
let watched: MediaQueryList | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    watched = systemQuery();
    watched?.addEventListener('change', notify);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      watched?.removeEventListener('change', notify);
      watched = null;
    }
  };
}

function serverMode(): ThemeMode {
  return 'dark';
}

/** The current mode, re-rendering when it changes. */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, serverMode);
}

/** Forgets the pick held in memory, so the next read goes to storage again, as a new page load does (tests). */
export function resetThemeMode(): void {
  chosen = undefined;
}
