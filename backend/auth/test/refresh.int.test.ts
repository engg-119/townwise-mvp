import { randomBytes } from 'node:crypto';

import { expect, test } from 'vitest';

import { hashToken, liveWindow } from '../src/sessions.ts';
import type { AuthStores, SessionStore } from '../src/stores/types.ts';
import type { SignInResult } from '../src/index.ts';
import { call } from './helpers/http.ts';
import { signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const EMAIL = 'ada@example.test';
const DAY_MS = 24 * 60 * 60 * 1000;

interface NativeRefresh {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

interface RawSession {
  _id: string;
  refreshHash: string;
  previousRefreshHash?: string;
  lastUsedAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
}

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

function refreshNative(server: AuthTestServer, token: string): Promise<Response> {
  return call(server.url, '/auth/refresh', { json: { platform: 'native', refreshToken: token } });
}

async function readSession(server: AuthTestServer, id: string): Promise<RawSession> {
  const doc = await server.connection.collection<RawSession>('auth_sessions').findOne({ _id: id });
  if (doc === null) throw new Error('session missing');
  return doc;
}

async function nativeBody(res: Response): Promise<NativeRefresh> {
  return await res.json() as NativeRefresh;
}

test('rotation returns a new refresh token and retires the old one', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const old = refreshTokenOf(signed.body);
    const res = await refreshNative(server, old);
    expect(res.status).toBe(200);
    const body = await nativeBody(res);
    expect(body.refreshToken).not.toBe(old);
    const doc = await readSession(server, sessionIdOf(signed.body));
    expect(doc.previousRefreshHash).toBe(hashToken(old));
    expect(doc.refreshHash).toBe(hashToken(body.refreshToken));
    const retired = await server.connection.collection<{ _id: string }>('auth_refresh_retired').findOne({
      _id: hashToken(old),
    });
    expect(retired).not.toBeNull();
  });
});

test('the refresh token is rejected as a bearer access token', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const res = await call(server.url, '/auth/me', { bearer: refreshTokenOf(signed.body) });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });
});

test('the raw refresh token never reaches the store or the database', async () => {
  const calls: unknown[] = [];
  const holder: { current?: AuthStores } = {};
  const note = (value: unknown): void => {
    calls.push(value);
  };
  const sessions = (): SessionStore => {
    if (holder.current === undefined) throw new Error('stores not ready');
    return holder.current.sessions;
  };
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
        note(input);
        return sessions().create(input);
      },
      findLive: (id, w) => {
        note([id, w]);
        return sessions().findLive(id, w);
      },
      rotate: (input) => {
        note(input);
        return sessions().rotate(input);
      },
      findByPreviousHash: (hash, platform) => {
        note([hash, platform]);
        return sessions().findByPreviousHash(hash, platform);
      },
      rotateFromPrevious: (input) => {
        note(input);
        return sessions().rotateFromPrevious(input);
      },
      findByRetiredHash: (hash, platform) => {
        note([hash, platform]);
        return sessions().findByRetiredHash(hash, platform);
      },
      revoke: (input) => {
        note(input);
        return sessions().revoke(input);
      },
      revokeByRefreshHash: (input) => {
        note(input);
        return sessions().revokeByRefreshHash(input);
      },
      revokeAllForUser: (input) => {
        note(input);
        return sessions().revokeAllForUser(input);
      },
    },
  };
  const server = await startAuthServer({ deps: { stores } });
  holder.current = server.stores;
  try {
    const signed = await signIn(server, 'native', EMAIL);
    const token = refreshTokenOf(signed.body);
    const res = await refreshNative(server, token);
    expect(res.status).toBe(200);
    const sessionsDocs = await server.connection.collection('auth_sessions').find().toArray();
    const retiredDocs = await server.connection.collection('auth_refresh_retired').find().toArray();
    const blob = JSON.stringify({ calls, sessionsDocs, retiredDocs });
    expect(blob.includes(token)).toBe(false);
  } finally {
    await server.close();
  }
});

test('replay of a token two rotations old revokes the session', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const original = refreshTokenOf(signed.body);
    const first = await refreshNative(server, original);
    expect(first.status).toBe(200);
    const second = await refreshNative(server, (await nativeBody(first)).refreshToken);
    expect(second.status).toBe(200);
    const replay = await refreshNative(server, original);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'session_ended' });
    const doc = await readSession(server, sessionIdOf(signed.body));
    expect(doc.revokedAt).not.toBeNull();
    expect(doc.revokeReason).toBe('refresh_reuse');
  });
});

test('an unknown well-formed token is 401 and revokes nothing', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const forged = randomBytes(32).toString('base64url');
    const res = await refreshNative(server, forged);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_ended' });
    const live = await server.stores.sessions.findLive(sessionIdOf(signed.body), liveWindow(server.clock.now()));
    expect(live).not.toBeNull();
    expect(live?.revokeReason).toBeNull();
  });
});

test('a malformed refresh token is 401 session_ended, not 400', async () => {
  await withServer(async (server) => {
    const res = await refreshNative(server, 'not-a-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_ended' });
  });
});

test('idle and absolute expiry end the session, including on the grace path', async () => {
  await withServer(async (server) => {
    const idleSigned = await signIn(server, 'native', EMAIL);
    const idleFirst = await refreshNative(server, refreshTokenOf(idleSigned.body));
    expect(idleFirst.status).toBe(200);
    const idlePrevious = refreshTokenOf(idleSigned.body);
    const idleCurrent = (await nativeBody(idleFirst)).refreshToken;
    server.clock.advance(14 * DAY_MS + 1);
    const idlePrevRes = await refreshNative(server, idlePrevious);
    const idleCurRes = await refreshNative(server, idleCurrent);
    expect(idlePrevRes.status).toBe(401);
    expect(await idlePrevRes.json()).toMatchObject({ error: 'session_ended' });
    expect(idleCurRes.status).toBe(401);
    expect(await idleCurRes.json()).toMatchObject({ error: 'session_ended' });

    const absoluteSigned = await signIn(server, 'native', 'bea@example.test');
    server.clock.advance(13 * DAY_MS);
    const at13 = await refreshNative(server, refreshTokenOf(absoluteSigned.body));
    expect(at13.status).toBe(200);
    const rotatedAt13 = (await nativeBody(at13)).refreshToken;
    server.clock.advance(13 * DAY_MS);
    const at26 = await refreshNative(server, rotatedAt13);
    expect(at26.status).toBe(200);
    const rotatedAt26 = (await nativeBody(at26)).refreshToken;
    server.clock.advance(4 * DAY_MS + 1);
    const absPrev = await refreshNative(server, rotatedAt13);
    const absCur = await refreshNative(server, rotatedAt26);
    expect(absPrev.status).toBe(401);
    expect(await absPrev.json()).toMatchObject({ error: 'session_ended' });
    expect(absCur.status).toBe(401);
    expect(await absCur.json()).toMatchObject({ error: 'session_ended' });
  });
});

test('two devices hold independent sessions; revoking one leaves the other', async () => {
  await withServer(async (server) => {
    const ada = await signIn(server, 'native', EMAIL);
    const bea = await signIn(server, 'native', EMAIL);
    const logout = await call(server.url, '/auth/logout', {
      json: { platform: 'native', refreshToken: refreshTokenOf(ada.body) },
    });
    expect(logout.status).toBe(204);
    expect(await server.stores.sessions.findLive(sessionIdOf(ada.body), liveWindow(server.clock.now()))).toBeNull();
    const res = await refreshNative(server, refreshTokenOf(bea.body));
    expect(res.status).toBe(200);
    const live = await server.stores.sessions.findLive(sessionIdOf(bea.body), liveWindow(server.clock.now()));
    expect(live).not.toBeNull();
  });
});

test('a session whose user was deleted ends at the next refresh', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    await server.connection.collection('users').deleteMany({ email: EMAIL });
    const res = await refreshNative(server, refreshTokenOf(signed.body));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'session_ended' });
    const doc = await readSession(server, sessionIdOf(signed.body));
    expect(doc.revokeReason).toBe('user_missing');
    expect(doc.revokedAt).not.toBeNull();
  });
});

test('answers 500, not 401, when Mongo is unavailable', async () => {
  const server = await startAuthServer();
  try {
    const signed = await signIn(server, 'native', EMAIL);
    await server.connection.close();
    const res = await refreshNative(server, refreshTokenOf(signed.body));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal' });
  } finally {
    await server.close();
  }
});

test('a retry with the just-rotated token inside the grace window succeeds and leaves one current token', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const original = refreshTokenOf(signed.body);
    const rotated = await refreshNative(server, original);
    expect(rotated.status).toBe(200);
    const grace = await refreshNative(server, original);
    expect(grace.status).toBe(200);
    const graceBody = await nativeBody(grace);
    const rows = await server.connection.collection<RawSession>('auth_sessions').find().toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('session missing');
    expect(row.revokedAt).toBeNull();
    expect(row.refreshHash).toBe(hashToken(graceBody.refreshToken));
    expect(row.previousRefreshHash).toBe(hashToken((await nativeBody(rotated)).refreshToken));
    expect(row.refreshHash).not.toBe(hashToken(original));
  });
});

test('a grace rotation does not move lastUsedAt', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const original = refreshTokenOf(signed.body);
    const rotated = await refreshNative(server, original);
    expect(rotated.status).toBe(200);
    const before = (await readSession(server, sessionIdOf(signed.body))).lastUsedAt.getTime();
    const grace = await refreshNative(server, original);
    expect(grace.status).toBe(200);
    const after = (await readSession(server, sessionIdOf(signed.body))).lastUsedAt.getTime();
    expect(after).toBe(before);
  });
});

test('presenting the original token after a grace retry revokes the session', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const original = refreshTokenOf(signed.body);
    const rotated = await refreshNative(server, original);
    expect(rotated.status).toBe(200);
    const grace = await refreshNative(server, original);
    expect(grace.status).toBe(200);
    const replay = await refreshNative(server, original);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'session_ended' });
    const doc = await readSession(server, sessionIdOf(signed.body));
    expect(doc.revokedAt).not.toBeNull();
    expect(doc.revokeReason).toBe('refresh_reuse');
  });
});

test('replay of the previous token after the grace window revokes the session', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const original = refreshTokenOf(signed.body);
    const rotated = await refreshNative(server, original);
    expect(rotated.status).toBe(200);
    server.clock.advance(61 * 1000);
    const replay = await refreshNative(server, original);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'session_ended' });
    const doc = await readSession(server, sessionIdOf(signed.body));
    expect(doc.revokedAt).not.toBeNull();
    expect(doc.revokeReason).toBe('refresh_reuse');
  });
});

test('concurrent refreshes with one token leave exactly one live token', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', EMAIL);
    const token = refreshTokenOf(signed.body);
    const [first, second] = await Promise.all([refreshNative(server, token), refreshNative(server, token)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const left = await nativeBody(first);
    const right = await nativeBody(second);
    const rows = await server.connection.collection<RawSession>('auth_sessions').find({ revokedAt: null }).toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('session missing');
    const matches = [left.refreshToken, right.refreshToken].filter((value) => hashToken(value) === row.refreshHash);
    expect(matches).toHaveLength(1);
  });
});
