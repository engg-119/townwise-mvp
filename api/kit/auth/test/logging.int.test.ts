import { randomBytes } from 'node:crypto';

import { expect, test } from 'vitest';

import { codeAt, stepAt } from '../src/totp/totp.ts';
import type { SignInResult } from '../src/index.ts';
import { call, WEB_ORIGIN } from './helpers/http.ts';
import { CLIENT_IDS, createGoogleFake } from './helpers/google-fake.ts';
import { parseLink } from './helpers/mail.ts';
import { seedTotp, signIn, startAuthServer, type AuthTestServer } from './helpers/server.ts';

function leaks(line: string, secret: string): boolean {
  if (/^\d{6}$/.test(secret)) return new RegExp(String.raw`(?<!\d)${secret}(?!\d)`).test(line);
  return line.includes(secret);
}

function assertClean(logs: readonly string[], secrets: readonly string[]): void {
  for (const line of logs) {
    for (const secret of secrets) {
      expect(leaks(line, secret), line).toBe(false);
    }
  }
}

function nativeTokens(body: SignInResult): { accessToken: string; refreshToken: string } {
  if (body.status !== 'signed_in' || !('accessToken' in body)) throw new Error('expected native tokens');
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

test('no log line contains a token, code or credential header', async () => {
  const fake = await createGoogleFake();
  const server: AuthTestServer = await startAuthServer({
    env: { AUTH_GOOGLE_CLIENT_IDS: CLIENT_IDS.join(',') },
    deps: { googleKeys: fake.keys },
  });
  const secrets: string[] = ['ada@example.test', 'bea@example.test', 'ada@gmail.com'];
  try {
    const native = await signIn(server, 'native', 'ada@example.test');
    const tokens = nativeTokens(native.body);
    secrets.push(tokens.accessToken, tokens.refreshToken, `Bearer ${tokens.accessToken}`);
    const refreshed = await call(server.url, '/auth/refresh', {
      json: { platform: 'native', refreshToken: tokens.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { accessToken: string; refreshToken: string };
    secrets.push(next.accessToken, next.refreshToken, `Bearer ${next.accessToken}`);
    const loggedOut = await call(server.url, '/auth/logout', {
      json: { platform: 'native', refreshToken: next.refreshToken },
      bearer: next.accessToken,
    });
    expect(loggedOut.status).toBe(204);

    const web = await signIn(server, 'web', 'bea@example.test');
    const cookie = web.jar.header();
    if (cookie !== undefined) secrets.push(cookie);
    const access = web.jar.get('__Host-access');
    const refresh = web.jar.get('__Host-refresh');
    if (access !== undefined) secrets.push(access, `Bearer ${access}`);
    if (refresh !== undefined) secrets.push(refresh);
    const webLogout = await call(server.url, '/auth/logout', {
      json: { platform: 'web' },
      origin: WEB_ORIGIN,
      jar: web.jar,
    });
    expect(webLogout.status).toBe(204);

    const totpUser = await server.stores.users.create({ email: 'ada@gmail.com', now: server.clock.now() });
    const seeded = await seedTotp(server, totpUser.id);
    secrets.push(seeded.secret, ...seeded.recoveryCodes);
    for (const code of seeded.recoveryCodes) secrets.push(code.replace(/-/g, ''));
    const code = codeAt(seeded.secret, stepAt(server.clock.now()));
    secrets.push(code, `${code.slice(0, 3)} ${code.slice(3)}`);
    const requested = await call(server.url, '/auth/magic-link', {
      json: { email: 'ada@gmail.com', platform: 'native' },
    });
    expect(requested.status).toBe(202);
    const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
    const redeemed = await call(server.url, '/auth/magic-link/redeem', {
      json: { token: link.token, email: link.email, platform: 'native' },
    });
    const mfaBody = await redeemed.json() as { mfaToken?: string };
    if (mfaBody.mfaToken === undefined) throw new Error('expected an mfa token');
    secrets.push(mfaBody.mfaToken);
    const verified = await call(server.url, '/auth/mfa/verify', {
      json: { mfaToken: mfaBody.mfaToken, platform: 'native', code },
    });
    expect(verified.status).toBe(200);

    const now = Math.floor(server.clock.now().getTime() / 1000);
    const idToken = await fake.signIdToken({
      sub: 'sub-log',
      email: 'bea@gmail.com',
      iat: now,
      exp: now + 3600,
    });
    secrets.push(idToken, 'bea@gmail.com');
    const google = await call(server.url, '/auth/google', {
      json: { idToken, platform: 'native' },
    });
    expect(google.status).toBe(200);

    for (const message of server.mail.messages) {
      secrets.push(message.url, message.to);
      const parsed = parseLink(message.url);
      secrets.push(parsed.token, parsed.email);
    }
    assertClean(server.logs, secrets);
  } finally {
    await server.close();
  }
});

test('a malformed JSON body containing a refresh token appears in no log line', async () => {
  const server = await startAuthServer();
  const token = randomBytes(32).toString('base64url');
  try {
    const res = await call(server.url, '/auth/refresh', {
      rawBody: `{"platform":"native","refreshToken":"${token}"`,
      origin: WEB_ORIGIN,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'malformed_json' });
    assertClean(server.logs, [token]);
  } finally {
    await server.close();
  }
});
