import { randomBytes } from 'node:crypto';

import { AppError, parseInput } from '@ckeith26/server-core';
import { ipKey } from '@ckeith26/rate-limit';
import type { Request, Response, Router } from 'express';

import type { AuthRuntime } from './create-auth.ts';
import { emailId, normalizeEmail } from './email-id.ts';
import { mountMethod } from './http.ts';
import { hashToken } from './sessions.ts';
import { completeSignIn, runOnUserCreated } from './sign-in.ts';
import { DuplicateError } from './stores/types.ts';
import { resolvePlatform } from './transport.ts';
import { magicLinkBody, redeemBody } from './routes.ts';

const LINK_TTL_MS = 15 * 60 * 1000;

export function buildLink(magicLinkUrl: string, token: string, email: string): string {
  return `${magicLinkUrl}#${new URLSearchParams({ token, email }).toString()}`;
}

async function requestLink(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const body = parseInput(magicLinkBody, req.body);
  const platform = resolvePlatform(req.headers, body.platform, rt.config.webOrigins);
  const email = normalizeEmail(body.email);
  if (email === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  const now = rt.now();
  const id = emailId(rt.emailKey, email);
  await rt.limits.consume('mlSendIp', ipKey(req));
  await rt.limits.consume('mlSendEmail', id);
  await rt.limits.consume('mlSendEmailDay', id);
  await rt.stores.magicLinks.deleteForEmail(email);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await rt.stores.magicLinks.create({
    tokenHash: hashToken(token),
    email,
    platform,
    createdAt: now,
    expiresAt,
  });
  try {
    await rt.deps.sendMagicLink({
      to: email,
      url: buildLink(rt.config.magicLinkUrl, token, email),
      expiresAt,
    });
  } catch {
    throw new AppError(503, 'email_unavailable', 'Email is temporarily unavailable');
  }
  rt.logger.info({ emailId: id }, 'auth.magic_link_sent');
  res.status(202).json({ ok: true });
}

async function redeemLink(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const body = parseInput(redeemBody, req.body);
  const platform = resolvePlatform(req.headers, body.platform, rt.config.webOrigins);
  const email = normalizeEmail(body.email);
  if (email === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  const now = rt.now();
  await rt.limits.consume('ip', ipKey(req));
  const consumed = await rt.stores.magicLinks.consume({
    tokenHash: hashToken(body.token),
    email,
    platform,
    now,
  });
  if (!consumed) throw new AppError(400, 'invalid_or_expired_link', 'Invalid or expired link');

  let user = await rt.stores.users.findByEmail(email);
  let isNewUser = false;
  if (user === null) {
    try {
      user = await rt.stores.users.create({ email, now });
      isNewUser = true;
      rt.logger.info({ userId: user.id }, 'auth.user_created');
      await runOnUserCreated(rt, user);
    } catch (err) {
      if (!(err instanceof DuplicateError)) throw err;
      user = await rt.stores.users.findByEmail(email);
      if (user === null) throw err;
    }
  }
  const id = emailId(rt.emailKey, email);
  await rt.stores.magicLinks.deleteForEmail(email);
  await rt.limits.reset('mlSendEmail', id);
  await rt.limits.reset('mlSendEmailDay', id);
  await completeSignIn(rt, res, { user, platform, method: 'magic_link', isNewUser });
}

export function mountMagicLinkRoutes(router: Router, rt: AuthRuntime): void {
  mountMethod(router, 'post', '/magic-link', (req, res) => requestLink(rt, req, res));
  mountMethod(router, 'post', '/magic-link/redeem', (req, res) => redeemLink(rt, req, res));
}
