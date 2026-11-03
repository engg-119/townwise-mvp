import { AppError } from '@ckeith26/server-core';
import { errors, jwtVerify, SignJWT, type JWTPayload } from 'jose';

import type { KeyringEntry } from './config.ts';
import type { Platform } from './stores/types.ts';

export const ACCESS_TTL_SECONDS = 600;
export const MFA_TTL_SECONDS = 300;

const JOSE_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
]);

export interface AccessClaims { readonly sub: string; readonly sid: string; readonly iat: number; readonly exp: number }
export interface MfaClaims { readonly sub: string; readonly plat: Platform; readonly iat: number; readonly exp: number }

export interface Tokens {
  signAccess(input: { sub: string; sid: string }, now: Date): Promise<{ token: string; expiresAt: Date }>;
  verifyAccess(token: string, now: Date): Promise<AccessClaims>;
  signMfa(input: { sub: string; plat: Platform }, now: Date): Promise<{ token: string; expiresAt: Date }>;
  verifyMfa(token: string, now: Date): Promise<MfaClaims>;
}

export function isJoseTokenError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  return typeof err.code === 'string' && JOSE_TOKEN_ERRORS.has(err.code);
}

function seconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function signingKey(keys: readonly KeyringEntry[]): KeyringEntry {
  const key = keys[0];
  if (key === undefined) throw new Error('JWT keyring is empty');
  return key;
}

async function sign(input: {
  keys: readonly KeyringEntry[];
  issuer: string;
  typ: 'at+jwt' | 'mfa+jwt';
  subject: string;
  claims: Record<string, string>;
  ttl: number;
  now: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const key = signingKey(input.keys);
  const iat = seconds(input.now);
  const exp = iat + input.ttl;
  const token = await new SignJWT(input.claims)
    .setProtectedHeader({ alg: 'HS256', typ: input.typ, kid: key.kid })
    .setIssuer(input.issuer)
    .setAudience(input.issuer)
    .setSubject(input.subject)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key.key);
  return { token, expiresAt: new Date(exp * 1000) };
}

function keyResolver(keys: readonly KeyringEntry[]) {
  return (header: { kid?: unknown }): KeyringEntry['key'] => {
    if (typeof header.kid !== 'string') throw new errors.JWKSNoMatchingKey();
    const entry = keys.find((candidate) => candidate.kid === header.kid);
    if (entry === undefined) throw new errors.JWKSNoMatchingKey();
    return entry.key;
  };
}

function rejectJose(err: unknown, code: 'unauthenticated' | 'invalid_mfa_token'): never {
  if (!isJoseTokenError(err)) throw err;
  throw new AppError(401, code, code === 'unauthenticated' ? 'Unauthenticated' : 'Invalid MFA token');
}

function numberClaim(payload: JWTPayload, name: 'iat' | 'exp'): number {
  const value = payload[name];
  if (typeof value !== 'number') throw new errors.JWTInvalid(`${name} missing`);
  return value;
}

export function createTokens(opts: { issuer: string; keys: readonly KeyringEntry[] }): Tokens {
  const { issuer, keys } = opts;
  return {
    signAccess(input, now) {
      return sign({
        keys,
        issuer,
        typ: 'at+jwt',
        subject: input.sub,
        claims: { sid: input.sid },
        ttl: ACCESS_TTL_SECONDS,
        now,
      });
    },
    async verifyAccess(token, now) {
      try {
        const { payload } = await jwtVerify(token, keyResolver(keys), {
          algorithms: ['HS256'],
          typ: 'at+jwt',
          issuer,
          audience: issuer,
          requiredClaims: ['sub', 'sid', 'iat', 'exp'],
          clockTolerance: 5,
          currentDate: now,
        });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
          throw new errors.JWTInvalid('access claims missing');
        }
        return { sub: payload.sub, sid: payload.sid, iat: numberClaim(payload, 'iat'), exp: numberClaim(payload, 'exp') };
      } catch (err) {
        rejectJose(err, 'unauthenticated');
      }
    },
    signMfa(input, now) {
      return sign({
        keys,
        issuer,
        typ: 'mfa+jwt',
        subject: input.sub,
        claims: { plat: input.plat },
        ttl: MFA_TTL_SECONDS,
        now,
      });
    },
    async verifyMfa(token, now) {
      try {
        const { payload } = await jwtVerify(token, keyResolver(keys), {
          algorithms: ['HS256'],
          typ: 'mfa+jwt',
          issuer,
          audience: issuer,
          requiredClaims: ['sub', 'plat', 'iat', 'exp'],
          clockTolerance: 5,
          currentDate: now,
        });
        if (typeof payload.sub !== 'string' || (payload.plat !== 'web' && payload.plat !== 'native')) {
          throw new AppError(401, 'invalid_mfa_token', 'Invalid MFA token');
        }
        return {
          sub: payload.sub,
          plat: payload.plat,
          iat: numberClaim(payload, 'iat'),
          exp: numberClaim(payload, 'exp'),
        };
      } catch (err) {
        if (err instanceof AppError) throw err;
        rejectJose(err, 'invalid_mfa_token');
      }
    },
  };
}
