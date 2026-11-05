import { createSecretKey, randomBytes, type KeyObject } from 'node:crypto';

import { AppError } from '@ckeith26/server-core';
import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from 'jose';
import { expect, test } from 'vitest';

import type { KeyringEntry } from '../src/config.ts';
import { createTokens } from '../src/tokens.ts';

const ISSUER = 'https://api.example.test';
const NOW = new Date('2026-06-01T00:00:00.000Z');

function entry(kid: string, bytes = 32): KeyringEntry {
  return { kid, key: createSecretKey(randomBytes(bytes)) };
}

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function expectUnauthenticated(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  await expect(promise).rejects.toBeInstanceOf(AppError);
}

test('signs access tokens with HS256, typ at+jwt, kid and a 600 s lifetime', async () => {
  const keys = [entry('k1')];
  const tokens = createTokens({ issuer: ISSUER, keys });
  const { token, expiresAt } = await tokens.signAccess({ sub: 'user', sid: 'sess' }, NOW);
  expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' });
  const payload = decodeJwt(token);
  expect(payload.exp).toBeDefined();
  expect(payload.iat).toBeDefined();
  expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
  expect(payload.aud).toBe(ISSUER);
  expect(payload.iss).toBe(ISSUER);
  expect(expiresAt).toEqual(new Date((payload.exp ?? 0) * 1000));
  await expect(tokens.verifyAccess(token, NOW)).resolves.toMatchObject({ sub: 'user', sid: 'sess' });
});

test('rejects alg none, HS512 and RS256 tokens', async () => {
  const keys = [entry('k1', 64)];
  const tokens = createTokens({ issuer: ISSUER, keys });
  const iat = Math.floor(NOW.getTime() / 1000);
  const payload = { iss: ISSUER, aud: ISSUER, sub: 'user', sid: 'sess', iat, exp: iat + 600 };
  const none = `${b64({ alg: 'none', typ: 'at+jwt', kid: 'k1' })}.${b64(payload)}.`;
  const hs512 = await new SignJWT({ sid: 'sess' })
    .setProtectedHeader({ alg: 'HS512', typ: 'at+jwt', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setSubject('user')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(keys[0]?.key ?? entry('k1').key);
  const { privateKey } = await generateKeyPair('RS256');
  const rs256 = await new SignJWT({ sid: 'sess' })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setSubject('user')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(privateKey);
  await expectUnauthenticated(tokens.verifyAccess(none, NOW));
  await expectUnauthenticated(tokens.verifyAccess(hs512, NOW));
  await expectUnauthenticated(tokens.verifyAccess(rs256, NOW));
});

test('rejects wrong iss, wrong aud, missing sid, expired and unknown kid', async () => {
  const keys = [entry('k1')];
  const tokens = createTokens({ issuer: ISSUER, keys });
  const iat = Math.floor(NOW.getTime() / 1000);
  const secret = keys[0]?.key ?? entry('k1').key;
  async function crafted(mutate: (jwt: SignJWT) => SignJWT, header?: Record<string, string>): Promise<string> {
    const jwt = mutate(new SignJWT({ sid: 'sess' }).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'k1', ...header }));
    return jwt.setSubject('user').setIssuedAt(iat).setExpirationTime(iat + 600).sign(secret);
  }
  const wrongIss = await crafted((jwt) => jwt.setIssuer('https://other.example.test').setAudience(ISSUER));
  const wrongAud = await crafted((jwt) => jwt.setIssuer(ISSUER).setAudience('https://other.example.test'));
  const missingSid = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setSubject('user')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(secret);
  const unknownKid = await crafted((jwt) => jwt.setIssuer(ISSUER).setAudience(ISSUER), { kid: 'missing' });
  await expectUnauthenticated(tokens.verifyAccess(wrongIss, NOW));
  await expectUnauthenticated(tokens.verifyAccess(wrongAud, NOW));
  await expectUnauthenticated(tokens.verifyAccess(missingSid, NOW));
  await expectUnauthenticated(tokens.verifyAccess(unknownKid, NOW));
  const { token } = await tokens.signAccess({ sub: 'user', sid: 'sess' }, NOW);
  await expectUnauthenticated(tokens.verifyAccess(token, new Date(NOW.getTime() + 700_000)));
});

test('an mfa token is not an access token and an access token is not an mfa token', async () => {
  const tokens = createTokens({ issuer: ISSUER, keys: [entry('k1')] });
  const access = await tokens.signAccess({ sub: 'user', sid: 'sess' }, NOW);
  const mfa = await tokens.signMfa({ sub: 'user', plat: 'web' }, NOW);
  await expectUnauthenticated(tokens.verifyAccess(mfa.token, NOW));
  await expect(tokens.verifyMfa(access.token, NOW)).rejects.toMatchObject({ status: 401, code: 'invalid_mfa_token' });
});

test('a key appended but not yet first verifies tokens it signed', async () => {
  const oldKey = entry('old');
  const newKey = entry('new');
  const { token } = await createTokens({ issuer: ISSUER, keys: [newKey] }).signAccess({ sub: 'user', sid: 'sess' }, NOW);
  await expect(createTokens({ issuer: ISSUER, keys: [oldKey, newKey] }).verifyAccess(token, NOW)).resolves.toMatchObject({
    sub: 'user',
    sid: 'sess',
  });
});

test('a removed key fails', async () => {
  const oldKey = entry('old');
  const newKey = entry('new');
  const { token } = await createTokens({ issuer: ISSUER, keys: [oldKey] }).signAccess({ sub: 'user', sid: 'sess' }, NOW);
  await expectUnauthenticated(createTokens({ issuer: ISSUER, keys: [newKey] }).verifyAccess(token, NOW));
});

test('a non-jose error from the key lookup is rethrown, not mapped to 401', async () => {
  const real = entry('k1');
  const { token } = await createTokens({ issuer: ISSUER, keys: [real] }).signAccess({ sub: 'user', sid: 'sess' }, NOW);
  const boom: KeyringEntry = {
    kid: 'k1',
    get key(): KeyObject {
      throw new TypeError('lookup failed');
    },
  };
  await expect(createTokens({ issuer: ISSUER, keys: [boom] }).verifyAccess(token, NOW)).rejects.toBeInstanceOf(TypeError);
});
