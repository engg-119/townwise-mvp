import { act, renderHook } from '@testing-library/react';

import { useReducedMotion } from '../src/motion';

const QUERY = '(prefers-reduced-motion: reduce)';

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  jest.restoreAllMocks();
});

// jsdom has no matchMedia: a stand-in for the browser's prefers-reduced-motion and its changes.
function browser(initial: boolean) {
  const state = { reduce: initial };
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      queries.push(query);
      return {
        media: query,
        get matches() { return query === QUERY && state.reduce; },
        addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
        removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
      };
    },
  });
  return {
    change: (reduce: boolean) => {
      state.reduce = reduce;
      for (const listener of listeners) listener();
    },
    listeners,
    queries,
  };
}

test('without matchMedia there is no stated preference: false, never null', () => {
  const { result } = renderHook(() => useReducedMotion());
  expect(result.current).toBe(false);
});

test.each([true, false])('known on the first render, never null (%s)', (reduce) => {
  const fake = browser(reduce);
  const { result } = renderHook(() => useReducedMotion());
  expect(result.current).toBe(reduce);
  expect(new Set(fake.queries)).toEqual(new Set([QUERY]));
});

test('follows prefers-reduced-motion as it changes, and stops listening on unmount', () => {
  const fake = browser(false);
  const { result, unmount } = renderHook(() => useReducedMotion());
  act(() => { fake.change(true); });
  expect(result.current).toBe(true);
  act(() => { fake.change(false); });
  expect(result.current).toBe(false);
  expect(fake.listeners.size).toBe(1);
  unmount();
  expect(fake.listeners.size).toBe(0);
});

test('reads the setting and stores nothing', () => {
  const calls = (['getItem', 'setItem', 'removeItem', 'clear'] as const).map((name) => jest.spyOn(Storage.prototype, name));
  const fake = browser(true);
  const { unmount } = renderHook(() => useReducedMotion());
  act(() => { fake.change(false); });
  unmount();
  for (const call of calls) expect(call).not.toHaveBeenCalled();
  expect(document.cookie).toBe('');
});
