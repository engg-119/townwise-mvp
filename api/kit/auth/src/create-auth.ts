import type { KeyObject } from 'node:crypto';

import { ipKey } from '@ckeith26/rate-limit';
import { AppError, parseInput, type Logger, type ServerConfig } from '@ckeith26/server-core';
import type { Request, RequestHandler, Response, Router } from 'express';
import express from 'express';
import type { Redis } from 'ioredis';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

import { resolveAuthConfig, type AuthConfig, type ResolvedAuthConfig } from './config.ts';
import { clearSessionCookies, cookieNames, readCookie, setSessionCookies, type CookieNames } from './cookies.ts';
import { deriveEmailKey } from './email-id.ts';
import { GOOGLE_CERTS_URL, mountGoogleRoutes } from './google.ts';
import { mountMethod } from './http.ts';
import { createAuthLimits, type AuthLimits } from './limits.ts';
import { mountMagicLinkRoutes } from './magic-link.ts';
import { authOf, createRequireAuth } from './middleware.ts';
import { logoutBody, refreshBody } from './routes.ts';
import { ABSOLUTE_DAYS, hashToken, REFRESH_TOKEN_PATTERN, refreshSession } from './sessions.ts';
import type { AuthStores, Platform, User } from './stores/types.ts';
import { createTokenCrypto, type TokenCrypto } from './token-crypto.ts';
import { createTokens, type Tokens } from './tokens.ts';
import { mountTotpRoutes } from './totp/factor.ts';
import { resolvePlatform } from './transport.ts';

export type { SignInResult, PublicUser } from './routes.ts';
export { authOf } from './middleware.ts';

const DAY_SECONDS = 24 * 60 * 60;
const BEARER = /^Bearer ([A-Za-z0-9._-]{1,2048})$/;

export interface MagicLinkMessage {
  readonly to: string;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface AuthDeps {
  readonly config: AuthConfig & Pick<ServerConfig, 'NODE_ENV' | 'CORS_ORIGINS'>;
  readonly stores: AuthStores;
  readonly redis: Redis;
  readonly logger: Logger;
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
  onUserCreated?(user: User): Promise<void>;
  readonly googleKeys?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly platform: 'web' | 'native';
  readonly authenticatedAt: Date;
}

export interface Auth {
  readonly router: Router;
  readonly requireAuth: RequestHandler;
  revokeAllSessions(userId: string): Promise<number>;
}

export interface AuthRuntime {
  readonly config: ResolvedAuthConfig;
  readonly cookies: CookieNames;
  readonly stores: AuthStores;
  readonly tokens: Tokens;
  readonly cipher: TokenCrypto;
  readonly limits: AuthLimits;
  readonly emailKey: KeyObject;
  readonly googleKeys: JWTVerifyGetKey;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly deps: AuthDeps;
}

function refreshCredential(rt: AuthRuntime, req: Request, refreshToken: unknown, platform: Platform): string | null {
  if (platform === 'web') {
    const read = readCookie(req.headers.cookie, 'refresh', rt.cookies);
    return read.status === 'ok' ? read.value : null;
  }
  if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_PATTERN.test(refreshToken)) return null;
  return refreshToken;
}

function accessCredential(rt: AuthRuntime, req: Request, platform: Platform): string | null {
  if (platform === 'native') {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    return BEARER.exec(header)?.[1] ?? null;
  }
  const read = readCookie(req.headers.cookie, 'access', rt.cookies);
  return read.status === 'ok' ? read.value : null;
}

function sidOf(token: string | null): string | undefined {
  if (token === null) return undefined;
  const segment = token.split('.')[1];
  if (segment === undefined) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || !('sid' in payload)) return undefined;
    return typeof payload.sid === 'string' ? payload.sid : undefined;
  } catch {
    return undefined;
  }
}

function endRefresh(rt: AuthRuntime, res: Response, platform: Platform): never {
  if (platform === 'web') clearWebCookies(rt, res);
  throw new AppError(401, 'session_ended', 'Session ended');
}

async function refresh(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const body = parseInput(refreshBody, req.body);
  const platform = resolvePlatform(req.headers, body.platform, rt.config.webOrigins);
  const presented = refreshCredential(rt, req, body.refreshToken, platform);
  if (presented === null) endRefresh(rt, res, platform);
  await rt.limits.consume('ip', ipKey(req));
  const now = rt.now();
  const outcome = await refreshSession(rt, { presentedHash: hashToken(presented), platform, now });
  if (outcome.kind === 'ended') endRefresh(rt, res, platform);
  const user = await rt.stores.users.findById(outcome.session.userId);
  if (user === null) {
    await rt.stores.sessions.revoke({ id: outcome.session.id, reason: 'user_missing', now });
    endRefresh(rt, res, platform);
  }
  const access = await rt.tokens.signAccess({ sub: user.id, sid: outcome.session.id }, now);
  if (platform === 'web') {
    setSessionCookies(res, {
      names: rt.cookies,
      secure: rt.config.secure,
      accessToken: access.token,
      refreshToken: outcome.refreshToken,
      refreshMaxAgeSeconds: Math.floor((outcome.session.absoluteExpiresAt.getTime() - now.getTime()) / 1000),
    });
    res.status(204).end();
    return;
  }
  res.status(200).json({
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: outcome.refreshToken,
  });
}

function clearWebCookies(rt: AuthRuntime, res: Response): void {
  clearSessionCookies(res, {
    names: rt.cookies,
    secure: rt.config.secure,
    refreshMaxAgeSeconds: ABSOLUTE_DAYS * DAY_SECONDS,
  });
}

async function logout(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const body = parseInput(logoutBody, req.body);
  const platform = resolvePlatform(req.headers, body.platform, rt.config.webOrigins);
  const now = rt.now();
  const refresh = refreshCredential(rt, req, body.refreshToken, platform);
  const access = accessCredential(rt, req, platform);
  if (refresh !== null) {
    const revoked = await rt.stores.sessions.revokeByRefreshHash({
      hash: hashToken(refresh),
      platform,
      reason: 'logout',
      now,
    });
    if (revoked) {
      const sid = sidOf(access);
      rt.logger.info(sid !== undefined ? { sid, reason: 'logout' } : { reason: 'logout' }, 'auth.session_revoked');
    }
  } else if (access !== null) {
    try {
      const claims = await rt.tokens.verifyAccess(access, now);
      const revoked = await rt.stores.sessions.revoke({ id: claims.sid, reason: 'logout', now });
      if (revoked) rt.logger.info({ sid: claims.sid, reason: 'logout' }, 'auth.session_revoked');
    } catch (err) {
      if (!(err instanceof AppError) || err.status !== 401) throw err;
    }
  }
  if (platform === 'web') clearWebCookies(rt, res);
  res.status(204).end();
}

async function logoutAll(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = authOf(req);
  const now = rt.now();
  await rt.stores.sessions.revokeAllForUser({ userId: ctx.userId, reason: 'logout_all', now });
  const user = await rt.stores.users.findById(ctx.userId);
  if (user !== null) await rt.stores.magicLinks.deleteForEmail(user.email);
  if (ctx.platform === 'web') clearWebCookies(rt, res);
  rt.logger.info({ userId: ctx.userId }, 'auth.logout_all');
  rt.logger.info({ sid: ctx.sessionId, reason: 'logout_all' }, 'auth.session_revoked');
  res.status(204).end();
}

async function me(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = authOf(req);
  const user = await rt.stores.users.findById(ctx.userId);
  if (user === null) throw new AppError(401, 'unauthenticated', 'Unauthenticated');
  const factor = await rt.stores.totp.get(ctx.userId);
  const enabled = factor?.status === 'enabled';
  res.status(200).json({
    user: { id: user.id, email: user.email },
    session: { id: ctx.sessionId, platform: ctx.platform },
    totp: { enabled, recoveryCodesRemaining: enabled ? factor.recoveryCodeHashes.length : 0 },
  });
}

async function revokeAllSessions(rt: AuthRuntime, userId: string): Promise<number> {
  const count = await rt.stores.sessions.revokeAllForUser({ userId, reason: 'app_revoked', now: rt.now() });
  const user = await rt.stores.users.findById(userId);
  if (user !== null) await rt.stores.magicLinks.deleteForEmail(user.email);
  if (count > 0) rt.logger.info({ userId, reason: 'app_revoked' }, 'auth.session_revoked');
  return count;
}

/** Throws ConfigError when the cross-field checks fail, before stores or Redis are used. */
export function createAuth(deps: AuthDeps): Auth {
  const config = resolveAuthConfig(deps.config);
  const signingKey = config.jwtKeys[0];
  if (signingKey === undefined) throw new Error('JWT keyring is empty');
  const rt: AuthRuntime = {
    config,
    cookies: cookieNames(config.issuer),
    stores: deps.stores,
    tokens: createTokens({ issuer: config.issuer, keys: config.jwtKeys }),
    cipher: createTokenCrypto(config.encryptionKeys),
    limits: createAuthLimits({ redis: deps.redis, logger: deps.logger }),
    emailKey: deriveEmailKey(signingKey.key),
    googleKeys: deps.googleKeys ?? createRemoteJWKSet(new URL(GOOGLE_CERTS_URL)),
    logger: deps.logger,
    now: deps.now ?? ((): Date => new Date()),
    deps,
  };
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  const requireAuth = createRequireAuth(rt);
  mountMagicLinkRoutes(router, rt);
  if (rt.config.googleClientIds !== null) mountGoogleRoutes(router, rt);
  mountTotpRoutes(router, rt);
  mountMethod(router, 'post', '/refresh', (req, res) => refresh(rt, req, res));
  mountMethod(router, 'post', '/logout', (req, res) => logout(rt, req, res));
  router.post('/logout-all', requireAuth, (req, res, next) => {
    void logoutAll(rt, req, res).catch(next);
  });
  router.get('/me', requireAuth, (req, res, next) => {
    void me(rt, req, res).catch(next);
  });

  return {
    router,
    requireAuth,
    revokeAllSessions: (userId) => revokeAllSessions(rt, userId),
  };
}
