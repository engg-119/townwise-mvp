import { expect, test } from 'vitest';

import { hashToken, liveWindow } from '../src/sessions.ts';
import type { SignInResult } from '../src/index.ts';
import { call, WEB_ORIGIN } from './helpers/http.ts';
import { parseLink } from './helpers/mail.ts';
import { seedTotp, signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const EMAIL = 'ada@example.test';

function refreshTokenOf(body: SignInResult): string {
  if (body.status !== 'signed_in' || !('refreshToken' in body)) throw new Error('expected a native refresh token');
  return body.refreshToken;
}

function sessionIdOf(body: SignInResult): string {
  if (body.status !== 'signed_in') throw new Error('expected a signed-in session');
  return body.session.id;
}

async function withServer(run: (server: AuthTestServer) => Promise<void>): Promise<void> {
  const server = await startAuthServer();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test('native sign-in returns tokens in the body with Cache-Control: no-store', async () => {
  await withServer(async (server) => {
    const requested = await call(server.url, '/auth/magic-link', {
      json: { email: EMAIL, platform: 'native' },
    });
    expect(requested.status).toBe(202);
    const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
    const redeemed = await call(server.url, '/auth/magic-link/redeem', {
      json: { token: link.token, email: link.email, platform: 'native' },
    });
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get('cache-control')).toBe('no-store');
    const body = await redeemed.json() as SignInResult;
    expect(refreshTokenOf(body).length).toBeGreaterThan(0);
    if (body.status !== 'signed_in' || !('accessToken' in body)) throw new Error('expected tokens');
    expect(body.accessToken.length).toBeGreaterThan(0);
  });
});

test('a native declaration with an Origin header is 403', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const before = await server.stores.sessions.findLive(sessionIdOf(signed.body), liveWindow(server.clock.now()));
    const res = await call(server.url, '/auth/refresh', {
      json: { platform: 'native', refreshToken: refreshTokenOf(signed.body) },
      origin: WEB_ORIGIN,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin_not_allowed' });
    const after = await server.stores.sessions.findLive(sessionIdOf(signed.body), liveWindow(server.clock.now()));
    expect(after?.refreshHash).toBe(before?.refreshHash);
  });
});

test('a native declaration with Sec-Fetch-Site is 403', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const before = await server.stores.sessions.findLive(sessionIdOf(signed.body), liveWindow(server.clock.now()));
    const res = await call(server.url, '/auth/refresh', {
      json: { platform: 'native', refreshToken: refreshTokenOf(signed.body) },
      secFetchSite: 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin_not_allowed' });
    const after = await server.stores.sessions.findLive(sessionIdOf(signed.body), liveWindow(server.clock.now()));
    expect(after?.refreshHash).toBe(before?.refreshHash);
    expect(hashToken(refreshTokenOf(signed.body))).toBe(before?.refreshHash);
  });
});

test('a native refresh token presented as a cookie is refused', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const token = refreshTokenOf(signed.body);
    const res = await call(server.url, '/auth/refresh', {
      json: { platform: 'native' },
      cookieHeader: `__Host-refresh=${token}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_ended' });
    const live = await server.stores.sessions.findLive(sessionIdOf(signed.body), liveWindow(server.clock.now()));
    expect(live).not.toBeNull();
    const again = await call(server.url, '/auth/refresh', {
      json: { platform: 'native', refreshToken: token },
    });
    expect(again.status).toBe(200);
  });
});

test('an mfaToken issued to a web sign-in is refused in native mode', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: EMAIL, now: server.clock.now() });
    await seedTotp(server, user.id);
    const requested = await call(server.url, '/auth/magic-link', {
      json: { email: EMAIL, platform: 'web' },
      origin: WEB_ORIGIN,
    });
    expect(requested.status).toBe(202);
    const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
    const redeemed = await call(server.url, '/auth/magic-link/redeem', {
      json: { token: link.token, email: link.email, platform: 'web' },
      origin: WEB_ORIGIN,
    });
    expect(redeemed.status).toBe(200);
    const body = await redeemed.json() as { status?: string; mfaToken?: string };
    expect(body.status).toBe('mfa_required');
    if (body.mfaToken === undefined) throw new Error('expected an mfa token');
    const res = await call(server.url, '/auth/mfa/verify', {
      json: { mfaToken: body.mfaToken, platform: 'native', code: '000000' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_mfa_token' });
  });
});
