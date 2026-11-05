import { AppError, parseInput } from '@ckeith26/server-core';
import { ipKey } from '@ckeith26/rate-limit';
import type { Request, Response, Router } from 'express';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

import type { AuthRuntime } from './create-auth.ts';
import { normalizeEmail } from './email-id.ts';
import { mountMethod } from './http.ts';
import { googleBody } from './routes.ts';
import { completeSignIn, runOnUserCreated } from './sign-in.ts';
import { DuplicateError, type User } from './stores/types.ts';
import { isJoseTokenError } from './tokens.ts';
import { resolvePlatform } from './transport.ts';

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleClaims {
  readonly sub: string;
  readonly email: string;
  readonly hd?: string;
  readonly iat: number;
  readonly exp: number;
}

const GOOGLE_TOKEN_MESSAGE = 'Invalid Google token';

function claim(payload: JWTPayload, name: string): unknown {
  return payload[name];
}

function invalidGoogleToken(): AppError {
  return new AppError(401, 'invalid_google_token', GOOGLE_TOKEN_MESSAGE);
}

/** aud a single string; sub 1..255; email normalizes, <= 254; exp > iat; hd non-empty if present: else AppError(401, 'invalid_google_token').
 *  email_verified must be true or 'true': else AppError(403, 'google_email_unverified'). */
export function parseGoogleClaims(payload: JWTPayload): GoogleClaims {
  const aud = payload.aud;
  if (typeof aud !== 'string') throw invalidGoogleToken();
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > 255) throw invalidGoogleToken();
  const emailRaw = claim(payload, 'email');
  if (typeof emailRaw !== 'string') throw invalidGoogleToken();
  const email = normalizeEmail(emailRaw);
  if (email === null) throw invalidGoogleToken();
  const iat = payload.iat;
  const exp = payload.exp;
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat) throw invalidGoogleToken();
  const hdRaw = claim(payload, 'hd');
  if (hdRaw !== undefined && (typeof hdRaw !== 'string' || hdRaw.length === 0)) throw invalidGoogleToken();
  const verified = claim(payload, 'email_verified');
  if (verified !== true && verified !== 'true') {
    throw new AppError(403, 'google_email_unverified', 'Google email is not verified');
  }
  const claims: GoogleClaims = { sub, email, iat, exp };
  if (typeof hdRaw === 'string') return { ...claims, hd: hdRaw };
  return claims;
}

function joseCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/** 401 invalid_google_token for the 3-auth.md 2.1 allowlist plus ERR_JWKS_NO_MATCHING_KEY and ERR_JWKS_MULTIPLE_MATCHING_KEYS; anything else 503 google_unavailable. */
export function classifyGoogleError(err: unknown): AppError {
  const code = joseCode(err);
  const tokenError = isJoseTokenError(err) || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS';
  if (tokenError) return new AppError(401, 'invalid_google_token', GOOGLE_TOKEN_MESSAGE, { cause: err });
  return new AppError(503, 'google_unavailable', 'Google is temporarily unavailable', { cause: err });
}

export async function verifyGoogleIdToken(
  idToken: string,
  deps: { keys: JWTVerifyGetKey; clientIds: readonly string[]; now: Date },
): Promise<GoogleClaims> {
  try {
    const { payload } = await jwtVerify(idToken, deps.keys, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: [...deps.clientIds],
      requiredClaims: ['sub', 'email', 'iat', 'exp'],
      clockTolerance: 5,
      currentDate: deps.now,
    });
    return parseGoogleClaims(payload);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw classifyGoogleError(err);
  }
}

/**
 * A-L2. Which Google emails may create, link or update an account.
 * Gmail plus Workspace hd follows Google's own guidance and refuses some
 * legitimate users. Trusting any verified email admits pre-hijack of addresses
 * whose ownership has changed.
 * Choice: authoritative when the email is @gmail.com or hd is present.
 */
export function isGoogleAuthoritative(claims: GoogleClaims): boolean {
  return claims.email.endsWith('@gmail.com') || claims.hd !== undefined;
}

async function signInExisting(rt: AuthRuntime, user: User, claims: GoogleClaims): Promise<User> {
  if (user.email === claims.email || !isGoogleAuthoritative(claims)) return user;
  try {
    const updated = await rt.stores.users.updateEmail({ id: user.id, from: user.email, to: claims.email });
    if (updated === null) {
      const again = await rt.stores.users.findById(user.id);
      if (again === null) throw new AppError(500, 'internal', 'Internal server error');
      return again;
    }
    rt.logger.info({ userId: updated.id }, 'auth.google_email_updated');
    return updated;
  } catch (err) {
    if (!(err instanceof DuplicateError)) throw err;
    rt.logger.info({ userId: user.id }, 'auth.google_email_conflict');
    throw new AppError(409, 'google_email_conflict', 'Google email is already used');
  }
}

async function linkOrCreate(rt: AuthRuntime, claims: GoogleClaims): Promise<{ user: User; isNewUser: boolean }> {
  const byEmail = await rt.stores.users.findByEmail(claims.email);
  if (byEmail !== null) {
    if (byEmail.googleSubject !== null && byEmail.googleSubject !== claims.sub) {
      throw new AppError(409, 'email_linked_to_other_google_account', 'Email is linked to another Google account');
    }
    const linked = await rt.stores.users.linkGoogleSubject({ id: byEmail.id, subject: claims.sub });
    if (linked !== null) return { user: linked, isNewUser: false };
    const again = await rt.stores.users.findById(byEmail.id);
    if (again !== null && again.googleSubject === claims.sub) return { user: again, isNewUser: false };
    throw new AppError(409, 'email_linked_to_other_google_account', 'Email is linked to another Google account');
  }
  const created = await rt.stores.users.create({
    email: claims.email,
    googleSubject: claims.sub,
    now: rt.now(),
  });
  rt.logger.info({ userId: created.id }, 'auth.user_created');
  await runOnUserCreated(rt, created);
  return { user: created, isNewUser: true };
}

async function resolveOnce(rt: AuthRuntime, claims: GoogleClaims): Promise<{ user: User; isNewUser: boolean }> {
  const bySub = await rt.stores.users.findByGoogleSubject(claims.sub);
  if (bySub !== null) return { user: await signInExisting(rt, bySub, claims), isNewUser: false };
  if (!isGoogleAuthoritative(claims)) {
    throw new AppError(403, 'google_email_not_authoritative', 'Google is not authoritative for this email');
  }
  return linkOrCreate(rt, claims);
}

/** 3-auth.md 2.7 account resolution steps 1 to 4 with the one re-run on DuplicateError. */
export async function resolveGoogleUser(
  rt: AuthRuntime,
  claims: GoogleClaims,
): Promise<{ user: User; isNewUser: boolean }> {
  try {
    return await resolveOnce(rt, claims);
  } catch (err) {
    if (!(err instanceof DuplicateError)) throw err;
  }
  try {
    return await resolveOnce(rt, claims);
  } catch (err) {
    if (err instanceof DuplicateError) {
      throw new AppError(409, 'email_linked_to_other_google_account', 'Email is linked to another Google account');
    }
    throw err;
  }
}

function logRejected(rt: AuthRuntime, err: unknown): void {
  if (!(err instanceof AppError)) return;
  if (err.code !== 'invalid_google_token' && err.code !== 'google_unavailable') return;
  const reason = joseCode(err.cause);
  if (reason === undefined) return;
  rt.logger.info({ reason }, 'auth.google_rejected');
}

async function googleSignIn(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const body = parseInput(googleBody, req.body);
  const platform = resolvePlatform(req.headers, body.platform, rt.config.webOrigins);
  await rt.limits.consume('ip', ipKey(req));
  const clientIds = rt.config.googleClientIds;
  if (clientIds === null) throw new AppError(404, 'not_found', 'Not found');
  let claims: GoogleClaims;
  try {
    claims = await verifyGoogleIdToken(body.idToken, { keys: rt.googleKeys, clientIds, now: rt.now() });
  } catch (err) {
    logRejected(rt, err);
    throw err;
  }
  const resolved = await resolveGoogleUser(rt, claims);
  await completeSignIn(rt, res, {
    user: resolved.user,
    platform,
    method: 'google',
    isNewUser: resolved.isNewUser,
  });
}

export function mountGoogleRoutes(router: Router, rt: AuthRuntime): void {
  mountMethod(router, 'post', '/google', (req, res) => googleSignIn(rt, req, res));
}
