import { expect, test } from 'vitest';

import { hashToken, liveWindow } from '../src/sessions.ts';
import type { SignInResult } from '../src/index.ts';
import { call, WEB_ORIGIN } from './helpers/http.ts';
import { parseLink } from './helpers/mail.ts';
import { signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const EMAIL = 'ada@example.test';

function sessionId(body: SignInResult): string {
  if (body.status !== 'signed_in') throw new Error('expected a signed-in session');
  return body.session.id;
}

function userId(body: SignInResult): string {
  if (body.status !== 'signed_in') throw new Error('expected a signed-in session');
  return body.user.id;
}

async function withServer(run: (server: AuthTestServer) => Promise<void>): Promise<void> {
  const server = await startAuthServer();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test('logout with an expired access token still revokes through the refresh token and returns 204', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'web', EMAIL);
    server.clock.advance(11 * 60 * 1000);
    const res = await call(server.url, '/auth/logout', {
      json: { platform: 'web' },
      origin: WEB_ORIGIN,
      jar: signed.jar,
    });
    expect(res.status).toBe(204);
    expect(await server.stores.sessions.findLive(sessionId(signed.body), liveWindow(server.clock.now()))).toBeNull();
  });
});

test('logout with nothing returns 204', async () => {
  await withServer(async (server) => {
    const res = await call(server.url, '/auth/logout', {
      json: { platform: 'web' },
      origin: WEB_ORIGIN,
    });
    expect(res.status).toBe(204);
  });
});

test('logout-all revokes every session, deletes pending magic links for the user\'s email and clears cookies with Path=/', async () => {
  await withServer(async (server) => {
    const web = await signIn(server, 'web', EMAIL);
    const native = await signIn(server, 'native', EMAIL);
    const requested = await call(server.url, '/auth/magic-link', {
      json: { email: EMAIL, platform: 'web' },
      origin: WEB_ORIGIN,
    });
    expect(requested.status).toBe(202);
    const pending = parseLink(server.mail.messages.at(-1)?.url ?? '');
    const res = await call(server.url, '/auth/logout-all', {
      method: 'POST',
      origin: WEB_ORIGIN,
      jar: web.jar,
    });
    expect(res.status).toBe(204);
    const now = server.clock.now();
    expect(await server.stores.sessions.findLive(sessionId(web.body), liveWindow(now))).toBeNull();
    expect(await server.stores.sessions.findLive(sessionId(native.body), liveWindow(now))).toBeNull();
    expect(await server.stores.magicLinks.consume({
      tokenHash: hashToken(pending.token),
      email: pending.email,
      platform: 'web',
      now,
    })).toBe(false);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((line) => line.includes('__Host-access') && line.includes('Path=/'))).toBe(true);
    expect(cookies.some((line) => line.includes('__Host-refresh') && line.includes('Path=/'))).toBe(true);
    for (const line of cookies) expect(line).not.toMatch(/Domain=/);
  });
});

test('revokeAllSessions ends every session and deletes pending links', async () => {
  await withServer(async (server) => {
    const web = await signIn(server, 'web', EMAIL);
    const native = await signIn(server, 'native', EMAIL);
    const requested = await call(server.url, '/auth/magic-link', {
      json: { email: EMAIL, platform: 'web' },
      origin: WEB_ORIGIN,
    });
    expect(requested.status).toBe(202);
    const pending = parseLink(server.mail.messages.at(-1)?.url ?? '');
    expect(await server.auth.revokeAllSessions(userId(web.body))).toBe(2);
    const now = server.clock.now();
    expect(await server.stores.sessions.findLive(sessionId(web.body), liveWindow(now))).toBeNull();
    expect(await server.stores.sessions.findLive(sessionId(native.body), liveWindow(now))).toBeNull();
    expect(await server.stores.magicLinks.consume({
      tokenHash: hashToken(pending.token),
      email: pending.email,
      platform: 'web',
      now,
    })).toBe(false);
  });
});
