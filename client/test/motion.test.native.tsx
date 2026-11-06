import * as SecureStore from 'expo-secure-store';
import { AccessibilityInfo } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { useReducedMotion } from '../src/motion';

jest.mock('expo-secure-store');

afterEach(() => {
  jest.restoreAllMocks();
});

// A stand-in for the system's Reduce Motion setting: its first answer, and later changes.
function system(answer: Promise<boolean>) {
  const listeners: ((value: boolean) => void)[] = [];
  const remove = jest.fn();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(answer);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'reduceMotionChanged') listeners.push(listener);
    return { remove };
  });
  return {
    change: (value: boolean) => { for (const listener of listeners) listener(value); },
    listeners,
    remove,
  };
}

test.each([true, false])('null until the system answers, then its answer (%s)', async (setting) => {
  const answer = Promise.withResolvers<boolean>();
  system(answer.promise);
  const { result } = await renderHook(() => useReducedMotion());
  expect(result.current).toBeNull();
  await act(async () => { answer.resolve(setting); await answer.promise; });
  expect(result.current).toBe(setting);
});

test('follows the Reduce Motion setting as it changes, and stops listening on unmount', async () => {
  const fake = system(Promise.resolve(false));
  const { result, unmount } = await renderHook(() => useReducedMotion());
  await act(async () => { await Promise.resolve(); });
  expect(result.current).toBe(false);
  await act(() => { fake.change(true); });
  expect(result.current).toBe(true);
  await act(() => { fake.change(false); });
  expect(result.current).toBe(false);
  expect(fake.listeners).toHaveLength(1);
  expect(fake.remove).not.toHaveBeenCalled();
  await unmount();
  expect(fake.remove).toHaveBeenCalledTimes(1);
});

test('a change that arrives before the first answer wins over that older answer', async () => {
  const answer = Promise.withResolvers<boolean>();
  const fake = system(answer.promise);
  const { result } = await renderHook(() => useReducedMotion());
  await act(() => { fake.change(true); });
  await act(async () => { answer.resolve(false); await answer.promise; });
  expect(result.current).toBe(true);
});

test('if the system cannot answer, it settles on reduced instead of staying unknown', async () => {
  const answer = Promise.withResolvers<boolean>();
  system(answer.promise);
  const { result } = await renderHook(() => useReducedMotion());
  await act(async () => { answer.reject(new Error('no accessibility module')); await answer.promise.catch(() => undefined); });
  expect(result.current).toBe(true);
});

test('an answer after unmount changes nothing', async () => {
  const answer = Promise.withResolvers<boolean>();
  system(answer.promise);
  const { result, unmount } = await renderHook(() => useReducedMotion());
  await unmount();
  await act(async () => { answer.resolve(true); await answer.promise; });
  expect(result.current).toBeNull();
});

test('reads the setting and stores nothing', async () => {
  const fake = system(Promise.resolve(true));
  const { unmount } = await renderHook(() => useReducedMotion());
  await act(async () => { await Promise.resolve(); });
  await act(() => { fake.change(false); });
  await unmount();
  const store = Object.values(SecureStore).filter((value) => jest.isMockFunction(value));
  expect(store).toContain(SecureStore.setItemAsync);
  for (const fn of store) expect(fn).not.toHaveBeenCalled();
});
