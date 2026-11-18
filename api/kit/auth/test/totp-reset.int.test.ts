import { expect, test } from 'vitest';

import { codeAt, stepAt } from '../src/totp/totp.ts';
import type { SignInResult } from '../src/index.ts';
import { call } from './helpers/http.ts';
import { parseLink } from './helpers/mail.ts';
import { seedTotp, signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

// Resetting two-step sign-in (Townwise local change, MODULE.md): a person with it on proves themselves with a code
// or a recovery code, gets a new secret, and the new secret replaces the old one only when a code from it is
// confirmed in the same session.

const EMAIL = 'ada@example.test';
const STEP_MS = 30 * 1000;

interface ResetBody { secret?: string; otpauthUri?: string; expiresAt?: string; qrPngDataUrl?: string; recoveryCodes?: string[]; error?: string }

function accessTokenOf(body: SignInResult): string {
  if (body.status !== 'signed_in' || !('accessToken' in body)) throw new Error('expected a native access token');
  return body.accessToken;
}

function userIdOf(body: SignInResult): string {
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

function currentCode(secret: string, server: AuthTestServer): string {
  return codeAt(secret, stepAt(server.clock.now()));
}

function otherCode(secrets: readonly string[], now: Date): string {
  const step = stepAt(now);
  const live = new Set(secrets.flatMap((secret) => [codeAt(secret, step - 1), codeAt(secret, step), codeAt(secret, step + 1)]));
  return ['000000', '111111', '222222', '333333', '444444', '555555', '666666'].find((code) => !live.has(code)) ?? '777777';
}

/** A signed-in person with two-step sign-in on: the session's bearer, the secret and the recovery codes. */
async function enrolled(server: AuthTestServer): Promise<{ bearer: string; refreshToken: string; userId: string; secret: string; recoveryCodes: string[] }> {
  const signed = await signIn(server, 'native', EMAIL);
  const userId = userIdOf(signed.body);
  const seeded = await seedTotp(server, userId);
  if (signed.body.status !== 'signed_in' || !('refreshToken' in signed.body)) throw new Error('expected a native refresh token');
  return { bearer: accessTokenOf(signed.body), refreshToken: signed.body.refreshToken, userId, ...seeded };
}

/** The same session's next access token, once the first has run out. */
async function refreshed(server: AuthTestServer, refreshToken: string): Promise<string> {
  const response = await call(server.url, '/auth/refresh', { json: { platform: 'native', refreshToken } });
  const body = await response.json() as { accessToken?: string };
  if (response.status !== 200 || body.accessToken === undefined) throw new Error(`refresh failed (${String(response.status)})`);
  return body.accessToken;
}

function start(server: AuthTestServer, bearer: string, proof: { code?: string; recoveryCode?: string }): Promise<Response> {
  return call(server.url, '/auth/totp/reset', { bearer, json: proof });
}

function confirm(server: AuthTestServer, bearer: string, code: string): Promise<Response> {
  return call(server.url, '/auth/totp/reset/confirm', { bearer, json: { code } });
}

/** Starts a reset with a code from the current authenticator and returns the new secret. */
async function started(server: AuthTestServer, bearer: string, secret: string): Promise<string> {
  const response = await start(server, bearer, { code: currentCode(secret, server) });
  const body = await response.json() as ResetBody;
  if (response.status !== 200 || body.secret === undefined) throw new Error(`reset start failed (${String(response.status)})`);
  return body.secret;
}

/** Signs in again by magic link and answers the second step; the response of /auth/mfa/verify. */
async function signInWith(server: AuthTestServer, fields: { code?: string; recoveryCode?: string }): Promise<Response> {
  const requested = await call(server.url, '/auth/magic-link', { json: { email: EMAIL, platform: 'native' } });
  if (requested.status !== 202) throw new Error(`magic link failed (${String(requested.status)})`);
  const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
  const redeemed = await call(server.url, '/auth/magic-link/redeem', {
    json: { token: link.token, email: link.email, platform: 'native' },
  });
  const body = await redeemed.json() as { mfaToken?: string };
  if (redeemed.status !== 200 || body.mfaToken === undefined) throw new Error(`expected mfa_required (${String(redeemed.status)})`);
  return call(server.url, '/auth/mfa/verify', { json: { mfaToken: body.mfaToken, platform: 'native', ...fields } });
}

test('reset: a code from the current authenticator starts it, and a code from the new one swaps the secret and the recovery codes', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const response = await start(server, person.bearer, { code: currentCode(person.secret, server) });
    expect(response.status).toBe(200);
    const body = await response.json() as ResetBody;
    expect(body.qrPngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(body.otpauthUri).toContain(`secret=${body.secret ?? ''}`);
    const next = body.secret;
    if (next === undefined) throw new Error('expected a secret');
    expect(next).not.toBe(person.secret);
    expect(body.expiresAt).toBe(new Date(server.clock.now().getTime() + 10 * 60 * 1000).toISOString());

    const confirmed = await confirm(server, person.bearer, currentCode(next, server));
    expect(confirmed.status).toBe(200);
    const fresh = (await confirmed.json() as ResetBody).recoveryCodes ?? [];
    expect(fresh).toHaveLength(10);
    expect(fresh.some((code) => person.recoveryCodes.includes(code))).toBe(false);
    const factor = await server.stores.totp.get(person.userId);
    expect(factor).toMatchObject({ status: 'enabled', pendingSecretEnc: null, pendingExpiresAt: null, pendingSessionId: null });
    expect(factor?.recoveryCodeHashes).toHaveLength(10);

    // From now on only the new authenticator signs in, and the old recovery codes are void.
    server.clock.advance(2 * STEP_MS);
    expect((await signInWith(server, { code: currentCode(person.secret, server) })).status).toBe(400);
    expect((await signInWith(server, { recoveryCode: person.recoveryCodes[0] ?? '' })).status).toBe(400);
    expect((await signInWith(server, { code: currentCode(next, server) })).status).toBe(200);
    expect((await signInWith(server, { recoveryCode: fresh[0] ?? '' })).status).toBe(200);
    // The swap is done once.
    expect((await confirm(server, person.bearer, currentCode(next, server))).status).toBe(400);
  });
});

test('reset: leaving after the QR keeps the existing two-step sign-in exactly as it was', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const before = await server.stores.totp.get(person.userId);
    const next = await started(server, person.bearer, person.secret);
    const during = await server.stores.totp.get(person.userId);
    expect(during?.secretEnc).toBe(before?.secretEnc);
    expect(during?.recoveryCodeHashes).toEqual(before?.recoveryCodeHashes);
    expect(during?.enabledAt).toEqual(before?.enabledAt);
    // The person walks away. The old authenticator and the old recovery codes still sign in; the new secret does not.
    server.clock.advance(2 * STEP_MS);
    expect((await signInWith(server, { code: currentCode(next, server) })).status).toBe(400);
    expect((await signInWith(server, { code: currentCode(person.secret, server) })).status).toBe(200);
    expect((await signInWith(server, { recoveryCode: person.recoveryCodes[0] ?? '' })).status).toBe(200);
    // Once the pending secret has expired a code from it confirms nothing.
    server.clock.advance(10 * 60 * 1000);
    const late = await confirm(server, await refreshed(server, person.refreshToken), currentCode(next, server));
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ error: 'enrollment_expired' });
    expect((await server.stores.totp.get(person.userId))?.secretEnc).toBe(before?.secretEnc);
  });
});

test('reset: a wrong code from the new authenticator does not swap, and the right one still can', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const before = await server.stores.totp.get(person.userId);
    const next = await started(server, person.bearer, person.secret);
    const wrong = await confirm(server, person.bearer, otherCode([person.secret, next], server.clock.now()));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_code' });
    // A code from the OLD authenticator is not a confirmation either.
    server.clock.advance(2 * STEP_MS);
    expect((await confirm(server, person.bearer, currentCode(person.secret, server))).status).toBe(400);
    const after = await server.stores.totp.get(person.userId);
    expect(after?.secretEnc).toBe(before?.secretEnc);
    expect(after?.recoveryCodeHashes).toEqual(before?.recoveryCodeHashes);
    expect((await confirm(server, person.bearer, currentCode(next, server))).status).toBe(200);
  });
});

test('reset: a recovery code is proof, is spent at the start, and cannot start a second reset', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const recoveryCode = person.recoveryCodes[3] ?? '';
    const response = await start(server, person.bearer, { recoveryCode: recoveryCode.toUpperCase() });
    expect(response.status).toBe(200);
    const next = (await response.json() as ResetBody).secret;
    if (next === undefined) throw new Error('expected a secret');
    expect((await server.stores.totp.get(person.userId))?.recoveryCodeHashes).toHaveLength(9);
    const replayed = await start(server, person.bearer, { recoveryCode });
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_code' });
    // The replay left the pending secret alone.
    expect((await confirm(server, person.bearer, currentCode(next, server))).status).toBe(200);
  });
});

test('reset: the proof is required and a replayed code fails', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    expect((await start(server, person.bearer, {})).status).toBe(400);
    expect((await start(server, person.bearer, { code: '123456', recoveryCode: person.recoveryCodes[0] ?? '' })).status).toBe(400);
    const wrong = await start(server, person.bearer, { code: otherCode([person.secret], server.clock.now()) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_code' });
    expect((await server.stores.totp.get(person.userId))?.pendingSecretEnc).toBeNull();
    const code = currentCode(person.secret, server);
    expect((await start(server, person.bearer, { code })).status).toBe(200);
    const pending = (await server.stores.totp.get(person.userId))?.pendingSecretEnc;
    const replayed = await start(server, person.bearer, { code });
    expect(replayed.status).toBe(400);
    expect((await server.stores.totp.get(person.userId))?.pendingSecretEnc).toBe(pending);
    expect((await call(server.url, '/auth/totp/reset', { json: { code } })).status).toBe(401);
  });
});

test('reset: only the session that started it can confirm it', async () => {
  await withServer(async (server) => {
    const first = await signIn(server, 'native', EMAIL);
    const second = await signIn(server, 'native', EMAIL);
    const seeded = await seedTotp(server, userIdOf(first.body));
    const next = await started(server, accessTokenOf(first.body), seeded.secret);
    const other = await confirm(server, accessTokenOf(second.body), currentCode(next, server));
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: 'enrollment_expired' });
    // Another person's session reaches only its own factor.
    const stranger = await signIn(server, 'native', 'bea@example.test');
    expect((await confirm(server, accessTokenOf(stranger.body), currentCode(next, server))).status).toBe(400);
    expect((await start(server, accessTokenOf(stranger.body), { code: currentCode(seeded.secret, server) })).status).toBe(409);
    // Confirming signs out the other session and keeps this one.
    expect((await confirm(server, accessTokenOf(first.body), currentCode(next, server))).status).toBe(200);
    expect((await call(server.url, '/auth/me', { bearer: accessTokenOf(first.body) })).status).toBe(200);
    expect((await call(server.url, '/auth/me', { bearer: accessTokenOf(second.body) })).status).toBe(401);
  });
});

test('reset: without two-step sign-in on it is 409, and a late session must sign in again', async () => {
  await withServer(async (server) => {
    const plain = await signIn(server, 'native', 'bea@example.test');
    const refused = await start(server, accessTokenOf(plain.body), { code: '123456' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'totp_not_enabled' });
    // A pending first enrollment is not "on".
    await call(server.url, '/auth/totp/enroll', { method: 'POST', bearer: accessTokenOf(plain.body) });
    expect((await start(server, accessTokenOf(plain.body), { code: '123456' })).status).toBe(409);
    expect((await confirm(server, accessTokenOf(plain.body), '123456')).status).toBe(400);

    const person = await enrolled(server);
    const next = await started(server, person.bearer, person.secret);
    // The same session, refreshed, 15 minutes after its sign-in: the first factor is no longer recent.
    server.clock.advance(15 * 60 * 1000 + 1000);
    const bearer = await refreshed(server, person.refreshToken);
    const stale = await confirm(server, bearer, currentCode(next, server));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: 'reauth_required' });
    expect((await start(server, bearer, { code: currentCode(person.secret, server) })).status).toBe(403);
  });
});

test('reset: the proof and the confirmation share the two-step limiter with sign-in', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const wrong = otherCode([person.secret], server.clock.now());
    // Two wrong sign-in codes, then three wrong proofs: five attempts in the window.
    expect((await signInWith(server, { code: wrong })).status).toBe(400);
    expect((await signInWith(server, { code: wrong })).status).toBe(400);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await start(server, person.bearer, { code: wrong })).status).toBe(400);
    }
    const sixth = await start(server, person.bearer, { code: currentCode(person.secret, server) });
    expect(sixth.status).toBe(429);
    expect((await server.stores.totp.get(person.userId))?.pendingSecretEnc).toBeNull();
  });
});

test('reset: wrong confirmations are limited too, and a limited one swaps nothing', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const before = await server.stores.totp.get(person.userId);
    const next = await started(server, person.bearer, person.secret);
    const wrong = otherCode([person.secret, next], server.clock.now());
    // The start was the first attempt of the window; four wrong confirmations fill it.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await confirm(server, person.bearer, wrong)).status).toBe(400);
    }
    expect((await confirm(server, person.bearer, currentCode(next, server))).status).toBe(429);
    expect((await server.stores.totp.get(person.userId))?.secretEnc).toBe(before?.secretEnc);
  });
});

test('reset: the logs name the user and never the secret, the code or the recovery code', async () => {
  await withServer(async (server) => {
    const person = await enrolled(server);
    const recoveryCode = person.recoveryCodes[0] ?? '';
    const response = await start(server, person.bearer, { recoveryCode });
    const next = (await response.json() as ResetBody).secret ?? '';
    const code = currentCode(next, server);
    const confirmed = await confirm(server, person.bearer, code);
    const fresh = (await confirmed.json() as ResetBody).recoveryCodes ?? [];
    const lines = server.logs;
    expect(lines.some((line) => line.includes('auth.totp_reset_started') && line.includes(person.userId))).toBe(true);
    expect(lines.some((line) => line.includes('"auth.totp_reset"') && line.includes(person.userId))).toBe(true);
    const text = lines.join('\n');
    for (const secret of [next, person.secret, recoveryCode, recoveryCode.replace(/-/g, ''), code, ...fresh]) {
      expect(text.includes(secret)).toBe(false);
    }
  });
});
