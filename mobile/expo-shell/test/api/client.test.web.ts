import { createApiClient } from '../../src/api/client';
import { fakeFetch, jsonResponse } from '../helpers/fakes';

test('cookie session runs refresh and logout inside navigator.locks when available', async () => {
  const request = jest.fn((name: string, fn: () => Promise<unknown>) => fn());
  Object.defineProperty(navigator, 'locks', { configurable: true, writable: true, value: { request } });
  let meCalls = 0;
  const network = fakeFetch((call) => {
    if (new URL(call.url).pathname.endsWith('/auth/refresh') || new URL(call.url).pathname.endsWith('/auth/logout')) return jsonResponse(204);
    meCalls += 1;
    return jsonResponse(meCalls === 1 ? 401 : 200, { error: 'unauthenticated' });
  });
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    session: { kind: 'cookie' },
    fetch: network.fetch,
    onSessionEnded: () => undefined,
  });
  await client.request('/x');
  await client.logout();
  expect(request.mock.calls.map((call) => call[0])).toEqual(['kit-auth-refresh', 'kit-auth-refresh']);
});
