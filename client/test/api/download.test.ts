import { createApiClient, download } from '../../src/api/client';
import { fakeFetch, jsonResponse } from '../helpers/fakes';

// Downloads (storage2 10): a GET read as a Blob with the session's credentials and the shared refresh; the
// caller's signal stops it before the headers or during the read.

const BASE = 'https://api.example.com';
const PATH = '/api/org/locations/l1/files/f1/clean';

function blobResponse(read: () => Promise<Blob>): Response {
  return { ok: true, status: 200, headers: { get: () => null }, blob: read } as unknown as Response;
}

function client(handler: Parameters<typeof fakeFetch>[0]) {
  const network = fakeFetch(handler);
  return { network, api: createApiClient({ baseUrl: BASE, session: { kind: 'cookie' }, fetch: network.fetch, onSessionEnded: () => undefined }) };
}

test('reads the answer as a Blob with the cookie', async () => {
  const bytes = new Blob(['date,guests,net_sales\r\n']);
  const { api, network } = client(() => blobResponse(() => Promise.resolve(bytes)));
  expect(await download(api, PATH)).toBe(bytes);
  expect(network.calls[0]?.init.credentials).toBe('include');
  expect(network.calls[0]?.init.method).toBe('GET');
});

test('a 401 refreshes once and reads again', async () => {
  let gets = 0;
  const { api, network } = client((call) => {
    if (new URL(call.url).pathname === '/auth/refresh') return jsonResponse(204);
    gets += 1;
    return gets === 1 ? jsonResponse(401, { error: 'unauthenticated' }) : blobResponse(() => Promise.resolve(new Blob(['x'])));
  });
  await download(api, PATH);
  expect(network.calls.map((call) => new URL(call.url).pathname)).toEqual([PATH, '/auth/refresh', PATH]);
});

test('a refusal maps as every request’s does', async () => {
  const { api } = client(() => jsonResponse(403, { error: 'view_as_no_download' }));
  await expect(download(api, PATH)).rejects.toMatchObject({ kind: 'http', status: 403, code: 'view_as_no_download' });
});

test('the signal stops the read after the headers arrived, as ApiError aborted', async () => {
  const controller = new AbortController();
  const { api } = client(() => blobResponse(() => {
    controller.abort();
    return Promise.reject(new Error('The operation was aborted'));
  }));
  await expect(download(api, PATH, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
});

test('a read that breaks off is ApiError network', async () => {
  const { api } = client(() => blobResponse(() => Promise.reject(new TypeError('terminated'))));
  await expect(download(api, PATH)).rejects.toMatchObject({ kind: 'network' });
});
