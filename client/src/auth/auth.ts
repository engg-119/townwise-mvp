import { z } from 'zod';

import { ApiError, platformOf, type ApiClient, type Session } from '../api/client';
import type { Config } from '../config';
import {
  magicLinkSentSchema,
  meSchema,
  nativeSignInResultSchema,
  PATHS,
  recoveryCodesSchema,
  totpEnrollmentSchema,
  webSignInResultSchema,
  type NativeSignInResult,
  type WebSignInResult,
} from './contract';
import type { MagicLink } from './magicLink';
import type { AuthState, AuthStore, User } from './store';

export interface Me { user: User; totp: { enabled: boolean; recoveryCodesRemaining: number } }
export interface TotpEnrollment { secret: string; otpauthUri: string; expiresAt: string; qrPngDataUrl: string }

export interface Auth {
  readonly store: AuthStore;
  readonly api: ApiClient;
  readonly config: Config;
  restore(): Promise<void>;
  signInWithGoogle(idToken: string): Promise<void>;
  requestMagicLink(email: string): Promise<void>;
  redeemMagicLink(link: MagicLink): Promise<void>;
  verifyMfa(input: { code: string } | { recoveryCode: string }): Promise<void>;
  cancelMfa(): void;
  loadMe(): Promise<Me>;
  beginTotpEnrollment(): Promise<TotpEnrollment>;
  confirmTotpEnrollment(code: string): Promise<{ recoveryCodes: string[] }>;
  /** Starts moving two-step sign-in to a new authenticator, proved by a current code or a recovery code. */
  beginTotpReset(proof: { code: string } | { recoveryCode: string }): Promise<TotpEnrollment>;
  /** Finishes it with a code from the new authenticator; until then the old one stays as it was. */
  confirmTotpReset(code: string): Promise<{ recoveryCodes: string[] }>;
  signOut(notice?: string): Promise<void>;
}

const emailAddress = z.string().trim().pipe(z.email());

/** A cold start that cannot reach the API or the keychain shows Retry, and on native Sign in again. */
export function restoreFailed(error: ApiError): AuthState {
  return { status: 'unreachable', error };
}

export function normalizeTotpCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6);
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 20);
}

export function createAuth(deps: { api: ApiClient; session: Session; store: AuthStore; config: Config }): Auth {
  const { api, session, store, config } = deps;
  const signInSchema = session.kind === 'cookie' ? webSignInResultSchema : nativeSignInResultSchema;

  async function applySignIn(result: WebSignInResult | NativeSignInResult): Promise<void> {
    if (result.status === 'mfa_required') {
      store.set({ status: 'mfaRequired', mfaToken: result.mfaToken });
      return;
    }
    if (session.kind === 'bearer') {
      if (!('accessToken' in result) || !('refreshToken' in result)) {
        throw new ApiError('invalid_response', 'The sign-in response did not include tokens.');
      }
      await session.tokens.save({ accessToken: result.accessToken, refreshToken: result.refreshToken }, session.tokens.generation());
    }
    store.set({ status: 'signedIn', user: result.user });
  }

  async function postSignIn(path: `/${string}`, body: unknown): Promise<void> {
    await applySignIn(await api.json(path, signInSchema, { method: 'POST', auth: false, body }));
  }

  return {
    store,
    api,
    config,
    async restore() {
      store.set({ status: 'restoring' });
      try {
        const me = await loadMe();
        store.set({ status: 'signedIn', user: me.user });
      } catch (error) {
        if (error instanceof ApiError && (error.kind === 'signed_out' || (error.kind === 'http' && error.status === 401))) {
          store.set({ status: 'signedOut' });
          return;
        }
        if (error instanceof ApiError) {
          store.set(restoreFailed(error));
          return;
        }
        const wrapped = new ApiError('network', 'Could not restore the session.', { cause: error });
        store.set(restoreFailed(wrapped));
      }
    },
    signInWithGoogle(idToken) {
      return postSignIn(PATHS.google, { idToken, platform: platformOf(session) });
    },
    async requestMagicLink(email) {
      const parsed = emailAddress.parse(email);
      await api.json(PATHS.magicLink, magicLinkSentSchema, {
        method: 'POST',
        auth: false,
        body: { email: parsed, platform: platformOf(session) },
      });
    },
    redeemMagicLink(link) {
      return postSignIn(PATHS.magicLinkRedeem, { token: link.token, email: link.email, platform: platformOf(session) });
    },
    async verifyMfa(input) {
      const state = store.getState();
      if (state.status !== 'mfaRequired') throw new ApiError('http', 'There is no sign-in to finish.', { status: 400 });
      const factor = 'code' in input
        ? { code: normalizeTotpCode(input.code) }
        : { recoveryCode: normalizeRecoveryCode(input.recoveryCode) };
      try {
        await postSignIn(PATHS.mfaVerify, { mfaToken: state.mfaToken, platform: platformOf(session), ...factor });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'invalid_mfa_token') {
          store.set({ status: 'signedOut', notice: 'That took too long. Sign in again.' });
        }
        throw error;
      }
    },
    cancelMfa() {
      store.set({ status: 'signedOut' });
    },
    loadMe,
    beginTotpEnrollment() {
      return api.json(PATHS.totpEnroll, totpEnrollmentSchema, { method: 'POST' });
    },
    confirmTotpEnrollment(code) {
      return api.json(PATHS.totpEnrollConfirm, recoveryCodesSchema, { method: 'POST', body: { code } });
    },
    beginTotpReset(proof) {
      const body = 'code' in proof
        ? { code: normalizeTotpCode(proof.code) }
        : { recoveryCode: normalizeRecoveryCode(proof.recoveryCode) };
      return api.json(PATHS.totpReset, totpEnrollmentSchema, { method: 'POST', body });
    },
    confirmTotpReset(code) {
      return api.json(PATHS.totpResetConfirm, recoveryCodesSchema, { method: 'POST', body: { code } });
    },
    async signOut(notice?: string) {
      await api.logout();
      store.set(notice === undefined ? { status: 'signedOut' } : { status: 'signedOut', notice });
    },
  };

  async function loadMe(): Promise<Me> {
    const body = await api.json(PATHS.me, meSchema);
    return { user: body.user, totp: body.totp };
  }
}
