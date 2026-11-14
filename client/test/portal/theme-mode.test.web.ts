import { act, renderHook } from '@testing-library/react';

import { getThemeMode, resetThemeMode, setThemeMode, THEME_STORAGE_KEY, useThemeMode } from '../../src/portal/shell/themeMode';

// The light or dark mode (src/portal/shell/themeMode.ts): until the person picks, the system's setting
// (prefers-color-scheme), live; a pick is kept in this browser's localStorage under "townwise.theme" and from then on
// wins over the system, on later visits too. Storage that is empty, holds anything else, or throws means "follow the
// system". Without matchMedia the system counts as dark.

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  resetThemeMode();
  Reflect.deleteProperty(window, 'matchMedia');
});

/** As a new page load reads it: nothing in memory, so the first read goes to storage. */
function reload(): void {
  resetThemeMode();
}

/**
 * A system setting the test can flip: window.matchMedia answers '(prefers-color-scheme: light)' with its current
 * value and calls its change listeners when `set` flips it. Every other query (reduced motion) does not match.
 */
function system(initial: 'light' | 'dark'): { set: (next: 'light' | 'dark') => void; listening: () => number } {
  let light = initial === 'light';
  const handlers = new Set<() => void>();
  const list = (query: string): Pick<MediaQueryList, 'media' | 'matches' | 'addEventListener' | 'removeEventListener'> => ({
    media: query,
    get matches() { return query === '(prefers-color-scheme: light)' && light; },
    addEventListener: (_type: string, handler: unknown) => { handlers.add(handler as () => void); },
    removeEventListener: (_type: string, handler: unknown) => { handlers.delete(handler as () => void); },
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: list });
  return {
    set: (next) => {
      light = next === 'light';
      for (const handler of handlers) handler();
    },
    listening: () => handlers.size,
  };
}

test('nothing stored follows the system: light when it asks for light, dark when it asks for dark', () => {
  system('light');
  expect(getThemeMode()).toBe('light');
  system('dark');
  expect(getThemeMode()).toBe('dark');
});

test('without matchMedia (and nothing stored) the system counts as dark', () => {
  expect(getThemeMode()).toBe('dark');
});

test('with nothing picked, the system switching while the page is open switches every reader', () => {
  const os = system('dark');
  const { result, unmount } = renderHook(() => useThemeMode());
  expect(result.current).toBe('dark');
  act(() => { os.set('light'); });
  expect(result.current).toBe('light');
  act(() => { os.set('dark'); });
  expect(result.current).toBe('dark');
  // One listener while anything reads the mode, none after.
  expect(os.listening()).toBe(1);
  unmount();
  expect(os.listening()).toBe(0);
});

test('a pick wins over the system, now and on a later visit, and the system switching no longer moves it', () => {
  const os = system('light');
  const { result } = renderHook(() => useThemeMode());
  expect(result.current).toBe('light');
  act(() => { setThemeMode('dark'); });
  expect(result.current).toBe('dark');
  act(() => { os.set('dark'); os.set('light'); });
  expect(result.current).toBe('dark');
  reload();
  expect(getThemeMode()).toBe('dark');
});

test('a stored pick holds on a later visit, either way, whatever the system says', () => {
  system('light');
  expect(THEME_STORAGE_KEY).toBe('townwise.theme');
  localStorage.setItem('townwise.theme', 'dark');
  reload();
  expect(getThemeMode()).toBe('dark');
  system('dark');
  localStorage.setItem('townwise.theme', 'light');
  reload();
  expect(getThemeMode()).toBe('light');
});

test('a stored value that is not a mode is ignored: the system decides', () => {
  system('light');
  localStorage.setItem('townwise.theme', 'sepia');
  reload();
  expect(getThemeMode()).toBe('light');
});

test('picking stores the pick and tells every reader', () => {
  const { result } = renderHook(() => useThemeMode());
  expect(result.current).toBe('dark');
  act(() => { setThemeMode('light'); });
  expect(result.current).toBe('light');
  expect(localStorage.getItem('townwise.theme')).toBe('light');
  reload();
  expect(getThemeMode()).toBe('light');
  act(() => { setThemeMode('dark'); });
  expect(result.current).toBe('dark');
  expect(localStorage.getItem('townwise.theme')).toBe('dark');
});

test('storage that throws on every call: the system decides, and a pick still holds for the page', () => {
  system('light');
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  reload();
  expect(getThemeMode()).toBe('light');
  expect(() => { setThemeMode('dark'); }).not.toThrow();
  expect(getThemeMode()).toBe('dark');
});

test('storage that cannot even be reached (blocked site data): the same', () => {
  system('light');
  jest.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
  reload();
  expect(getThemeMode()).toBe('light');
  expect(() => { setThemeMode('dark'); }).not.toThrow();
  expect(getThemeMode()).toBe('dark');
});

test('a matchMedia that throws counts as a dark system', () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => { throw new Error('nope'); } });
  expect(getThemeMode()).toBe('dark');
  const { result } = renderHook(() => useThemeMode());
  expect(result.current).toBe('dark');
});
