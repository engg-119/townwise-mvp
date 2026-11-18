import { forgetChat, lastChatKey, recallChat, rememberChat, RETURN_MS } from '../../src/chat/lastChat';
import { lastChatStore, onPageLeave } from '../../src/chat/lastChatStore.web';

// Back to the same TownwiseAI conversation within 5 minutes (src/chat/lastChat.ts, spec P25 build note, 2026-11-18),
// kept on web in this browser's localStorage: an id and a time per person, location and view-as target, nothing else;
// storage that throws or holds anything else reads as nothing kept.

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

const NOW = Date.parse('2026-11-18T15:00:00.000Z');

test('keys keep the person, the location and the view-as target apart, in the characters a secure store allows', () => {
  const keys = [
    lastChatKey('u1', 'l1', null), lastChatKey('u1', 'l2', null), lastChatKey('u2', 'l1', null), lastChatKey('u1', 'l1', 't1'),
    lastChatKey('u1', 'l1', 't2'), lastChatKey('a.b', 'c', null), lastChatKey('a', 'b.c', null), lastChatKey('u1', 'l1', 'self'),
  ];
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of [...keys, lastChatKey('google|123 4_5', 'l1', 'x/y')]) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
});

test('remembered in localStorage as an id and a time; recalled within 5 minutes, forgotten after', async () => {
  const key = lastChatKey('u1', 'l1', null);
  await rememberChat(lastChatStore, key, 'c1', NOW);
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({ conversationId: 'c1', leftAt: NOW });
  expect(await recallChat(lastChatStore, key, NOW + RETURN_MS)).toBe('c1');
  expect(await recallChat(lastChatStore, key, NOW + RETURN_MS + 1)).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();

  // A new chat forgets it, and so does leaving on one.
  await rememberChat(lastChatStore, key, 'c1', NOW);
  await forgetChat(lastChatStore, key);
  expect(localStorage.getItem(key)).toBeNull();
  await rememberChat(lastChatStore, key, 'c1', NOW);
  await rememberChat(lastChatStore, key, null, NOW);
  expect(localStorage.getItem(key)).toBeNull();
});

test('anything else under the key, or a time ahead of now, reads as nothing kept and is forgotten', async () => {
  const key = lastChatKey('u1', 'l1', null);
  for (const raw of ['not json', 'null', '{"conversationId":"c1"}', '{"conversationId":7,"leftAt":1}', `{"conversationId":"c1","leftAt":${String(NOW + 1000)}}`]) {
    localStorage.setItem(key, raw);
    expect(await recallChat(lastChatStore, key, NOW)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  }
});

test('storage that throws on every call keeps nothing and never fails', async () => {
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
    jest.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('denied'); });
  }
  const key = lastChatKey('u1', 'l1', null);
  await expect(rememberChat(lastChatStore, key, 'c1', NOW)).resolves.toBeUndefined();
  await expect(recallChat(lastChatStore, key, NOW)).resolves.toBeNull();
  await expect(forgetChat(lastChatStore, key)).resolves.toBeUndefined();
});

test('a tab closing or reloading counts as leaving the page', () => {
  const listener = jest.fn();
  const stop = onPageLeave(listener);
  window.dispatchEvent(new Event('pagehide'));
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  window.dispatchEvent(new Event('pagehide'));
  expect(listener).toHaveBeenCalledTimes(1);
});
