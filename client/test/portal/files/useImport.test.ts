import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { useImport } from '../../../src/portal/files/useImport';
import { ACCESS, meOf, refusal } from '../../helpers/portal';
import { filesFake, importViewOf, LOCATION, type FilesFake } from './fakes';
import { portalWrapper } from './harness';

// useImport's polling (storage 13.1): 2 s while queued or reading, 10 s while open or waiting, none once done,
// paused while the app is in the background, 10 s after an error, and Refresh at once.

let fake: FilesFake;
let appState: AppStateStatus = 'active';
let appListeners: ((state: AppStateStatus) => void)[] = [];

const reads = (path = '/imports/i1'): number => fake.calls.filter((call) => call.method === 'GET' && call.path === path).length;
const advance = (ms: number): Promise<void> => act(() => jest.advanceTimersByTimeAsync(ms));

function setApp(state: AppStateStatus): void {
  appState = state;
  for (const listener of appListeners) listener(state);
}

beforeEach(() => {
  jest.useFakeTimers();
  fake = filesFake();
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

async function mount(importId = 'i1') {
  const hook = await renderHook(() => useImport(LOCATION, importId), { wrapper: portalWrapper(fake, meOf(ACCESS.admin)) });
  await advance(0);
  return hook;
}

test('every 2 s while reading, every 10 s while open, and no more once done', async () => {
  fake.imports.i1 = { import: importViewOf('i1', { status: 'reading' }) };
  const { result } = await mount();
  expect(result.current.import?.status).toBe('reading');
  expect(result.current.loading).toBe(false);
  expect(reads()).toBe(1);
  await advance(1999);
  expect(reads()).toBe(1);
  await advance(1);
  expect(reads()).toBe(2);

  fake.imports.i1 = { import: importViewOf('i1', { status: 'waiting' }) };
  await advance(2000);
  expect(reads()).toBe(3);
  await advance(9999);
  expect(reads()).toBe(3);
  fake.imports.i1 = { import: importViewOf('i1', { status: 'done' }) };
  await advance(1);
  expect(reads()).toBe(4);
  expect(result.current.import?.status).toBe('done');
  await advance(60_000);
  expect(reads()).toBe(4);
});

test('a poll due while the app is in the background waits until it is back', async () => {
  fake.imports.i1 = { import: importViewOf('i1', { status: 'queued' }) };
  await mount();
  expect(reads()).toBe(1);
  setApp('background');
  await advance(30_000);
  expect(reads()).toBe(1);
  await act(async () => { setApp('active'); await jest.advanceTimersByTimeAsync(0); });
  expect(reads()).toBe(2);
});

test('after an error the next poll is 10 s later, and the error shows until a poll succeeds', async () => {
  fake.imports.i1 = refusal(503, 'storage_unavailable');
  const { result } = await mount();
  expect(result.current.error).toMatchObject({ status: 503 });
  await advance(9999);
  expect(reads()).toBe(1);
  fake.imports.i1 = { import: importViewOf('i1', { status: 'reading' }) };
  await advance(1);
  expect(reads()).toBe(2);
  expect(result.current.error).toBeNull();
  expect(result.current.import?.status).toBe('reading');
});

test('Refresh reads at once; current with no import reads once and waits for Refresh', async () => {
  const { result } = await mount('current');
  expect(result.current.import).toBeNull();
  expect(result.current.loading).toBe(false);
  await advance(60_000);
  expect(reads('/imports/current')).toBe(1);
  fake.current = { import: importViewOf('i1', { status: 'open' }) };
  await act(async () => { result.current.refresh(); await jest.advanceTimersByTimeAsync(0); });
  expect(reads('/imports/current')).toBe(2);
  expect(result.current.import?.id).toBe('i1');
});
