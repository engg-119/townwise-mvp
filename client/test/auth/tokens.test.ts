import * as SecureStore from 'expo-secure-store';

import { createSecureTokenStore } from '../../src/auth/tokens';
import { fakeSecureStore, memoryMarker } from '../helpers/fakes';

const KEY = 'kit.refreshToken';
const ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;

test('save stores only the refresh token in SecureStore, with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY', async () => {
  const secure = fakeSecureStore();
  const store = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  await store.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, store.generation());
  expect(Object.fromEntries(secure.items)).toEqual({ [KEY]: 'rt-1' });
  expect(secure.calls.length).toBeGreaterThan(0);
  for (const call of secure.calls) {
    expect(call.options).toMatchObject({ keychainAccessible: ACCESSIBLE });
  }
});

test('save after clear writes nothing and returns false', async () => {
  const secure = fakeSecureStore();
  const store = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  const generation = store.generation();
  await store.clear();
  const callsAfterClear = secure.calls.length;
  expect(await store.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, generation)).toBe(false);
  expect(secure.calls.slice(callsAfterClear).some((call) => call.op === 'set')).toBe(false);
  expect(store.getAccess()).toBeNull();
});

test('clear never rejects', async () => {
  const secure = fakeSecureStore({ failWrites: true });
  const store = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  const before = store.generation();
  await expect(store.clear()).resolves.toBeUndefined();
  expect(store.generation()).toBe(before + 1);
});

test('a SecureStore read error rejects as storage and never deletes the token', async () => {
  const secure = fakeSecureStore({ items: { [KEY]: 'rt-1' }, failReads: true });
  const store = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  await expect(store.getRefresh()).rejects.toMatchObject({ kind: 'storage' });
  expect(secure.calls.some((call) => call.op === 'delete')).toBe(false);
  expect(secure.items.get(KEY)).toBe('rt-1');
});

test('save writes the refresh token before exposing the new access token', async () => {
  const secure = fakeSecureStore({ holdWrites: true });
  const store = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  const pending = store.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, store.generation());
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  expect(store.getAccess()).toBeNull();
  secure.release();
  await pending;
  expect(store.getAccess()).toBe('at-1');
});

test('first launch after install clears a leftover refresh token', async () => {
  const secure = fakeSecureStore({ items: { [KEY]: 'rt-old' } });
  const marker = memoryMarker(false);
  const store = createSecureTokenStore({ secureStore: secure, marker });
  await expect(store.getRefresh()).resolves.toBeNull();
  const deletedAt = secure.calls.findIndex((call) => call.op === 'delete' && call.key === KEY);
  const readAt = secure.calls.findIndex((call) => call.op === 'get');
  expect(deletedAt).toBeGreaterThanOrEqual(0);
  expect(readAt).toBeGreaterThan(deletedAt);
  expect(marker.created).toBe(1);
});

test('a later launch keeps the refresh token', async () => {
  const secure = fakeSecureStore({ items: { [KEY]: 'rt-old' } });
  const marker = memoryMarker(true);
  const store = createSecureTokenStore({ secureStore: secure, marker });
  await expect(store.getRefresh()).resolves.toBe('rt-old');
  expect(secure.calls.some((call) => call.op === 'delete')).toBe(false);
  expect(marker.created).toBe(0);
});

test('an install marker that cannot be written at first launch', async () => {
  const secure = fakeSecureStore({ items: { [KEY]: 'rt-old' } });
  const marker = memoryMarker(false, { failCreate: true });
  const store = createSecureTokenStore({ secureStore: secure, marker });
  await expect(store.getRefresh()).rejects.toMatchObject({ kind: 'storage' });
  await expect(store.getRefresh()).rejects.toMatchObject({ kind: 'storage' });
  expect(secure.calls.filter((call) => call.op === 'delete' && call.key === KEY)).toHaveLength(1);
  expect(secure.items.has(KEY)).toBe(false);
  expect(marker.created).toBe(0);
});
