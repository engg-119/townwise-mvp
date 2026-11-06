import { ApiError, createApiClient, upload } from '../../src/api/client';
import { createSecureTokenStore } from '../../src/auth/tokens';
import { fakeFetch, fakeSecureStore, jsonResponse, memoryMarker } from '../helpers/fakes';
import { fakeXhrs, type FakeXhr } from './xhr';

// The upload transport (storage2 15.1): a raw PUT through XMLHttpRequest on web, with progress, the shared
// refresh on 401, the caller's abort and a timeout, and the same error mapping as every request.

const BASE = 'https://api.example.com';
const PATH = '/api/org/locations/l1/files/f1/chunks/0';

afterEach(() => {
  jest.useRealTimers();
});

function cookieClient(onSend: (xhr: FakeXhr) => void) {
  const xhrs = fakeXhrs(onSend);
  const network = fakeFetch(() => jsonResponse(204));
  const client = createApiClient({ baseUrl: BASE, session: { kind: 'cookie' }, fetch: network.fetch, xhr: xhrs.make, onSessionEnded: () => undefined });
  return { client, xhrs, network };
}

function chunk(): Blob {
  return new Blob(['0123456789']);
}

test('PUTs the raw body as application/octet-stream with the cookie, and reports bytes sent', async () => {
  const seen: number[] = [];
  const { client, xhrs } = cookieClient((xhr) => {
    xhr.progress(4);
    xhr.progress(10);
    xhr.respond(200, { index: 0, receivedBytes: 10, chunksReceived: 1 });
  });
  const body = chunk();
  const res = await upload(client, PATH, body, { onProgress: (loaded) => { seen.push(loaded); } });
  expect(await res.json()).toEqual({ index: 0, receivedBytes: 10, chunksReceived: 1 });
  const [xhr] = xhrs.all;
  expect(xhr?.method).toBe('PUT');
  expect(xhr?.url).toBe(`${BASE}${PATH}`);
  expect(xhr?.withCredentials).toBe(true);
  expect(xhr?.headers['content-type']).toBe('application/octet-stream');
  expect(xhr?.headers.accept).toBe('application/json');
  // No custom header and no Authorization on the cookie session (client/MODULE.md, HTTP contract).
  expect(Object.keys(xhr?.headers ?? {}).sort()).toEqual(['accept', 'content-type']);
  expect(xhr?.body).toBe(body);
  expect(seen).toEqual([4, 10]);
});

test('a 401 refreshes the cookie once and sends the chunk again, its progress from 0', async () => {
  const seen: number[] = [];
  let sends = 0;
  const { client, xhrs, network } = cookieClient((xhr) => {
    sends += 1;
    xhr.progress(10);
    if (sends === 1) xhr.respond(401, { error: 'unauthenticated' });
    else xhr.respond(200, { index: 0, receivedBytes: 10, chunksReceived: 1 });
  });
  await upload(client, PATH, chunk(), { onProgress: (loaded) => { seen.push(loaded); } });
  expect(xhrs.all).toHaveLength(2);
  expect(network.calls.map((call) => new URL(call.url).pathname)).toEqual(['/auth/refresh']);
  expect(seen).toEqual([10, 10]);
});

test('the caller’s signal aborts the request as ApiError aborted', async () => {
  const controller = new AbortController();
  const { client, xhrs } = cookieClient(() => { controller.abort(); });
  const error = await upload(client, PATH, chunk(), { signal: controller.signal }).then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ kind: 'aborted' });
  expect(xhrs.all[0]?.aborted).toBe(true);
});

test('a request with no answer before the timeout is ApiError timeout, and the request is aborted', async () => {
  jest.useFakeTimers();
  const { client, xhrs } = cookieClient(() => undefined);
  const pending = upload(client, PATH, chunk(), { timeoutMs: 5_000 }).then(() => null, (caught: unknown) => caught);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(await pending).toMatchObject({ kind: 'timeout' });
  expect(xhrs.all[0]?.aborted).toBe(true);
});

test('a dropped connection is ApiError network', async () => {
  const { client } = cookieClient((xhr) => { xhr.fail(); });
  await expect(upload(client, PATH, chunk())).rejects.toMatchObject({ kind: 'network' });
});

test('errors map as every request’s do: a 503 keeps its code and Retry-After, never its message', async () => {
  const { client } = cookieClient((xhr) => { xhr.respond(503, { error: 'uploads_busy', message: 'replica at 12 streams' }, { 'retry-after': '2' }); });
  const error = await upload(client, PATH, chunk()).then(() => null, (caught: unknown) => caught);
  expect(error).toMatchObject({ kind: 'http', status: 503, code: 'uploads_busy', retryAfterSeconds: 2, detail: null });
  expect(error instanceof Error ? error.message : '').not.toContain('replica');
});

test('a 4xx body’s other fields arrive as detail, without its message', async () => {
  const { client } = cookieClient((xhr) => { xhr.respond(409, { error: 'file_duplicate', message: 'Duplicate', fileId: 'f0' }); });
  const error = await upload(client, PATH, chunk()).then(() => null, (caught: unknown) => caught);
  expect(error).toMatchObject({ kind: 'http', status: 409, code: 'file_duplicate', detail: { fileId: 'f0' } });
});

test('a native (bearer) session has no uploads: ApiError unsupported, and no request', async () => {
  const xhrs = fakeXhrs();
  const tokens = createSecureTokenStore({ secureStore: fakeSecureStore({ items: { 'kit.refreshToken': 'rt-1' } }), marker: memoryMarker(true) });
  const client = createApiClient({
    baseUrl: BASE, session: { kind: 'bearer', tokens }, fetch: fakeFetch(() => jsonResponse(200, {})).fetch, xhr: xhrs.make, onSessionEnded: () => undefined,
  });
  await tokens.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, tokens.generation());
  await expect(upload(client, PATH, chunk())).rejects.toMatchObject({ kind: 'http', code: 'unsupported' });
  expect(xhrs.all).toHaveLength(0);
});
