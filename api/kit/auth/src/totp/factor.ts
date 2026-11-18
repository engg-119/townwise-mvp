import { randomBytes } from 'node:crypto';

import { AppError, parseInput } from '@ckeith26/server-core';
import { ipKey } from '@ckeith26/rate-limit';
import type { Request, Response, Router } from 'express';
import { toDataURL } from 'qrcode';

import type { AuthContext, AuthRuntime } from '../create-auth.ts';
import { mountMethod } from '../http.ts';
import { createRequireAuth, authOf } from '../middleware.ts';
import { mfaVerifyBody, totpConfirmBody, totpDisableBody, totpResetBody } from '../routes.ts';
import { hashToken } from '../sessions.ts';
import { completeSignIn } from '../sign-in.ts';
import { resolvePlatform } from '../transport.ts';
import { generateSecret, otpauthUri, verifyCode } from './totp.ts';

export const PENDING_MINUTES = 10;
const RECENT_MS = 15 * 60 * 1000;

export function generateRecoveryCodes(): { readonly display: string[]; readonly hashes: string[] } {
  const display: string[] = [];
  const hashes: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const hex = randomBytes(10).toString('hex');
    display.push(`${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15, 20)}`);
    hashes.push(hashToken(hex));
  }
  return { display, hashes };
}

/** Lowercase, strip whitespace and hyphens, then require 20 hex characters. */
export function normalizeRecoveryCode(input: string): string | null {
  const normalized = input.toLowerCase().replace(/[\s-]/g, '');
  return /^[0-9a-f]{20}$/.test(normalized) ? normalized : null;
}

/**
 * A-L3. How fresh the first factor must be to enroll or disable TOTP.
 * A short window forces a new sign-in for a late change. A longer one widens
 * the time a stolen session can enroll and lock the owner out.
 * Choice: recent while now is within 15 minutes of authenticatedAt.
 * Refresh does not move that timestamp.
 */
export function isRecentAuth(auth: AuthContext, now: Date): boolean {
  return now.getTime() - auth.authenticatedAt.getTime() <= RECENT_MS;
}

function secretContext(userId: string): string {
  return `auth_totp:${userId}:secret`;
}

function requireRecent(rt: AuthRuntime, req: Request): AuthContext {
  const ctx = authOf(req);
  if (!isRecentAuth(ctx, rt.now())) {
    throw new AppError(403, 'reauth_required', 'Reauthentication required');
  }
  return ctx;
}

async function enroll(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = requireRecent(rt, req);
  const user = await rt.stores.users.findById(ctx.userId);
  if (user === null) throw new AppError(401, 'unauthenticated', 'Unauthenticated');
  const now = rt.now();
  const secret = generateSecret();
  const expiresAt = new Date(now.getTime() + PENDING_MINUTES * 60 * 1000);
  const started = await rt.stores.totp.startEnrollment({
    userId: ctx.userId,
    secretEnc: rt.cipher.encrypt(secret, secretContext(ctx.userId)),
    pendingExpiresAt: expiresAt,
  });
  if (!started) throw new AppError(409, 'totp_already_enabled', 'TOTP is already enabled');
  const uri = otpauthUri({ issuer: rt.config.totpIssuer, account: user.email, secret });
  const qrPngDataUrl = await toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
  res.status(200).json({
    secret,
    otpauthUri: uri,
    expiresAt: expiresAt.toISOString(),
    qrPngDataUrl,
  });
}

async function confirm(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = requireRecent(rt, req);
  const body = parseInput(totpConfirmBody, req.body);
  await rt.limits.consume('totpUser', ctx.userId);
  await rt.limits.consume('totpUserDay', ctx.userId);
  const now = rt.now();
  const factor = await rt.stores.totp.get(ctx.userId);
  if (factor?.status !== 'pending' || factor.pendingExpiresAt === null || factor.pendingExpiresAt.getTime() <= now.getTime()) {
    throw new AppError(400, 'enrollment_expired', 'Enrollment expired');
  }
  const secret = rt.cipher.decrypt(factor.secretEnc, secretContext(ctx.userId));
  const step = verifyCode(secret, body.code, now);
  if (step === null) throw new AppError(400, 'invalid_code', 'Invalid code');
  const codes = generateRecoveryCodes();
  const confirmed = await rt.stores.totp.confirmEnrollment({
    userId: ctx.userId,
    step,
    recoveryCodeHashes: codes.hashes,
    now,
  });
  if (!confirmed) throw new AppError(400, 'enrollment_expired', 'Enrollment expired');
  await rt.stores.sessions.revokeAllForUser({
    userId: ctx.userId,
    reason: 'totp_enabled',
    now,
    exceptId: ctx.sessionId,
  });
  await rt.limits.reset('totpUser', ctx.userId);
  await rt.limits.reset('totpUserDay', ctx.userId);
  rt.logger.info({ userId: ctx.userId }, 'auth.totp_enabled');
  res.status(200).json({ recoveryCodes: codes.display });
}

async function mfaVerify(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const body = parseInput(mfaVerifyBody, req.body);
  const platform = resolvePlatform(req.headers, body.platform, rt.config.webOrigins);
  await rt.limits.consume('ip', ipKey(req));
  const claims = await rt.tokens.verifyMfa(body.mfaToken, rt.now());
  if (claims.plat !== platform) throw new AppError(401, 'invalid_mfa_token', 'Invalid MFA token');
  await rt.limits.consume('totpUser', claims.sub);
  await rt.limits.consume('totpUserDay', claims.sub);
  const factor = await rt.stores.totp.get(claims.sub);
  if (factor?.status !== 'enabled') {
    rt.logger.info({ userId: claims.sub }, 'auth.mfa_failed');
    throw new AppError(400, 'invalid_code', 'Invalid code');
  }
  const context = secretContext(claims.sub);
  const secret = rt.cipher.decrypt(factor.secretEnc, context);
  const now = rt.now();
  if (body.code !== undefined) {
    const step = verifyCode(secret, body.code, now);
    const secretEnc = rt.cipher.isStale(factor.secretEnc) ? rt.cipher.encrypt(secret, context) : undefined;
    const claimed = step !== null && await rt.stores.totp.claimStep({
      userId: claims.sub,
      step,
      verifiedSecretEnc: factor.secretEnc,
      ...(secretEnc !== undefined ? { secretEnc } : {}),
    });
    if (!claimed) {
      rt.logger.info({ userId: claims.sub }, 'auth.mfa_failed');
      throw new AppError(400, 'invalid_code', 'Invalid code');
    }
  } else {
    const recoveryCode = body.recoveryCode;
    if (recoveryCode === undefined) throw new AppError(400, 'invalid_request', 'Invalid request');
    const consumed = await rt.stores.totp.consumeRecoveryCode({
      userId: claims.sub,
      codeHash: hashToken(recoveryCode),
    });
    if (!consumed) {
      rt.logger.info({ userId: claims.sub }, 'auth.mfa_failed');
      throw new AppError(400, 'invalid_code', 'Invalid code');
    }
  }
  await rt.limits.reset('totpUser', claims.sub);
  await rt.limits.reset('totpUserDay', claims.sub);
  const user = await rt.stores.users.findById(claims.sub);
  if (user === null) throw new AppError(401, 'invalid_mfa_token', 'Invalid MFA token');
  await completeSignIn(rt, res, { user, platform, method: 'mfa', isNewUser: false });
}

async function disable(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = requireRecent(rt, req);
  const body = parseInput(totpDisableBody, req.body);
  await rt.limits.consume('totpUser', ctx.userId);
  await rt.limits.consume('totpUserDay', ctx.userId);
  const factor = await rt.stores.totp.get(ctx.userId);
  if (factor?.status !== 'enabled') throw new AppError(409, 'totp_not_enabled', 'TOTP is not enabled');
  const secret = rt.cipher.decrypt(factor.secretEnc, secretContext(ctx.userId));
  const now = rt.now();
  let accepted = false;
  if (body.code !== undefined) {
    const step = verifyCode(secret, body.code, now);
    accepted = step !== null && await rt.stores.totp.claimStep({ userId: ctx.userId, step, verifiedSecretEnc: factor.secretEnc });
  } else if (body.recoveryCode !== undefined) {
    accepted = await rt.stores.totp.consumeRecoveryCode({
      userId: ctx.userId,
      codeHash: hashToken(body.recoveryCode),
    });
  }
  if (!accepted) throw new AppError(400, 'invalid_code', 'Invalid code');
  await rt.stores.totp.remove(ctx.userId);
  await rt.limits.reset('totpUser', ctx.userId);
  await rt.limits.reset('totpUserDay', ctx.userId);
  rt.logger.info({ userId: ctx.userId }, 'auth.totp_disabled');
  res.status(204).end();
}

/**
 * Reset, step 1 (Townwise local change): a person with two-step sign-in on proves themselves with a code from the
 * current authenticator or a recovery code, and gets a new secret to add to another one. The new secret is only
 * pending: the live secret, its recovery codes and `enabledAt` are untouched until `resetConfirm`, so a person who
 * leaves keeps what they had. The proof is spent here (the code's step is claimed, the recovery code pulled), so the
 * same proof never starts a second reset.
 */
async function resetStart(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = requireRecent(rt, req);
  const body = parseInput(totpResetBody, req.body);
  await rt.limits.consume('totpUser', ctx.userId);
  await rt.limits.consume('totpUserDay', ctx.userId);
  const factor = await rt.stores.totp.get(ctx.userId);
  if (factor?.status !== 'enabled') throw new AppError(409, 'totp_not_enabled', 'TOTP is not enabled');
  const user = await rt.stores.users.findById(ctx.userId);
  if (user === null) throw new AppError(401, 'unauthenticated', 'Unauthenticated');
  const context = secretContext(ctx.userId);
  const now = rt.now();
  let accepted = false;
  if (body.code !== undefined) {
    const step = verifyCode(rt.cipher.decrypt(factor.secretEnc, context), body.code, now);
    accepted = step !== null && await rt.stores.totp.claimStep({ userId: ctx.userId, step, verifiedSecretEnc: factor.secretEnc });
  } else if (body.recoveryCode !== undefined) {
    accepted = await rt.stores.totp.consumeRecoveryCode({ userId: ctx.userId, codeHash: hashToken(body.recoveryCode) });
  }
  if (!accepted) throw new AppError(400, 'invalid_code', 'Invalid code');
  const secret = generateSecret();
  const expiresAt = new Date(now.getTime() + PENDING_MINUTES * 60 * 1000);
  const started = await rt.stores.totp.startReset({
    userId: ctx.userId,
    pendingSecretEnc: rt.cipher.encrypt(secret, context),
    pendingExpiresAt: expiresAt,
    sessionId: ctx.sessionId,
  });
  if (!started) throw new AppError(409, 'totp_not_enabled', 'TOTP is not enabled');
  const uri = otpauthUri({ issuer: rt.config.totpIssuer, account: user.email, secret });
  const qrPngDataUrl = await toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
  rt.logger.info({ userId: ctx.userId }, 'auth.totp_reset_started');
  res.status(200).json({ secret, otpauthUri: uri, expiresAt: expiresAt.toISOString(), qrPngDataUrl });
}

/**
 * Reset, step 2: a code from the NEW authenticator, in the session that started the reset and before it expires,
 * swaps the secret in one compare-and-set, replaces the recovery codes and signs out the other sessions. Anything
 * else leaves the factor as it was. The limiter is reset only here, never by the proof alone.
 */
async function resetConfirm(rt: AuthRuntime, req: Request, res: Response): Promise<void> {
  const ctx = requireRecent(rt, req);
  const body = parseInput(totpConfirmBody, req.body);
  await rt.limits.consume('totpUser', ctx.userId);
  await rt.limits.consume('totpUserDay', ctx.userId);
  const now = rt.now();
  const factor = await rt.stores.totp.get(ctx.userId);
  if (
    factor?.status !== 'enabled' || factor.pendingSecretEnc === null || factor.pendingSessionId !== ctx.sessionId
    || factor.pendingExpiresAt === null || factor.pendingExpiresAt.getTime() <= now.getTime()
  ) {
    throw new AppError(400, 'enrollment_expired', 'Enrollment expired');
  }
  const step = verifyCode(rt.cipher.decrypt(factor.pendingSecretEnc, secretContext(ctx.userId)), body.code, now);
  if (step === null) throw new AppError(400, 'invalid_code', 'Invalid code');
  const codes = generateRecoveryCodes();
  const swapped = await rt.stores.totp.confirmReset({
    userId: ctx.userId,
    pendingSecretEnc: factor.pendingSecretEnc,
    sessionId: ctx.sessionId,
    step,
    recoveryCodeHashes: codes.hashes,
    now,
  });
  if (!swapped) throw new AppError(400, 'enrollment_expired', 'Enrollment expired');
  await rt.stores.sessions.revokeAllForUser({
    userId: ctx.userId,
    reason: 'totp_enabled',
    now,
    exceptId: ctx.sessionId,
  });
  await rt.limits.reset('totpUser', ctx.userId);
  await rt.limits.reset('totpUserDay', ctx.userId);
  rt.logger.info({ userId: ctx.userId }, 'auth.totp_reset');
  res.status(200).json({ recoveryCodes: codes.display });
}

export function mountTotpRoutes(router: Router, rt: AuthRuntime): void {
  const requireAuth = createRequireAuth(rt);
  mountMethod(router, 'post', '/mfa/verify', (req, res) => mfaVerify(rt, req, res));
  router.post('/totp/enroll', requireAuth, (req, res, next) => {
    void enroll(rt, req, res).catch(next);
  });
  router.post('/totp/enroll/confirm', requireAuth, (req, res, next) => {
    void confirm(rt, req, res).catch(next);
  });
  router.post('/totp/disable', requireAuth, (req, res, next) => {
    void disable(rt, req, res).catch(next);
  });
  router.post('/totp/reset', requireAuth, (req, res, next) => {
    void resetStart(rt, req, res).catch(next);
  });
  router.post('/totp/reset/confirm', requireAuth, (req, res, next) => {
    void resetConfirm(rt, req, res).catch(next);
  });
}
