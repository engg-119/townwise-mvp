// Who may call the forecast lab's callback (lab/caller.ts): the lab job's managed identity, by an Entra v2 access token
// for the lab callback app, checked against a local key set here; or, in development, the API process's own secret.
// A verdict names a reason and never carries the token.
import { randomBytes } from 'node:crypto';

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createEntraLabCaller, createLocalLabCaller, type LabCaller, type LabCallerVerdict } from '../src/lab/caller.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AUDIENCE = '22222222-2222-4222-8222-222222222222';
const LAB_OID = '33333333-3333-4333-8333-333333333333';
const API_OID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const SECONDS = Math.floor(NOW.getTime() / 1000);
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

let signing: CryptoKey;
let stranger: CryptoKey;
let publicJwk: JWK;
let keys: JWTVerifyGetKey;
let caller: LabCaller;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signing = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', use: 'sig' };
  stranger = (await generateKeyPair('RS256')).privateKey;
  keys = createLocalJWKSet({ keys: [publicJwk] });
  caller = createEntraLabCaller({ tenantId: TENANT, audience: AUDIENCE, callerObjectId: LAB_OID, now: () => NOW, keys });
});

interface Claims { iss?: string; aud?: string; tid?: string; oid?: string; nbf?: number; exp?: number }

/** An Entra v2 access token for the lab callback app, as the lab identity gets it, with `over` applied. */
async function token(over: Claims & { key?: CryptoKey; kid?: string; omit?: (keyof Claims)[] } = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: ISSUER, aud: AUDIENCE, tid: TENANT, oid: LAB_OID, iat: SECONDS - 60, nbf: SECONDS - 60, exp: SECONDS + 3600, ver: '2.0',
  };
  for (const [name, value] of Object.entries(over)) if (name in claims) claims[name] = value;
  const omitted = new Set<string>(over.omit ?? []);
  return new SignJWT(Object.fromEntries(Object.entries(claims).filter(([name]) => !omitted.has(name)))).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: over.kid ?? 'k1' }).sign(over.key ?? signing);
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function verdictOf(authorization: string | undefined, by: LabCaller = caller): Promise<LabCallerVerdict> {
  const verdict = await by.verify(authorization);
  // No verdict carries the header or any part of a token.
  const text = JSON.stringify(verdict);
  for (const part of (authorization ?? '').replace(/^\w+ /, '').split('.')) {
    if (part.length > 8) expect(text).not.toContain(part);
  }
  return verdict;
}

describe('the Entra lab caller', () => {
  it('accepts the lab identity’s v2 token for the callback app', async () => {
    expect(await verdictOf(`Bearer ${await token()}`)).toEqual({ ok: true });
    // Within the 5-second tolerance either side.
    expect(await verdictOf(`Bearer ${await token({ nbf: SECONDS + 4 })}`)).toEqual({ ok: true });
    expect(await verdictOf(`Bearer ${await token({ exp: SECONDS - 4 })}`)).toEqual({ ok: true });
  });

  it('refuses a token for another audience, including ARM, the federation audience and the v1 form of its own', async () => {
    for (const aud of ['https://management.azure.com/', 'api://AzureADTokenExchange', `api://${AUDIENCE}`, API_OID]) {
      expect(await verdictOf(`Bearer ${await token({ aud })}`)).toEqual({ ok: false, refusal: 'audience' });
    }
  });

  it('refuses a v1 issuer or another tenant’s issuer', async () => {
    for (const iss of [`https://sts.windows.net/${TENANT}/`, 'https://login.microsoftonline.com/55555555-5555-4555-8555-555555555555/v2.0']) {
      expect(await verdictOf(`Bearer ${await token({ iss })}`)).toEqual({ ok: false, refusal: 'issuer' });
    }
  });

  it('refuses another tenant’s tid and any caller but the lab identity', async () => {
    expect(await verdictOf(`Bearer ${await token({ tid: '55555555-5555-4555-8555-555555555555' })}`)).toEqual({ ok: false, refusal: 'tenant' });
    // The API's own identity, or anyone else in the tenant, can get a token for the app; only the lab identity's passes.
    expect(await verdictOf(`Bearer ${await token({ oid: API_OID })}`)).toEqual({ ok: false, refusal: 'caller' });
  });

  it('refuses a token past its expiry or before its start, beyond 5 seconds', async () => {
    expect(await verdictOf(`Bearer ${await token({ exp: SECONDS - 6 })}`)).toEqual({ ok: false, refusal: 'expired' });
    expect(await verdictOf(`Bearer ${await token({ nbf: SECONDS + 6 })}`)).toEqual({ ok: false, refusal: 'expired' });
  });

  it('refuses a token missing oid, tid, nbf or exp', async () => {
    for (const omit of [['oid'], ['tid'], ['nbf'], ['exp']] as (keyof Claims)[][]) {
      const verdict = await verdictOf(`Bearer ${await token({ omit })}`);
      expect(verdict.ok).toBe(false);
      expect('unavailable' in verdict).toBe(false);
    }
  });

  it('refuses a token signed by another key, an unknown kid, HS256 with the public key, or alg none', async () => {
    expect(await verdictOf(`Bearer ${await token({ key: stranger })}`)).toEqual({ ok: false, refusal: 'signature' });
    expect(await verdictOf(`Bearer ${await token({ kid: 'k2' })}`)).toEqual({ ok: false, refusal: 'signature' });
    const claims = { iss: ISSUER, aud: AUDIENCE, tid: TENANT, oid: LAB_OID, nbf: SECONDS - 60, exp: SECONDS + 3600 };
    const hs256 = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));
    expect(await verdictOf(`Bearer ${hs256}`)).toEqual({ ok: false, refusal: 'signature' });
    const unsigned = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}`;
    // With an empty signature the header is not a token at all; with any signature, alg none is not RS256.
    expect(await verdictOf(`Bearer ${unsigned}.`)).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verdictOf(`Bearer ${unsigned}.${randomBytes(32).toString('base64url')}`)).toEqual({ ok: false, refusal: 'signature' });
  });

  it('refuses a missing header, another scheme, garbage and an over-long header', async () => {
    expect(await verdictOf(undefined)).toEqual({ ok: false, refusal: 'missing' });
    expect(await verdictOf('')).toEqual({ ok: false, refusal: 'missing' });
    const good = await token();
    expect(await verdictOf(`Basic ${good}`)).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verdictOf(`bearer ${good}`)).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verdictOf(`Bearer ${good} `)).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verdictOf('Bearer aaaaaaaaaa.bbbbbbbbbb.cccccccccc')).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verdictOf(`Bearer ${'a'.repeat(4000)}.${'b'.repeat(4000)}.${'c'.repeat(400)}`)).toEqual({ ok: false, refusal: 'malformed' });
  });

  it('answers unavailable, not a refusal, when Entra’s keys cannot be fetched', async () => {
    const down = (err: Error): LabCaller => createEntraLabCaller({
      tenantId: TENANT, audience: AUDIENCE, callerObjectId: LAB_OID, now: () => NOW, keys: () => Promise.reject(err),
    });
    const good = `Bearer ${await token()}`;
    expect(await verdictOf(good, down(new TypeError('fetch failed')))).toEqual({ ok: false, unavailable: true });
    expect(await verdictOf(good, down(Object.assign(new Error('timed out'), { code: 'ERR_JWKS_TIMEOUT' })))).toEqual({ ok: false, unavailable: true });
    // A refusal that needs no key is still a refusal.
    expect(await verdictOf(undefined, down(new TypeError('fetch failed')))).toEqual({ ok: false, refusal: 'missing' });
  });
});

describe('the local lab caller', () => {
  it('accepts exactly the process secret and refuses anything else', async () => {
    const secret = randomBytes(32).toString('base64url');
    const local = createLocalLabCaller(secret);
    expect(await verdictOf(`Bearer ${secret}`, local)).toEqual({ ok: true });
    for (const wrong of [secret.slice(0, -1), `${secret}x`, randomBytes(32).toString('base64url')]) {
      expect(await verdictOf(`Bearer ${wrong}`, local)).toEqual({ ok: false, refusal: 'caller' });
    }
    expect(await verdictOf('', local)).toEqual({ ok: false, refusal: 'missing' });
    expect(await verdictOf(undefined, local)).toEqual({ ok: false, refusal: 'missing' });
    expect(await verdictOf(`Basic ${secret}`, local)).toEqual({ ok: false, refusal: 'malformed' });
  });
});
