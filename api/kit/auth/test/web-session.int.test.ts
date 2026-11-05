import { randomBytes } from 'node:crypto';

import { expect, test } from 'vitest';

import { call, CookieJar, WEB_ORIGIN } from './helpers/http.ts';
import { parseLink } from './helpers/mail.ts';
import { signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const EMAIL = 'ada@example.test';

async function withServer(run: (server: AuthTestServer) => Promise<void>): Promise<void> {
  const server = await startAuthServer();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

async function redeemWeb(server: AuthTestServer, email: string): Promise<{ jar: CookieJar; response: Response }> {
  const requested = await call(server.url, '/auth/magic-link', {
    json: { email, platform: 'web' },
    origin: WEB_ORIGIN,
  });
  expect(requested.status).toBe(202);
  const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
  const response = await call(server.url, '/auth/magic-link/redeem', {
    json: { token: link.token, email: link.email, platform: 'web' },
    origin: WEB_ORIGIN,
  });
  expect(response.status).toBe(200);
  const jar = new CookieJar();
  jar.store(response);
  return { jar, response };
}

function lineFor(lines: string[], name: string): string {
  const line = lines.find((item) => item.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`missing ${name}`);
  return line;
}

function durableAttributes(line: string): string[] {
  return line.split(';').slice(1).map((part) => part.trim().toLowerCase()).filter((part) => (
    !part.startsWith('max-age') && !part.startsWith('expires')
  )).sort();
}

test('web sign-in sets __Host- httpOnly cookies and returns no token fields', async () => {
  await withServer(async (server) => {
    const { response } = await redeemWeb(server, EMAIL);
    const body: { accessToken?: unknown; refreshToken?: unknown } = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    const lines = response.headers.getSetCookie();
    expect(lineFor(lines, '__Host-access').toLowerCase()).toContain('httponly');
    expect(lineFor(lines, '__Host-refresh').toLowerCase()).toContain('httponly');
  });
});

test('both cookies are __Host- with Path=/ and no Domain', async () => {
  await withServer(async (server) => {
    const { response } = await redeemWeb(server, EMAIL);
    for (const name of ['__Host-access', '__Host-refresh']) {
      const line = lineFor(response.headers.getSetCookie(), name);
      expect(line).toContain('Path=/');
      expect(line.toLowerCase()).not.toContain('domain=');
    }
  });
});

test('refresh cookie is SameSite=Strict, access cookie SameSite=Lax', async () => {
  await withServer(async (server) => {
    const { response } = await redeemWeb(server, EMAIL);
    const lines = response.headers.getSetCookie();
    expect(lineFor(lines, '__Host-access').toLowerCase()).toContain('samesite=lax');
    expect(lineFor(lines, '__Host-refresh').toLowerCase()).toContain('samesite=strict');
  });
});

test('cookie-authenticated POST with a sibling-subdomain Origin is 403', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'web', EMAIL);
    const res = await call(server.url, '/auth/logout', {
      json: { platform: 'web' },
      origin: 'https://evil.example.test',
      jar: signed.jar,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin_not_allowed' });
  });
});

test('web sign-in from a non-allowlisted Origin is 403', async () => {
  await withServer(async (server) => {
    const res = await call(server.url, '/auth/magic-link', {
      json: { email: EMAIL, platform: 'web' },
      origin: 'https://evil.example.test',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin_not_allowed' });
  });
});

test('a web session\'s access token sent as a bearer is refused', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'web', EMAIL);
    const access = signed.jar.get('__Host-access');
    if (access === undefined) throw new Error('missing access cookie');
    const res = await call(server.url, '/auth/me', { bearer: access });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });
});

test('a request carrying the refresh cookie name twice is refused and clears cookies', async () => {
  await withServer(async (server) => {
    const { jar } = await redeemWeb(server, EMAIL);
    const refresh = jar.get('__Host-refresh');
    const access = jar.get('__Host-access');
    if (refresh === undefined || access === undefined) throw new Error('missing cookies');
    const res = await call(server.url, '/auth/refresh', {
      json: { platform: 'web' },
      origin: WEB_ORIGIN,
      cookieHeader: `__Host-access=${access}; __Host-refresh=${refresh}; __Host-refresh=${refresh}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_ended' });
    const cleared = res.headers.getSetCookie();
    expect(lineFor(cleared, '__Host-access')).toContain('Path=/');
    expect(lineFor(cleared, '__Host-refresh')).toContain('Path=/');
  });
});

test('web refresh 401 clears both cookies with the attributes they were set with', async () => {
  await withServer(async (server) => {
    const { jar, response } = await redeemWeb(server, EMAIL);
    const setLines = response.headers.getSetCookie();
    const forged = randomBytes(32).toString('base64url');
    jar.set('__Host-refresh', forged);
    const res = await call(server.url, '/auth/refresh', {
      json: { platform: 'web' },
      origin: WEB_ORIGIN,
      jar,
    });
    expect(res.status).toBe(401);
    const cleared = res.headers.getSetCookie();
    for (const name of ['__Host-access', '__Host-refresh']) {
      expect(durableAttributes(lineFor(cleared, name))).toEqual(durableAttributes(lineFor(setLines, name)));
      expect(lineFor(cleared, name).toLowerCase()).not.toContain('domain=');
    }
  });
});

test('web refresh answers 204 with both cookies', async () => {
  await withServer(async (server) => {
    const { jar } = await redeemWeb(server, EMAIL);
    const previous = jar.get('__Host-refresh');
    const res = await call(server.url, '/auth/refresh', {
      json: { platform: 'web' },
      origin: WEB_ORIGIN,
      jar,
    });
    expect(res.status).toBe(204);
    const lines = res.headers.getSetCookie();
    const access = lineFor(lines, '__Host-access');
    const refresh = lineFor(lines, '__Host-refresh');
    expect(access).toContain('Path=/');
    expect(refresh).toContain('Path=/');
    jar.store(res);
    expect(jar.get('__Host-refresh')).not.toBe(previous);
  });
});
