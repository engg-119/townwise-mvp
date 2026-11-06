// The managed-identity token source every Azure caller shares (api/src/azure-identity.ts), over a fake fetch.
import { ConfigError } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import {
  AzureIdentityError, createManagedIdentityTokenSource, IDENTITY_API_VERSION, resolveManagedIdentity, TOKEN_REFRESH_MARGIN_MS,
  type FetchLike,
} from '../src/azure-identity.ts';

const IDENTITY = {
  endpoint: 'http://localhost:42356/msi/token',
  header: 'identity-header-test-value',
  clientId: '00000000-0000-0000-0000-000000000000',
};
const RESOURCE = 'https://communication.azure.com';
const START = Date.parse('2026-06-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

interface Call { url: URL; init: RequestInit }

function fakeFetch(answer: (call: Call, n: number) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const call = { url: new URL(url), init };
      calls.push(call);
      return Promise.resolve(answer(call, calls.length));
    },
  };
}

function tokenAnswer(token: string, expiresOnMs: number): Response {
  return Response.json({ access_token: token, expires_on: String(Math.floor(expiresOnMs / 1000)), token_type: 'Bearer' });
}

function clock(): { now: () => Date; set: (ms: number) => void } {
  let current = START;
  return { now: () => new Date(current), set: (ms) => { current = ms; } };
}

async function failureOf(run: () => Promise<unknown>): Promise<AzureIdentityError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AzureIdentityError);
    return err as AzureIdentityError;
  }
  return expect.unreachable();
}

describe('resolveManagedIdentity', () => {
  const env = { IDENTITY_ENDPOINT: IDENTITY.endpoint, IDENTITY_HEADER: IDENTITY.header, AZURE_CLIENT_ID: IDENTITY.clientId };

  it('reads the three platform variables', () => {
    expect(resolveManagedIdentity(env, 'EMAIL_ENDPOINT')).toEqual(IDENTITY);
  });

  it('names every missing variable and the feature that needs it, never a value', () => {
    for (const name of ['IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'AZURE_CLIENT_ID'] as const) {
      try {
        resolveManagedIdentity({ ...env, [name]: '' }, 'EMAIL_ENDPOINT');
        expect.unreachable(name);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).problems.map((p) => p.variable)).toEqual([name]);
        expect(String(err)).toContain('EMAIL_ENDPOINT needs the managed identity');
        expect(String(err)).not.toContain(IDENTITY.header);
        expect(String(err)).not.toContain(IDENTITY.clientId);
      }
    }
    expect(() => resolveManagedIdentity({}, 'EMAIL_ENDPOINT')).toThrow(ConfigError);
  });

  it('refuses an endpoint that is not an http or https URL', () => {
    expect(() => resolveManagedIdentity({ ...env, IDENTITY_ENDPOINT: 'not a url' }, 'EMAIL_ENDPOINT')).toThrow(ConfigError);
    expect(() => resolveManagedIdentity({ ...env, IDENTITY_ENDPOINT: 'file:///tmp/token' }, 'EMAIL_ENDPOINT')).toThrow(ConfigError);
  });
});

describe('createManagedIdentityTokenSource', () => {
  it('asks the endpoint for the resource, the 2019-08-01 API and the user-assigned client id, with the identity header', async () => {
    const fake = fakeFetch(() => tokenAnswer('token-one', START + HOUR));
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: clock().now, fetch: fake.fetch });
    expect(await tokens.getToken(RESOURCE)).toEqual({ token: 'token-one', expiresOnTimestamp: START + HOUR });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(`${call?.url.origin ?? ''}${call?.url.pathname ?? ''}`).toBe(IDENTITY.endpoint);
    expect(call?.url.search).toContain('resource=https%3A%2F%2Fcommunication.azure.com');
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      resource: RESOURCE, 'api-version': IDENTITY_API_VERSION, client_id: IDENTITY.clientId,
    });
    expect(IDENTITY_API_VERSION).toBe('2019-08-01');
    expect(call?.init.method).toBe('GET');
    expect(new Headers(call?.init.headers).get('X-IDENTITY-HEADER')).toBe(IDENTITY.header);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts expires_on as a number too', async () => {
    const fake = fakeFetch(() => Response.json({ access_token: 'token-n', expires_on: Math.floor((START + HOUR) / 1000) }));
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: clock().now, fetch: fake.fetch });
    expect((await tokens.getToken(RESOURCE)).expiresOnTimestamp).toBe(START + HOUR);
  });

  it('reuses a token until five minutes before it expires, then fetches a new one', async () => {
    const time = clock();
    const fake = fakeFetch((_, n) => tokenAnswer(`token-${String(n)}`, START + HOUR * n));
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: time.now, fetch: fake.fetch });
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-1');
    time.set(START + HOUR - TOKEN_REFRESH_MARGIN_MS - 1);
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-1');
    expect(fake.calls).toHaveLength(1);
    time.set(START + HOUR - TOKEN_REFRESH_MARGIN_MS);
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-2');
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps one cache per resource', async () => {
    const fake = fakeFetch((call) => tokenAnswer(`for ${call.url.searchParams.get('resource') ?? ''}`, START + HOUR));
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: clock().now, fetch: fake.fetch });
    expect((await tokens.getToken(RESOURCE)).token).toBe(`for ${RESOURCE}`);
    expect((await tokens.getToken('https://storage.azure.com')).token).toBe('for https://storage.azure.com');
    expect((await tokens.getToken(RESOURCE)).token).toBe(`for ${RESOURCE}`);
    expect(fake.calls).toHaveLength(2);
  });

  it('concurrent callers share one request', async () => {
    let answer = (): void => undefined;
    const gate = new Promise<void>((resolve) => { answer = resolve; });
    const fake = fakeFetch(async () => {
      await gate;
      return tokenAnswer('shared', START + HOUR);
    });
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: clock().now, fetch: fake.fetch });
    const both = Promise.all([tokens.getToken(RESOURCE), tokens.getToken(RESOURCE)]);
    answer();
    expect((await both).map((t) => t.token)).toEqual(['shared', 'shared']);
    expect(fake.calls).toHaveLength(1);
  });

  it('invalidate drops the cached token, so the next call fetches', async () => {
    const fake = fakeFetch((_, n) => tokenAnswer(`token-${String(n)}`, START + HOUR));
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: clock().now, fetch: fake.fetch });
    await tokens.getToken(RESOURCE);
    tokens.invalidate(RESOURCE);
    expect((await tokens.getToken(RESOURCE)).token).toBe('token-2');
  });

  it('fails with a code and status, never the body, and caches no failure', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response('{"error":"sentinel body"}', { status: 500 }),
      () => Response.json({ access_token: '', expires_on: '1' }),
      () => Response.json({ token: 'wrong shape' }),
      () => new Response('not json', { status: 200 }),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      () => tokenAnswer('after failures', START + HOUR),
    ];
    const fake = fakeFetch((_, n) => answers[n - 1]?.() ?? new Response(null, { status: 599 }));
    const tokens = createManagedIdentityTokenSource({ identity: IDENTITY, now: clock().now, fetch: fake.fetch });
    const status = await failureOf(() => tokens.getToken(RESOURCE));
    expect({ code: status.code, status: status.status }).toEqual({ code: 'upstream_status', status: 500 });
    expect(String(status)).not.toContain('sentinel');
    expect((await failureOf(() => tokens.getToken(RESOURCE))).code).toBe('bad_response');
    expect((await failureOf(() => tokens.getToken(RESOURCE))).code).toBe('bad_response');
    expect((await failureOf(() => tokens.getToken(RESOURCE))).code).toBe('bad_response');
    const network = await failureOf(() => tokens.getToken(RESOURCE));
    expect({ code: network.code, errType: network.errType }).toEqual({ code: 'network', errType: 'TypeError' });
    expect((await failureOf(() => tokens.getToken(RESOURCE))).code).toBe('timeout');
    expect((await tokens.getToken(RESOURCE)).token).toBe('after failures');
  });
});
