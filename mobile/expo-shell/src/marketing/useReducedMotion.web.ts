import { useCallback, useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

// Feature-detected: without matchMedia (jsdom, old browsers) no query matches.
function mediaQuery(query: string): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

// Whether a media query matches, kept current as it changes.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = mediaQuery(query);
    if (list === null) return () => undefined;
    list.addEventListener('change', onChange);
    return () => { list.removeEventListener('change', onChange); };
  }, [query]);
  return useSyncExternalStore(subscribe, () => mediaQuery(query)?.matches ?? false, () => false);
}

// Without matchMedia there is no stated preference.
export function useReducedMotion(): boolean {
  return useMediaQuery(QUERY);
}
