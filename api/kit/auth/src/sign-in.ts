import { randomUUID } from 'node:crypto';

import type { Response } from 'express';

import { setSessionCookies } from './cookies.ts';
import type { AuthRuntime } from './create-auth.ts';
import { ABSOLUTE_DAYS, hashToken, newRefreshToken } from './sessions.ts';
import type { Platform, User } from './stores/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runOnUserCreated(rt: AuthRuntime, user: User): Promise<void> {
  if (rt.deps.onUserCreated === undefined) return;
  try {
    await rt.deps.onUserCreated(user);
  } catch {
    rt.logger.error({ userId: user.id }, 'auth.on_user_created_failed');
  }
}

export async function completeSignIn(rt: AuthRuntime, res: Response, input: {
  user: User;
  platform: Platform;
  method: 'google' | 'magic_link' | 'mfa';
  isNewUser: boolean;
}): Promise<void> {
  const now = rt.now();
  if (input.method === 'google' || input.method === 'magic_link') {
    const factor = await rt.stores.totp.get(input.user.id);
    if (factor?.status === 'enabled') {
      const mfa = await rt.tokens.signMfa({ sub: input.user.id, plat: input.platform }, now);
      rt.logger.info({ userId: input.user.id, method: input.method, platform: input.platform }, 'auth.mfa_challenged');
      res.status(200).json({
        status: 'mfa_required',
        mfaToken: mfa.token,
        mfaTokenExpiresAt: mfa.expiresAt.toISOString(),
      });
      return;
    }
  }

  const sid = randomUUID();
  const refreshToken = newRefreshToken();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_DAYS * DAY_MS);
  await rt.stores.sessions.create({
    id: sid,
    userId: input.user.id,
    platform: input.platform,
    refreshHash: hashToken(refreshToken),
    now,
    absoluteExpiresAt,
  });
  const access = await rt.tokens.signAccess({ sub: input.user.id, sid }, now);
  const user = { id: input.user.id, email: input.user.email };
  const session = { id: sid, platform: input.platform };
  if (input.platform === 'web') {
    setSessionCookies(res, {
      names: rt.cookies,
      secure: rt.config.secure,
      accessToken: access.token,
      refreshToken,
      refreshMaxAgeSeconds: Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000),
    });
    res.status(200).json({ status: 'signed_in', user, session, isNewUser: input.isNewUser });
  } else {
    res.status(200).json({
      status: 'signed_in',
      user,
      session,
      isNewUser: input.isNewUser,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
    });
  }
  rt.logger.info({ userId: input.user.id, sid, method: input.method, platform: input.platform }, 'auth.signed_in');
}
