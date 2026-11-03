import { createHash, randomBytes } from 'node:crypto';

import type { AuthRuntime } from './create-auth.ts';
import type { LiveWindow, Platform, SessionRecord } from './stores/types.ts';

export const IDLE_DAYS = 14;
export const ABSOLUTE_DAYS = 30;
export const GRACE_SECONDS = 60;
export const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function liveWindow(now: Date): LiveWindow {
  return { now, idleCutoff: new Date(now.getTime() - IDLE_DAYS * DAY_MS) };
}

export function isLive(session: SessionRecord, w: LiveWindow): boolean {
  return session.revokedAt === null
    && session.absoluteExpiresAt.getTime() > w.now.getTime()
    && session.lastUsedAt.getTime() > w.idleCutoff.getTime();
}

/**
 * A-L1. Called only when the presented hash is the live session's previous hash.
 * Rotating again inside a short window answers refresh responses lost on flaky
 * networks, but lets two holders share the session for that window. Always
 * revoking is strictest and signs out any client whose response was dropped.
 * Choice: rotate again while `now` is within GRACE_SECONDS of lastUsedAt, otherwise revoke.
 */
export function previousTokenDecision(session: SessionRecord, now: Date): 'rotate_again' | 'revoke' {
  const elapsed = now.getTime() - session.lastUsedAt.getTime();
  return elapsed <= GRACE_SECONDS * 1000 ? 'rotate_again' : 'revoke';
}

export type RefreshOutcome =
  | { readonly kind: 'rotated'; readonly session: SessionRecord; readonly refreshToken: string }
  | { readonly kind: 'ended' };

async function reuse(rt: AuthRuntime, session: SessionRecord, now: Date): Promise<void> {
  if (session.revokedAt === null) {
    await rt.stores.sessions.revoke({ id: session.id, reason: 'refresh_reuse', now });
  }
  rt.logger.warn({ userId: session.userId, sid: session.id }, 'auth.refresh_reuse_detected');
}

/** The 3-auth.md 8.2 decision table after the shape check and the auth:ip consume. Store errors propagate. */
export async function refreshSession(
  rt: AuthRuntime,
  input: { presentedHash: string; platform: Platform; now: Date },
): Promise<RefreshOutcome> {
  const w = liveWindow(input.now);
  const refreshToken = newRefreshToken();
  const newHash = hashToken(refreshToken);
  const rotated = await rt.stores.sessions.rotate({
    currentHash: input.presentedHash,
    newHash,
    platform: input.platform,
    ...w,
  });
  if (rotated !== null) return { kind: 'rotated', session: rotated, refreshToken };

  const previous = await rt.stores.sessions.findByPreviousHash(input.presentedHash, input.platform);
  if (previous !== null) {
    if (isLive(previous, w) && previousTokenDecision(previous, input.now) === 'rotate_again') {
      const grace = await rt.stores.sessions.rotateFromPrevious({
        id: previous.id,
        previousHash: input.presentedHash,
        expectedCurrentHash: previous.refreshHash,
        newHash,
        ...w,
      });
      if (grace !== null) {
        rt.logger.warn({ sid: grace.id }, 'auth.refresh_grace_retry');
        return { kind: 'rotated', session: grace, refreshToken };
      }
    }
    await reuse(rt, previous, input.now);
    return { kind: 'ended' };
  }

  const retired = await rt.stores.sessions.findByRetiredHash(input.presentedHash, input.platform);
  if (retired !== null) await reuse(rt, retired, input.now);
  return { kind: 'ended' };
}
