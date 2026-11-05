import { AppError } from '@ckeith26/server-core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { readCookie } from './cookies.ts';
import type { AuthContext, AuthRuntime } from './create-auth.ts';
import { liveWindow } from './sessions.ts';
import type { Platform } from './stores/types.ts';
import { assertCookieRequestOrigin } from './transport.ts';

const BEARER = /^Bearer ([A-Za-z0-9._-]{1,2048})$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function authenticate(rt: AuthRuntime, req: Request): Promise<AuthContext> {
  const authorization = headerValue(req.headers.authorization);
  let token: string;
  let platform: Platform;
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization);
    const bearer = match?.[1];
    if (bearer === undefined) throw new AppError(401, 'unauthenticated', 'Unauthenticated');
    token = bearer;
    platform = 'native';
  } else {
    const read = readCookie(req.headers.cookie, 'access', rt.cookies);
    if (read.status !== 'ok') throw new AppError(401, 'unauthenticated', 'Unauthenticated');
    assertCookieRequestOrigin(req.method, req.headers, rt.config.webOrigins);
    token = read.value;
    platform = 'web';
  }
  const claims = await rt.tokens.verifyAccess(token, rt.now());
  const session = await rt.stores.sessions.findLive(claims.sid, liveWindow(rt.now()));
  if (session?.userId !== claims.sub || session.platform !== platform) {
    throw new AppError(401, 'unauthenticated', 'Unauthenticated');
  }
  return {
    userId: session.userId,
    sessionId: session.id,
    platform,
    authenticatedAt: session.createdAt,
  };
}

export function createRequireAuth(rt: AuthRuntime): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void authenticate(rt, req).then((ctx) => {
      recordAuth(req, ctx);
      next();
    }).catch(next);
  };
}

const contexts = new WeakMap<Request, AuthContext>();

export function recordAuth(req: Request, ctx: AuthContext): void {
  contexts.set(req, ctx);
}

/** Throws when requireAuth did not record a context for this request. */
export function authOf(req: Request): AuthContext {
  const ctx = contexts.get(req);
  if (ctx === undefined) throw new AppError(500, 'internal', 'Internal server error');
  return ctx;
}
