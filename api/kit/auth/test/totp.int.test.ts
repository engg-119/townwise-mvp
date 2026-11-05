import { randomBytes } from 'node:crypto';

import { createRateLimiter } from '@ckeith26/rate-limit';
import { expect, test } from 'vitest';

import { hashToken } from '../src/sessions.ts';
import { codeAt, stepAt } from '../src/totp/totp.ts';
import type { SignInResult } from '../src/index.ts';
import { call } from './helpers/http.ts';
import { parseLink } from './helpers/mail.ts';
import { seedTotp, signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface MfaBody { status?: string; mfaToken?: string }
interface EnrollBody { secret?: string; qrPngDataUrl?: string; recoveryCodes?: string[] }

function accessTokenOf(body: SignInResult): string {
  if (body.status !== 'signed_in' || !('accessToken' in body)) throw new Error('expected a native access token');
  return body.accessToken;
}

function refreshTokenOf(body: SignInResult): string {
  if (body.status !== 'signed_in' || !('refreshToken' in body)) throw new Error('expected a native refresh token');
  return body.refreshToken;
}

function userIdOf(body: SignInResult): string {
  if (body.status !== 'signed_in') throw new Error('expected a signed-in session');
  return body.user.id;
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

function otherCode(secret: string, now: Date): string {
  const step = stepAt(now);
  const live = new Set([codeAt(secret, step - 1), codeAt(secret, step), codeAt(secret, step + 1)]);
  return live.has('000000') ? '111111' : '000000';
}

async function mfaToken(server: AuthTestServer, email: string): Promise<string> {
  const requested = await call(server.url, '/auth/magic-link', {
    json: { email, platform: 'native' },
  });
  if (requested.status !== 202) throw new Error(`magic link failed (${String(requested.status)})`);
  const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
  const redeemed = await call(server.url, '/auth/magic-link/redeem', {
    json: { token: link.token, email: link.email, platform: 'native' },
  });
  const body = await redeemed.json() as MfaBody;
  if (redeemed.status !== 200 || body.mfaToken === undefined) {
    throw new Error(`expected mfa_required (${String(redeemed.status)})`);
  }
  return body.mfaToken;
}

function verify(server: AuthTestServer, mfa: string, fields: { code?: string; recoveryCode?: string }): Promise<Response> {
  return call(server.url, '/auth/mfa/verify', {
    json: { mfaToken: mfa, platform: 'native', ...fields },
  });
}

function currentCode(secret: string, server: AuthTestServer): string {
  return codeAt(secret, stepAt(server.clock.now()));
}

test('full enrollment returns a PNG qrPngDataUrl and, on confirm, 10 recovery codes once', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', 'ada@example.test');
    const enrolled = await call(server.url, '/auth/totp/enroll', {
      method: 'POST',
      bearer: accessTokenOf(signed.body),
    });
    expect(enrolled.status).toBe(200);
    const enrollBody = await enrolled.json() as EnrollBody;
    expect(enrollBody.qrPngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    const encoded = enrollBody.qrPngDataUrl?.slice('data:image/png;base64,'.length) ?? '';
    const bytes = Buffer.from(encoded, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const secret = enrollBody.secret;
    if (secret === undefined) throw new Error('expected a secret');
    const confirmed = await call(server.url, '/auth/totp/enroll/confirm', {
      bearer: accessTokenOf(signed.body),
      json: { code: currentCode(secret, server) },
    });
    expect(confirmed.status).toBe(200);
    const confirmBody = await confirmed.json() as EnrollBody;
    expect(confirmBody.recoveryCodes).toHaveLength(10);
    const again = await call(server.url, '/auth/totp/enroll/confirm', {
      bearer: accessTokenOf(signed.body),
      json: { code: currentCode(secret, server) },
    });
    expect(again.status).not.toBe(200);
  });
});

test('stores the secret encrypted and recovery codes hashed', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', 'ada@example.test');
    const enrolled = await call(server.url, '/auth/totp/enroll', {
      method: 'POST',
      bearer: accessTokenOf(signed.body),
    });
    const enrollBody = await enrolled.json() as EnrollBody;
    const secret = enrollBody.secret;
    if (secret === undefined) throw new Error('expected a secret');
    const confirmed = await call(server.url, '/auth/totp/enroll/confirm', {
      bearer: accessTokenOf(signed.body),
      json: { code: currentCode(secret, server) },
    });
    const confirmBody = await confirmed.json() as { recoveryCodes: string[] };
    const doc = await server.connection.collection<{
      _id: string;
      status: string;
      recoveryCodeHashes: string[];
    }>('auth_totp').findOne({ _id: userIdOf(signed.body) });
    const blob = JSON.stringify(doc);
    expect(blob.includes(secret)).toBe(false);
    expect(doc).toMatchObject({ status: 'enabled' });
    const hashes = doc?.recoveryCodeHashes ?? [];
    for (const code of confirmBody.recoveryCodes) {
      expect(blob.includes(code)).toBe(false);
      expect(hashes).toContain(hashToken(code.replace(/-/g, '')));
    }
  });
});

test('a TOTP ciphertext copied to another user does not decrypt', async () => {
  await withServer(async (server) => {
    const ada = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const bea = await server.stores.users.create({ email: 'bea@example.test', now: server.clock.now() });
    await seedTotp(server, ada.id);
    await seedTotp(server, bea.id);
    const adaFactor = await server.stores.totp.get(ada.id);
    if (adaFactor === null) throw new Error('expected ada factor');
    await server.connection.collection<{ _id: string; secretEnc: string }>('auth_totp').updateOne(
      { _id: bea.id },
      { $set: { secretEnc: adaFactor.secretEnc } },
    );
    const before = await server.connection.collection('auth_sessions').countDocuments();
    const token = await mfaToken(server, 'bea@example.test');
    const res = await verify(server, token, { code: '000000' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal' });
    expect(await server.connection.collection('auth_sessions').countDocuments()).toBe(before);
  });
});

test('sign-in for a TOTP user returns mfa_required and creates no session', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    expect(token.length).toBeGreaterThan(0);
    expect(await server.connection.collection('auth_sessions').countDocuments()).toBe(0);
  });
});

test('an expired mfaToken is 401 invalid_mfa_token and creates no session', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    // exp is iat + 300s and jose clockTolerance is 5s, so the token dies at 305s.
    server.clock.advance(306 * 1000);
    const res = await verify(server, token, { code: '000000' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_mfa_token' });
    expect(await server.connection.collection('auth_sessions').countDocuments()).toBe(0);
  });
});

test('a code is refused on replay within its window', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    const code = currentCode(seeded.secret, server);
    const first = await verify(server, token, { code });
    expect(first.status).toBe(200);
    const second = await verify(server, token, { code });
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: 'invalid_code' });
  });
});

test('a code from an earlier step is refused after a later step was accepted', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const step = stepAt(server.clock.now());
    const token = await mfaToken(server, 'ada@example.test');
    const later = await verify(server, token, { code: codeAt(seeded.secret, step + 1) });
    expect(later.status).toBe(200);
    const earlier = await verify(server, token, { code: codeAt(seeded.secret, step) });
    expect(earlier.status).toBe(400);
    expect(await earlier.json()).toMatchObject({ error: 'invalid_code' });
  });
});

test('a correct code on the 6th attempt within 15 minutes is 429', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    const wrong = otherCode(seeded.secret, server.clock.now());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await verify(server, token, { code: wrong });
      expect(res.status).toBe(400);
    }
    const limited = await verify(server, token, { code: currentCode(seeded.secret, server) });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
  });
});

test('the 6th attempt is 429 even when submitted concurrently', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    const wrong = otherCode(seeded.secret, server.clock.now());
    const responses = await Promise.all(Array.from({ length: 6 }, () => verify(server, token, { code: wrong })));
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 400)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
  });
});

test('the 21st attempt within 24 hours is 429', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    const wrong = otherCode(seeded.secret, server.clock.now());
    const short = createRateLimiter({
      redis: server.redis,
      name: 'auth:totp-user',
      limit: 5,
      windowSeconds: 900,
    });
    for (let round = 0; round < 4; round += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await verify(server, token, { code: wrong });
        expect(res.status).toBe(400);
      }
      await short.reset(user.id);
    }
    const limited = await verify(server, token, { code: wrong });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
  });
});

test('a spaced code (123 456) is accepted at /mfa/verify', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const token = await mfaToken(server, 'ada@example.test');
    const code = currentCode(seeded.secret, server);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    const res = await verify(server, token, { code: spaced });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'signed_in' });
  });
});

test('a recovery code works exactly once, in any case and with or without hyphens', async () => {
  await withServer(async (server) => {
    const user = await server.stores.users.create({ email: 'ada@example.test', now: server.clock.now() });
    const seeded = await seedTotp(server, user.id);
    const first = seeded.recoveryCodes[0];
    const second = seeded.recoveryCodes[1];
    if (first === undefined || second === undefined) throw new Error('expected recovery codes');
    const plain = first.replace(/-/g, '');
    const mixed = `${plain.slice(0, 4).toUpperCase()}${plain.slice(4)}`;
    const token = await mfaToken(server, 'ada@example.test');
    const once = await verify(server, token, { recoveryCode: mixed });
    expect(once.status).toBe(200);
    const again = await verify(server, token, { recoveryCode: first });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_code' });
    const hyphenated = second.toUpperCase();
    const next = await mfaToken(server, 'ada@example.test');
    const other = await verify(server, next, { recoveryCode: hyphenated });
    expect(other.status).toBe(200);
  });
});

test('a stale-key secret is re-encrypted under the current key after a successful code', async () => {
  const jwt = `k1:${randomBytes(32).toString('base64')}`;
  const oldKey = randomBytes(32).toString('base64');
  const newKey = randomBytes(32).toString('base64');
  const first = await startAuthServer({
    env: { AUTH_JWT_KEYS: jwt, AUTH_ENCRYPTION_KEYS: `e1:${oldKey}` },
  });
  let prepared: { token: string; secret: string; userId: string } | undefined;
  try {
    const user = await first.stores.users.create({ email: 'ada@example.test', now: first.clock.now() });
    const seeded = await seedTotp(first, user.id);
    const stored = await first.connection.collection<{ _id: string; secretEnc: string }>('auth_totp').findOne({
      _id: user.id,
    });
    expect(stored?.secretEnc.split(':')[1]).toBe('e1');
    prepared = { token: await mfaToken(first, 'ada@example.test'), secret: seeded.secret, userId: user.id };
  } finally {
    await first.close();
  }
  const second = await startAuthServer({
    keepData: true,
    env: { AUTH_JWT_KEYS: jwt, AUTH_ENCRYPTION_KEYS: `e2:${newKey},e1:${oldKey}` },
  });
  try {
    const res = await verify(second, prepared.token, { code: codeAt(prepared.secret, stepAt(second.clock.now())) });
    expect(res.status).toBe(200);
    const stored = await second.connection.collection<{ _id: string; secretEnc: string }>('auth_totp').findOne({
      _id: prepared.userId,
    });
    expect(stored?.secretEnc.split(':')[1]).toBe('e2');
  } finally {
    await second.close();
  }
});

test('enabling TOTP revokes the user\'s other sessions', async () => {
  await withServer(async (server) => {
    const ada = await signIn(server, 'native', 'ada@example.test');
    const other = await signIn(server, 'native', 'ada@example.test');
    const enrolled = await call(server.url, '/auth/totp/enroll', {
      method: 'POST',
      bearer: accessTokenOf(ada.body),
    });
    const enrollBody = await enrolled.json() as EnrollBody;
    const secret = enrollBody.secret;
    if (secret === undefined) throw new Error('expected a secret');
    const confirmed = await call(server.url, '/auth/totp/enroll/confirm', {
      bearer: accessTokenOf(ada.body),
      json: { code: currentCode(secret, server) },
    });
    expect(confirmed.status).toBe(200);
    const now = server.clock.now();
    expect(await server.stores.sessions.findLive(sessionIdOf(other.body), { now, idleCutoff: new Date(now.getTime() - 14 * DAY_MS) })).toBeNull();
    expect(await server.stores.sessions.findLive(sessionIdOf(ada.body), { now, idleCutoff: new Date(now.getTime() - 14 * DAY_MS) })).not.toBeNull();
  });
});

test('disable requires a valid code', async () => {
  await withServer(async (server) => {
    const signed = await signIn(server, 'native', 'ada@example.test');
    const seeded = await seedTotp(server, userIdOf(signed.body));
    const bearer = accessTokenOf(signed.body);
    const wrong = await call(server.url, '/auth/totp/disable', {
      bearer,
      json: { code: otherCode(seeded.secret, server.clock.now()) },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_code' });
    const right = await call(server.url, '/auth/totp/disable', {
      bearer,
      json: { code: currentCode(seeded.secret, server) },
    });
    expect(right.status).toBe(204);
    expect(await server.stores.totp.get(userIdOf(signed.body))).toBeNull();
  });
});

test('enroll requires a session created within 15 minutes', async () => {
  await withServer(async (server) => {
    const recent = await signIn(server, 'native', 'ada@example.test');
    server.clock.advance(14 * 60 * 1000);
    const recentRefresh = await call(server.url, '/auth/refresh', {
      json: { platform: 'native', refreshToken: refreshTokenOf(recent.body) },
    });
    expect(recentRefresh.status).toBe(200);
    const recentBody = await recentRefresh.json() as { accessToken: string };
    const recentEnroll = await call(server.url, '/auth/totp/enroll', {
      method: 'POST',
      bearer: recentBody.accessToken,
    });
    expect(recentEnroll.status).toBe(200);

    const late = await signIn(server, 'native', 'bea@example.test');
    server.clock.advance(15 * 60 * 1000 + 1000);
    const lateRefresh = await call(server.url, '/auth/refresh', {
      json: { platform: 'native', refreshToken: refreshTokenOf(late.body) },
    });
    expect(lateRefresh.status).toBe(200);
    const lateBody = await lateRefresh.json() as { accessToken: string };
    const lateEnroll = await call(server.url, '/auth/totp/enroll', {
      method: 'POST',
      bearer: lateBody.accessToken,
    });
    expect(lateEnroll.status).toBe(403);
    expect(await lateEnroll.json()).toMatchObject({ error: 'reauth_required' });
  });
});
