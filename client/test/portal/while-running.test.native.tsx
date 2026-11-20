import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { useWhileRunning } from '../../src/portal/hooks';

// D65's running-and-done pattern (openspec change forecast-training-status, design decisions 4 and 10): a re-read
// every 30 seconds only while something runs, paused in the background, 10 seconds after a failed one, and the done
// callback once when the run is seen to end.

let appState: AppStateStatus = 'active';
let appListeners: ((state: AppStateStatus) => void)[] = [];

const advance = (ms: number): Promise<void> => act(() => jest.advanceTimersByTimeAsync(ms));

function setApp(state: AppStateStatus): void {
  appState = state;
  for (const listener of appListeners) listener(state);
}

beforeEach(() => {
  jest.useFakeTimers();
  appState = 'active';
  appListeners = [];
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => appState });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appListeners.push(listener);
    return { remove: () => { appListeners = appListeners.filter((other) => other !== listener); } };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function mount(running: boolean, refresh: () => Promise<unknown>) {
  const onDone = jest.fn();
  const hook = await renderHook((props: { running: boolean }) => { useWhileRunning(props.running, refresh, { onDone }); }, {
    initialProps: { running },
  });
  return { ...hook, onDone };
}

test('re-reads every 30 seconds only while running, and stops when it ends', async () => {
  const refresh = jest.fn(() => Promise.resolve());
  const { rerender } = await mount(true, refresh);
  // Not at once: the page has just read.
  expect(refresh).toHaveBeenCalledTimes(0);
  await advance(29_999);
  expect(refresh).toHaveBeenCalledTimes(0);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  await rerender({ running: false });
  await advance(120_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('no re-read while nothing runs', async () => {
  const refresh = jest.fn(() => Promise.resolve());
  const { onDone } = await mount(false, refresh);
  await advance(300_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

test('a re-read due in the background waits until the app is back', async () => {
  const refresh = jest.fn(() => Promise.resolve());
  await mount(true, refresh);
  setApp('background');
  await advance(90_000);
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => { setApp('active'); await jest.advanceTimersByTimeAsync(0); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('after a failed re-read the next one is 10 seconds later', async () => {
  const refresh = jest.fn((): Promise<void> => Promise.reject(new Error('offline')));
  await mount(true, refresh);
  await advance(30_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  refresh.mockImplementation(() => Promise.resolve());
  await advance(10_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  // Back to the 30 seconds once one succeeds.
  await advance(29_999);
  expect(refresh).toHaveBeenCalledTimes(3);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(4);
});

test('done runs once when a run seen running ends, and never for a run this mount didn’t see', async () => {
  const refresh = jest.fn(() => Promise.resolve());
  const { rerender, onDone } = await mount(true, refresh);
  await rerender({ running: false });
  expect(onDone).toHaveBeenCalledTimes(1);
  await rerender({ running: false });
  await advance(60_000);
  expect(onDone).toHaveBeenCalledTimes(1);
  // Another run, seen running, ends: once more.
  await rerender({ running: true });
  await rerender({ running: false });
  expect(onDone).toHaveBeenCalledTimes(2);

  const idle = await mount(false, refresh);
  await idle.rerender({ running: false });
  expect(idle.onDone).not.toHaveBeenCalled();
});
