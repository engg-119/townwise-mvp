import { ApiError, createApiClient, endsSession } from '../../src/api/client';
import { createSecureTokenStore } from '../../src/auth/tokens';
import { fakeFetch, fakeSecureStore, jsonResponse, memoryMarker, requestText } from '../helpers/fakes';

const BASE = 'https://api.example.com/v1';

beforeEach(() => {
  jest.useRealTimers();
});
const GRANT = { accessToken: 'at-2', accessTokenExpiresAt: '2026-01-01T00:00:00.000Z', refreshToken: 'rt-2' };

function pathname(url: string): string {
  return new URL(url).pathname;
}

function bearerClient(handler: (call: { url: string; init: RequestInit }) => Response | Promise<Response>, opts?: { cold?: boolean; secure?: ReturnType<typeof fakeSecureStore> }) {
  const secure = opts?.secure ?? fakeSecureStore({ items: { 'kit.refreshToken': 'rt-1' } });
  const tokens = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  const network = fakeFetch(handler);
  const onSessionEnded = jest.fn();
  const client = createApiClient({
    baseUrl: BASE,
    session: { kind: 'bearer', tokens },
    fetch: network.fetch,
    onSessionEnded,
  });
  return { client, tokens, secure, network, onSessionEnded };
}

async function seed(tokens: ReturnType<typeof createSecureTokenStore>): Promise<void> {
  await tokens.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, tokens.generation());
}

test('retries a 401 with the refreshed access token, not the one it first sent', async () => {
  const seen: string[] = [];
  const { client, tokens } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) return jsonResponse(200, GRANT);
    const authorization = new Headers(call.init.headers).get('authorization') ?? '';
    seen.push(authorization);
    return jsonResponse(seen.length === 1 ? 401 : 200, { error: 'unauthenticated' });
  });
  await seed(tokens);
  await client.request('/x');
  expect(seen[1]).toBe('Bearer at-2');
});

test('requests waiting on an in-flight refresh retry with the new token', async () => {
  let refreshStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  let release: ((response: Response) => void) | undefined;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  const authorizations: string[] = [];
  const { client, tokens } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) {
      refreshStarted?.();
      return held;
    }
    const authorization = new Headers(call.init.headers).get('authorization') ?? '';
    if (authorization === 'Bearer at-1') return jsonResponse(401, { error: 'unauthenticated' });
    authorizations.push(authorization);
    return jsonResponse(200, {});
  });
  await seed(tokens);
  const pending = Promise.all([client.request('/x'), client.request('/x'), client.request('/x')]);
  await started;
  release?.(jsonResponse(200, GRANT));
  await pending;
  expect(authorizations).toEqual(['Bearer at-2', 'Bearer at-2', 'Bearer at-2']);
});

test('concurrent 401s trigger exactly one refresh', async () => {
  let refreshes = 0;
  const { client, tokens } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) {
      refreshes += 1;
      return jsonResponse(200, GRANT);
    }
    const authorization = new Headers(call.init.headers).get('authorization');
    return jsonResponse(authorization === 'Bearer at-2' ? 200 : 401, {});
  });
  await seed(tokens);
  await Promise.all([client.request('/x'), client.request('/x'), client.request('/x')]);
  expect(refreshes).toBe(1);
});

test('ends the session only on 401 session_ended', async () => {
  expect(endsSession(401, 'session_ended')).toBe(true);
  const rows: { name: string; refresh: () => Response | Promise<Response> }[] = [
    { name: 'session_ended', refresh: () => jsonResponse(401, { error: 'session_ended' }) },
    { name: 'unauthenticated', refresh: () => jsonResponse(401, { error: 'unauthenticated' }) },
    { name: 'non-json', refresh: () => rawResponse(401, 'nope') },
    { name: '400', refresh: () => jsonResponse(400, { error: 'invalid_request' }) },
    { name: 'waf', refresh: () => rawResponse(403, '<html>blocked</html>') },
    { name: 'origin', refresh: () => jsonResponse(403, { error: 'origin_not_allowed' }) },
    { name: '429', refresh: () => jsonResponse(429, { error: 'rate_limited' }) },
    { name: '500', refresh: () => jsonResponse(500, { error: 'internal' }) },
    { name: '502', refresh: () => jsonResponse(502, { error: 'bad_gateway' }) },
    { name: '503', refresh: () => jsonResponse(503, { error: 'unavailable' }) },
    { name: 'network', refresh: () => Promise.reject(new Error('offline')) },
  ];
  for (const row of rows) {
    const { client, tokens, secure, onSessionEnded } = bearerClient((call) => {
      if (pathname(call.url).endsWith('/auth/refresh')) return row.refresh();
      return jsonResponse(401, { error: 'unauthenticated' });
    });
    await seed(tokens);
    const pending = client.request('/x');
    if (row.name === 'session_ended') {
      await expect(pending).rejects.toMatchObject({ kind: 'signed_out' });
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
      expect(secure.items.has('kit.refreshToken')).toBe(false);
    } else {
      await expect(pending).rejects.toBeInstanceOf(ApiError);
      expect(onSessionEnded).not.toHaveBeenCalled();
      expect(secure.items.get('kit.refreshToken')).toBe('rt-1');
    }
  }

  jest.useFakeTimers({ advanceTimers: false });
  try {
    const { client, tokens, secure, onSessionEnded } = bearerClient((call) => {
      if (pathname(call.url).endsWith('/auth/refresh')) return new Promise<Response>(() => undefined);
      return jsonResponse(401, { error: 'unauthenticated' });
    });
    await seed(tokens);
    const pending = client.request('/x');
    const timedOut = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await jest.advanceTimersByTimeAsync(15_000);
    await timedOut;
    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(secure.items.get('kit.refreshToken')).toBe('rt-1');
  } finally {
    jest.useRealTimers();
  }
});

test('a refresh that never answers times out and rejects every waiter', async () => {
  jest.useFakeTimers({ advanceTimers: false });
  try {
    let refreshes = 0;
    const { client, tokens } = bearerClient((call) => {
      if (pathname(call.url).endsWith('/auth/refresh')) {
        refreshes += 1;
        return new Promise<Response>(() => undefined);
      }
      return jsonResponse(401, { error: 'unauthenticated' });
    });
    await seed(tokens);
    const waiters = [client.request('/x'), client.request('/x'), client.request('/x')];
    const timedOut = expect(Promise.all(waiters)).rejects.toMatchObject({ kind: 'timeout' });
    await jest.advanceTimersByTimeAsync(15_000);
    await timedOut;
    const later = client.request('/x');
    const laterTimedOut = expect(later).rejects.toMatchObject({ kind: 'timeout' });
    await jest.advanceTimersByTimeAsync(15_000);
    await laterTimedOut;
    expect(refreshes).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

test('a refresh with no stored refresh token ends the session without a network call', async () => {
  const secure = fakeSecureStore();
  const { client, network } = bearerClient(() => jsonResponse(200, {}), { cold: true, secure });
  await expect(client.request('/x')).rejects.toMatchObject({ kind: 'signed_out' });
  expect(network.calls).toHaveLength(0);
});

test('a failed refresh does not retry the original request', async () => {
  let gets = 0;
  const { client, tokens } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) return jsonResponse(503, { error: 'unavailable', message: 'db password wrong' });
    gets += 1;
    return jsonResponse(401, { error: 'unauthenticated' });
  });
  await seed(tokens);
  await expect(client.request('/x')).rejects.toMatchObject({ kind: 'http', status: 503 });
  expect(gets).toBe(1);
});

test('a second 401 after a refresh is final', async () => {
  let refreshes = 0;
  const { client, tokens } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) {
      refreshes += 1;
      return jsonResponse(200, GRANT);
    }
    return jsonResponse(401, { error: 'unauthenticated' });
  });
  await seed(tokens);
  await expect(client.request('/x')).rejects.toMatchObject({ kind: 'http', status: 401 });
  expect(refreshes).toBe(1);
});

test('Authorization only ever carries the access token', async () => {
  const { client, tokens, network } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) return jsonResponse(200, GRANT);
    const authorization = new Headers(call.init.headers).get('authorization');
    return jsonResponse(authorization === 'Bearer at-2' ? 200 : 401, {});
  });
  await seed(tokens);
  await client.request('/x');
  for (const call of network.calls) {
    const authorization = new Headers(call.init.headers).get('authorization');
    if (authorization !== null) expect(authorization).not.toContain('rt-');
  }
  const refresh = network.calls.find((call) => pathname(call.url).endsWith('/auth/refresh'));
  expect(JSON.parse(requestText(refresh?.init.body))).toEqual({ platform: 'native', refreshToken: 'rt-1' });
});

test('bearer session sends credentials omit; cookie session sends include', async () => {
  const bearer = bearerClient(() => jsonResponse(200, {}));
  await seed(bearer.tokens);
  await bearer.client.request('/x');
  expect(bearer.network.calls[0]?.init.credentials).toBe('omit');

  const network = fakeFetch(() => jsonResponse(200, {}));
  const client = createApiClient({
    baseUrl: BASE,
    session: { kind: 'cookie' },
    fetch: network.fetch,
    onSessionEnded: () => undefined,
  });
  await client.request('/x');
  expect(network.calls[0]?.init.credentials).toBe('include');
});

test('builds URLs by concatenation and never leaves apiUrl', async () => {
  const { client, network, tokens } = bearerClient(() => jsonResponse(200, {}));
  await seed(tokens);
  await expect(client.request('/../admin')).rejects.toThrow(/path leaves apiUrl/);
  expect(network.calls).toHaveLength(0);
  const odd = ['//evil.com/x', '/\\evil.com', '/\t/evil.com', '/\n/evil.com'] as const;
  for (const path of odd) {
    const before = network.calls.length;
    try {
      await client.request(path);
    } catch {
      expect(network.calls).toHaveLength(before);
      continue;
    }
    expect(network.calls).toHaveLength(before + 1);
    const url = new URL(network.calls[before]?.url ?? '');
    expect(url.origin).toBe('https://api.example.com');
    expect(url.pathname.startsWith('/v1/')).toBe(true);
  }
  for (const call of network.calls) expect(new URL(call.url).host).not.toBe('evil.com');
});

test('5xx errors carry a generic message and no server body', async () => {
  const { client, tokens } = bearerClient(() => jsonResponse(500, { error: 'x', message: 'db password wrong' }));
  await seed(tokens);
  const error = await client.request('/x').then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error instanceof Error ? error.message : '').not.toContain('db password');
});

test('a refresh that resolves after signOut leaves SecureStore empty', async () => {
  let release: (response: Response) => void = () => undefined;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  let sawRefresh: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { sawRefresh = resolve; });
  const { client, tokens, secure } = bearerClient((call) => {
    if (pathname(call.url).endsWith('/auth/refresh')) {
      sawRefresh?.();
      return held;
    }
    if (pathname(call.url).endsWith('/auth/logout')) return jsonResponse(204);
    return jsonResponse(401, { error: 'unauthenticated' });
  });
  await seed(tokens);
  const pending = client.request('/x');
  await started;
  await client.logout();
  release(jsonResponse(200, GRANT));
  await expect(pending).rejects.toMatchObject({ kind: 'signed_out' });
  expect(secure.items.size).toBe(0);
  expect(tokens.getAccess()).toBeNull();
});

function rawResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: () => Promise.reject(new SyntaxError('not json')),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}
