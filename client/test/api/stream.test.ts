import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';

import { ApiError, createApiClient } from '../../src/api/client';
import type { SseEvent } from '../../src/api/sse';
import { createSecureTokenStore } from '../../src/auth/tokens';
import { fakeEventStream, fakeFetch, fakeSecureStore, jsonResponse, memoryMarker, requestText, sseText } from '../helpers/fakes';

// jsdom (the web project) has no TextEncoder or TextDecoder; browsers, Node and the native runtime do.
if (typeof globalThis.TextEncoder !== 'function') globalThis.TextEncoder = NodeTextEncoder;
if (typeof globalThis.TextDecoder !== 'function') globalThis.TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;

const BASE = 'https://api.example.com';
const TURNS = '/api/org/locations/l1/chat/turns';
const GRANT = { accessToken: 'at-2', accessTokenExpiresAt: '2026-01-01T00:00:00.000Z', refreshToken: 'rt-2' };

afterEach(() => {
  jest.useRealTimers();
});

function isRefresh(url: string): boolean {
  return new URL(url).pathname === '/auth/refresh';
}

async function bearerClient(handler: Parameters<typeof fakeFetch>[0]) {
  const tokens = createSecureTokenStore({ secureStore: fakeSecureStore({ items: { 'kit.refreshToken': 'rt-1' } }), marker: memoryMarker(true) });
  await tokens.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, tokens.generation());
  const network = fakeFetch(handler);
  const client = createApiClient({ baseUrl: BASE, session: { kind: 'bearer', tokens }, fetch: network.fetch, onSessionEnded: () => undefined });
  return { client, network };
}

function cookieClient(handler: Parameters<typeof fakeFetch>[0]) {
  const network = fakeFetch(handler);
  const client = createApiClient({ baseUrl: BASE, session: { kind: 'cookie' }, fetch: network.fetch, onSessionEnded: () => undefined });
  return { client, network };
}

function closedStream(...chunks: string[]): Response {
  const stream = fakeEventStream();
  for (const chunk of chunks) stream.push(chunk);
  stream.close();
  return stream.response;
}

function collect(): { events: SseEvent[]; onEvent: (event: SseEvent) => void } {
  const events: SseEvent[] = [];
  return { events, onEvent: (event) => { events.push(event); } };
}

test('native: POSTs with the bearer token, credentials omit, and asks for an event stream', async () => {
  const { client, network } = await bearerClient(() => closedStream(sseText('text', { delta: 'Hi' }), sseText('done', { stopReason: 'end_turn', costUsd: 0 })));
  const { events, onEvent } = collect();
  await client.stream(TURNS, { body: { content: 'Hello' }, onEvent });
  expect(events).toEqual([
    { event: 'text', data: '{"delta":"Hi"}' },
    { event: 'done', data: '{"stopReason":"end_turn","costUsd":0}' },
  ]);
  const [call] = network.calls;
  const headers = new Headers(call?.init.headers);
  expect(call?.url).toBe(`${BASE}${TURNS}`);
  expect(call?.init.method).toBe('POST');
  expect(call?.init.credentials).toBe('omit');
  expect(headers.get('authorization')).toBe('Bearer at-1');
  expect(headers.get('accept')).toBe('text/event-stream');
  expect(headers.get('content-type')).toBe('application/json');
  expect(JSON.parse(requestText(call?.init.body))).toEqual({ content: 'Hello' });
});

test('web: sends cookies and no Authorization header', async () => {
  const { client, network } = cookieClient(() => closedStream(sseText('done', { stopReason: 'end_turn', costUsd: 0 })));
  await client.stream(TURNS, { body: { content: 'Hello' }, onEvent: () => undefined });
  const headers = new Headers(network.calls[0]?.init.headers);
  expect(network.calls[0]?.init.credentials).toBe('include');
  expect(headers.get('authorization')).toBeNull();
});

test('a 401 before the stream starts refreshes once and retries with the new token', async () => {
  const sent: string[] = [];
  let refreshes = 0;
  const { client } = await bearerClient((call) => {
    if (isRefresh(call.url)) {
      refreshes += 1;
      return jsonResponse(200, GRANT);
    }
    const authorization = new Headers(call.init.headers).get('authorization') ?? '';
    sent.push(authorization);
    return authorization === 'Bearer at-2' ? closedStream(sseText('done', { stopReason: 'end_turn', costUsd: 0 })) : jsonResponse(401, { error: 'unauthenticated' });
  });
  const { events, onEvent } = collect();
  await client.stream(TURNS, { body: { content: 'Hello' }, onEvent });
  expect(sent).toEqual(['Bearer at-1', 'Bearer at-2']);
  expect(refreshes).toBe(1);
  expect(events).toHaveLength(1);
});

test('a web 401 before the stream starts refreshes the cookie once and retries', async () => {
  let turns = 0;
  const { client, network } = cookieClient((call) => {
    if (isRefresh(call.url)) return jsonResponse(204);
    turns += 1;
    return turns === 1 ? jsonResponse(401, { error: 'unauthenticated' }) : closedStream(sseText('done', { stopReason: 'end_turn', costUsd: 0 }));
  });
  await client.stream(TURNS, { body: { content: 'Hello' }, onEvent: () => undefined });
  expect(network.calls.map((call) => new URL(call.url).pathname)).toEqual([TURNS, '/auth/refresh', TURNS]);
});

test('a refusal before the stream starts is the API’s JSON error, mapped as request maps it', async () => {
  const rows: [Response, Partial<ApiError>][] = [
    [jsonResponse(409, { error: 'chat_turn_in_progress' }), { kind: 'http', status: 409, code: 'chat_turn_in_progress' }],
    [jsonResponse(409, { error: 'chat_budget_exhausted' }), { kind: 'http', status: 409, code: 'chat_budget_exhausted' }],
    [jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '120' }), { kind: 'http', status: 429, retryAfterSeconds: 120 }],
    // A 5xx keeps its machine code (503 uploads_busy and files_unavailable need it) but never its message.
    [jsonResponse(503, { error: 'chat_unavailable', message: 'key missing' }), { kind: 'http', status: 503, code: 'chat_unavailable', detail: null }],
  ];
  for (const [response, expected] of rows) {
    const { client } = cookieClient(() => response);
    const onEvent = jest.fn();
    const error = await client.stream(TURNS, { body: { content: 'x' }, onEvent }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject(expected);
    expect(error instanceof Error ? error.message : '').not.toContain('key missing');
    expect(onEvent).not.toHaveBeenCalled();
  }
});

test('a stream that drops after it starts is a network error, keeps the events read, and is not retried', async () => {
  const stream = fakeEventStream();
  const { client, network } = cookieClient(() => stream.response);
  const { events, onEvent } = collect();
  const pending = client.stream(TURNS, { body: { content: 'x' }, onEvent });
  stream.push(sseText('text', { delta: 'Part' }));
  stream.fail(new TypeError('connection reset'));
  await expect(pending).rejects.toMatchObject({ kind: 'network' });
  expect(events).toEqual([{ event: 'text', data: '{"delta":"Part"}' }]);
  expect(network.calls).toHaveLength(1);
});

test('Stop before the headers arrive rejects as aborted, not as a timeout', async () => {
  const { client } = cookieClient(() => new Promise<Response>(() => undefined));
  const controller = new AbortController();
  const pending = client.stream(TURNS, { body: { content: 'x' }, signal: controller.signal, onEvent: () => undefined });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
});

test('Stop after the stream starts cancels the read, rejects as aborted and keeps the events read', async () => {
  const stream = fakeEventStream();
  const { client } = cookieClient(() => stream.response);
  const controller = new AbortController();
  const { events, onEvent } = collect();
  const pending = client.stream(TURNS, { body: { content: 'x' }, signal: controller.signal, onEvent });
  stream.push(sseText('text', { delta: 'Part' }));
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  expect(stream.cancelled).toBe(true);
  expect(events).toEqual([{ event: 'text', data: '{"delta":"Part"}' }]);
});

test('Stop is aborted too when the transport errors the body, as fetch does', async () => {
  const stream = fakeEventStream();
  const { client } = cookieClient((call) => {
    call.init.signal?.addEventListener('abort', () => { stream.fail(new Error('The operation was aborted.')); });
    return stream.response;
  });
  const controller = new AbortController();
  const pending = client.stream(TURNS, { body: { content: 'x' }, signal: controller.signal, onEvent: () => undefined });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
});

test('the request times out while waiting for headers, and never once the stream has started', async () => {
  jest.useFakeTimers({ advanceTimers: false });
  const waiting = cookieClient(() => new Promise<Response>(() => undefined));
  const timedOut = expect(waiting.client.stream(TURNS, { body: { content: 'x' }, onEvent: () => undefined })).rejects.toMatchObject({ kind: 'timeout' });
  await jest.advanceTimersByTimeAsync(30_000);
  await timedOut;

  const stream = fakeEventStream();
  const open = cookieClient(() => stream.response);
  const { events, onEvent } = collect();
  const pending = open.client.stream(TURNS, { body: { content: 'x' }, onEvent });
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  stream.push(sseText('done', { stopReason: 'end_turn', costUsd: 0 }));
  stream.close();
  await pending;
  expect(events).toHaveLength(1);
});

test('a 2xx that is not an event stream is an invalid response', async () => {
  const stream = fakeEventStream({ contentType: 'application/json' });
  const { client } = cookieClient(() => stream.response);
  await expect(client.stream(TURNS, { body: { content: 'x' }, onEvent: () => undefined })).rejects.toMatchObject({ kind: 'invalid_response' });
  expect(stream.cancelled).toBe(true);
});

test('a last event with no blank line after it is discarded when the stream closes', async () => {
  const { client } = cookieClient(() => closedStream('event: done\ndata: {"stopReason":"end_turn","costUsd":0}'));
  const { events, onEvent } = collect();
  await client.stream(TURNS, { body: { content: 'x' }, onEvent });
  expect(events).toEqual([]);
});

test('a character split across chunks decodes whole', async () => {
  const bytes = new TextEncoder().encode(sseText('text', { delta: 'café ☕' }));
  const at = bytes.indexOf(0xe2) + 1;
  const stream = fakeEventStream();
  stream.push(bytes.slice(0, at));
  stream.push(bytes.slice(at));
  stream.close();
  const { client } = cookieClient(() => stream.response);
  const { events, onEvent } = collect();
  await client.stream(TURNS, { body: { content: 'x' }, onEvent });
  expect(events).toEqual([{ event: 'text', data: '{"delta":"café ☕"}' }]);
});

// resumable-chat-turns: a running turn's events are read back with a GET and a cursor.
const TAIL = '/api/org/locations/l1/chat/c1/turns/t1?after=41';

test('a GET stream sends no body and keeps its query, with the same headers, and hands each event its id', async () => {
  const { client, network } = await bearerClient(() => closedStream(
    `id: 42\n${sseText('text', { delta: 'Hi' })}`, `id: 43\n${sseText('done', { stopReason: 'end_turn', costUsd: 0 })}`,
  ));
  const { events, onEvent } = collect();
  await client.stream(TAIL, { method: 'GET', onEvent });
  expect(events).toEqual([
    { event: 'text', data: '{"delta":"Hi"}', id: '42' },
    { event: 'done', data: '{"stopReason":"end_turn","costUsd":0}', id: '43' },
  ]);
  const [call] = network.calls;
  const headers = new Headers(call?.init.headers);
  expect(call?.url).toBe(`${BASE}${TAIL}`);
  expect(call?.init.method).toBe('GET');
  expect(call?.init.body).toBeUndefined();
  expect(call?.init.credentials).toBe('omit');
  expect(headers.get('authorization')).toBe('Bearer at-1');
  expect(headers.get('accept')).toBe('text/event-stream');
  expect(headers.get('content-type')).toBeNull();
});

test('a GET stream refreshes a 401 before it starts, maps a refusal, and stops on its signal', async () => {
  let tails = 0;
  const { client, network } = cookieClient((call) => {
    if (isRefresh(call.url)) return jsonResponse(204);
    tails += 1;
    return tails === 1 ? jsonResponse(401, { error: 'unauthenticated' }) : closedStream(sseText('done', { stopReason: 'end_turn', costUsd: 0 }));
  });
  await client.stream(TAIL, { method: 'GET', onEvent: () => undefined });
  expect(network.calls.map((call) => [call.init.method, new URL(call.url).pathname])).toEqual([
    ['GET', '/api/org/locations/l1/chat/c1/turns/t1'], ['POST', '/auth/refresh'], ['GET', '/api/org/locations/l1/chat/c1/turns/t1'],
  ]);

  const refused = cookieClient(() => jsonResponse(404, { error: 'not_found' }));
  await expect(refused.client.stream(TAIL, { method: 'GET', onEvent: () => undefined })).rejects.toMatchObject({ kind: 'http', status: 404, code: 'not_found' });

  const stream = fakeEventStream();
  const open = cookieClient(() => stream.response);
  const controller = new AbortController();
  const { events, onEvent } = collect();
  const pending = open.client.stream(TAIL, { method: 'GET', signal: controller.signal, onEvent });
  stream.push(`id: 42\n${sseText('text', { delta: 'Part' })}`);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  expect(stream.cancelled).toBe(true);
  expect(events).toEqual([{ event: 'text', data: '{"delta":"Part"}', id: '42' }]);
});
