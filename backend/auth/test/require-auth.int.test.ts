import express from 'express';
import { expect, test } from 'vitest';

import { authOf, type Auth, type SignInResult } from '../src/index.ts';
import type { AuthStores } from '../src/stores/types.ts';
import { call, WEB_ORIGIN } from './helpers/http.ts';
import { signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const ADA = 'ada@example.test';
const BEA = 'bea@example.test';

function apiRoutes(auth: Auth) {
  const router = express.Router();
  router.get('/whoami', auth.requireAuth, (req, res) => {
    const ctx = authOf(req);
    res.status(200).json({ userId: ctx.userId, sessionId: ctx.sessionId, platform: ctx.platform });
  });
  router.post('/echo', auth.requireAuth, (req, res) => {
    res.status(200).json({ ok: req.method === 'POST' });
  });
  router.get('/naked', (req, res) => {
    authOf(req);
    res.status(200).json({ ok: true });
  });
  return [{ path: '/api' as const, router }];
}

function sessionId(body: SignInResult): string {
  if (body.status !== 'signed_in') throw new Error('expected a signed-in session');
  return body.session.id;
}

function userId(body: SignInResult): string {
  if (body.status !== 'signed_in') throw new Error('expected a signed-in session');
  return body.user.id;
}

function nativeToken(body: SignInResult): string {
  if (body.status !== 'signed_in' || !('accessToken' in body)) throw new Error('expected a native sign-in');
  return body.accessToken;
}

async function withApi(run: (server: AuthTestServer) => Promise<void>): Promise<void> {
  const server = await startAuthServer({ routes: apiRoutes });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test('a revoked session\'s access token is refused on the next request', async () => {
  await withApi(async (server) => {
    const signed = await signIn(server, 'native', ADA);
    await server.stores.sessions.revoke({
      id: sessionId(signed.body),
      reason: 'logout',
      now: server.clock.now(),
    });
    const res = await call(server.url, '/api/whoami', { bearer: nativeToken(signed.body) });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });
});

test('answers 500, not 401, when the session store throws', async () => {
  const holder: { current?: AuthStores } = {};
  const stores: AuthStores = {
    get users() {
      if (holder.current === undefined) throw new Error('stores not ready');
      return holder.current.users;
    },
    get magicLinks() {
      if (holder.current === undefined) throw new Error('stores not ready');
      return holder.current.magicLinks;
    },
    get totp() {
      if (holder.current === undefined) throw new Error('stores not ready');
      return holder.current.totp;
    },
    sessions: {
      create: (input) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.create(input);
      },
      findLive: () => Promise.reject(new Error('store down')),
      rotate: (input) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.rotate(input);
      },
      findByPreviousHash: (hash, platform) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.findByPreviousHash(hash, platform);
      },
      rotateFromPrevious: (input) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.rotateFromPrevious(input);
      },
      findByRetiredHash: (hash, platform) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.findByRetiredHash(hash, platform);
      },
      revoke: (input) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.revoke(input);
      },
      revokeByRefreshHash: (input) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.revokeByRefreshHash(input);
      },
      revokeAllForUser: (input) => {
        if (holder.current === undefined) return Promise.reject(new Error('stores not ready'));
        return holder.current.sessions.revokeAllForUser(input);
      },
    },
  };
  const server = await startAuthServer({ deps: { stores }, routes: apiRoutes });
  holder.current = server.stores;
  try {
    const signed = await signIn(server, 'native', ADA);
    const res = await call(server.url, '/api/whoami', { bearer: nativeToken(signed.body) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal' });
  } finally {
    await server.close();
  }
});

test('the Authorization header takes precedence over the cookie', async () => {
  await withApi(async (server) => {
    const web = await signIn(server, 'web', ADA);
    const native = await signIn(server, 'native', BEA);
    const res = await call(server.url, '/api/whoami', {
      bearer: nativeToken(native.body),
      jar: web.jar,
      origin: WEB_ORIGIN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: userId(native.body), platform: 'native' });
  });
});

test('GET with a cookie needs no Origin', async () => {
  await withApi(async (server) => {
    const web = await signIn(server, 'web', ADA);
    const res = await call(server.url, '/api/whoami', { jar: web.jar });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: userId(web.body), platform: 'web' });
  });
});

test('a cookie-authenticated POST without Origin is 403', async () => {
  await withApi(async (server) => {
    const web = await signIn(server, 'web', ADA);
    const res = await call(server.url, '/api/echo', { jar: web.jar, json: {} });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin_not_allowed' });
  });
});

test('requireAuth never writes the session row', async () => {
  await withApi(async (server) => {
    const web = await signIn(server, 'web', ADA);
    const id = sessionId(web.body);
    const sessions = server.connection.collection<{ _id: string }>('auth_sessions');
    const before = await sessions.findOne({ _id: id });
    for (let hit = 0; hit < 20; hit += 1) {
      expect((await call(server.url, '/api/whoami', { jar: web.jar })).status).toBe(200);
    }
    const after = await sessions.findOne({ _id: id });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

test('authOf throws in a route mounted without requireAuth', async () => {
  await withApi(async (server) => {
    const res = await call(server.url, '/api/naked');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal' });
  });
});

test('GET /me returns the user, the session and the totp state', async () => {
  await withApi(async (server) => {
    const web = await signIn(server, 'web', ADA);
    const res = await call(server.url, '/auth/me', { jar: web.jar });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: userId(web.body), email: ADA },
      session: { id: sessionId(web.body), platform: 'web' },
      totp: { enabled: false, recoveryCodesRemaining: 0 },
    });
  });
});
