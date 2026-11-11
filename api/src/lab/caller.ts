// Who may call the forecast lab's callback (lab/callback.ts). In Azure, the lab job signs in with its own managed
// identity: it asks Entra for a v2 access token for the lab callback app (infra/terraform/bootstrap/lab.tf, a
// credential-free app registration that is only an audience), and this checks the token's RS256 signature against the
// tenant's keys, the issuer, the audience (the app's client id), the tenant, and that the caller's object id (oid) is
// the lab identity's. Any principal in the tenant can get a token for the app; only the lab identity's passes. In
// development, the local runner hands its job the API process's own random secret, compared here in constant time.
//
// Nothing here logs. A verdict is a reason code or `unavailable` (Entra's keys could not be fetched), never the token or
// an error carrying it.
import { createHash, timingSafeEqual } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type LabCallerRefusal = 'missing' | 'malformed' | 'signature' | 'expired' | 'issuer' | 'audience' | 'tenant' | 'caller';

export type LabCallerVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: LabCallerRefusal }
  | { readonly ok: false; readonly unavailable: true };

export interface LabCaller {
  /** Checks a request's Authorization header. Never throws. */
  verify(authorization: string | undefined): Promise<LabCallerVerdict>;
}

export const ENTRA_LOGIN = 'https://login.microsoftonline.com';
/** An Entra access token is about 1.5 KB; anything near this is not one. */
const MAX_AUTHORIZATION = 8192;
const JWS = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const OK: LabCallerVerdict = { ok: true };

function refused(refusal: LabCallerRefusal): LabCallerVerdict {
  return { ok: false, refusal };
}

/** The refusal for a jose token error, or null for anything else (the keys could not be fetched or read). */
function refusalOf(err: unknown): LabCallerRefusal | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  switch (err.code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = 'claim' in err ? err.claim : undefined;
      if (claim === 'iss') return 'issuer';
      if (claim === 'aud') return 'audience';
      if (claim === 'tid') return 'tenant';
      if (claim === 'oid') return 'caller';
      // Not valid yet; a missing or mistyped exp is malformed.
      return claim === 'nbf' ? 'expired' : 'malformed';
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JOSE_NOT_SUPPORTED':
      return 'signature';
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return 'malformed';
    default:
      return null;
  }
}

/**
 * Production: the lab identity's Entra token for the lab callback app. `audience` is the app's client id (v2 tokens
 * carry it as aud), `callerObjectId` the lab identity's principal id. `keys` defaults to the tenant's v2 key set,
 * fetched on first use and cached by jose; tests pass a local one.
 */
export function createEntraLabCaller(deps: {
  tenantId: string;
  audience: string;
  callerObjectId: string;
  now: () => Date;
  keys?: JWTVerifyGetKey;
}): LabCaller {
  const keys = deps.keys ?? createRemoteJWKSet(new URL(`${ENTRA_LOGIN}/${deps.tenantId}/discovery/v2.0/keys`));
  const issuer = `${ENTRA_LOGIN}/${deps.tenantId}/v2.0`;
  return {
    async verify(authorization) {
      if (authorization === undefined || authorization === '') return refused('missing');
      const token = authorization.length > MAX_AUTHORIZATION ? undefined : JWS.exec(authorization)?.[1];
      if (token === undefined) return refused('malformed');
      try {
        const { payload } = await jwtVerify(token, keys, {
          algorithms: ['RS256'],
          issuer,
          audience: deps.audience,
          requiredClaims: ['oid', 'tid', 'exp', 'nbf'],
          clockTolerance: 5,
          currentDate: deps.now(),
        });
        if (payload.tid !== deps.tenantId) return refused('tenant');
        if (payload.oid !== deps.callerObjectId) return refused('caller');
        return OK;
      } catch (err) {
        const refusal = refusalOf(err);
        return refusal === null ? { ok: false, unavailable: true } : refused(refusal);
      }
    },
  };
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Development: `Bearer <secret>`, the secret main.ts makes per API process and the local runner hands its job. */
export function createLocalLabCaller(secret: string): LabCaller {
  const expected = sha256(secret);
  return {
    verify(authorization) {
      if (authorization === undefined || authorization === '') return Promise.resolve(refused('missing'));
      if (!authorization.startsWith('Bearer ') || authorization.length > MAX_AUTHORIZATION) return Promise.resolve(refused('malformed'));
      // Both sides hashed, so the comparison takes the same time whatever the given secret's length.
      return Promise.resolve(timingSafeEqual(sha256(authorization.slice('Bearer '.length)), expected) ? OK : refused('caller'));
    },
  };
}
