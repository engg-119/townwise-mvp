import { z } from 'zod';

import type { Platform } from './stores/types.ts';

export const platformSchema: z.ZodType<Platform> = z.enum(['web', 'native']);

const totpCodeSchema = z.string().max(64).transform((value) => value.replace(/\s+/g, '')).refine((value) => /^\d{6}$/.test(value));

const recoveryCodeSchema = z.string().max(64).transform((value) => value.toLowerCase().replace(/[\s-]/g, '')).refine((value) => /^[0-9a-f]{20}$/.test(value));

function exactlyOneFactor(
  value: { code?: string | undefined; recoveryCode?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  const hasCode = value.code !== undefined;
  const hasRecovery = value.recoveryCode !== undefined;
  if (hasCode === hasRecovery) {
    ctx.addIssue({ code: 'custom', message: 'expected exactly one of code or recoveryCode' });
  }
}

export const googleBody = z.object({
  idToken: z.string().min(1).max(8192),
  platform: platformSchema,
});

export const magicLinkBody = z.object({
  email: z.string().max(320),
  platform: platformSchema,
});

export const redeemBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: z.string().max(320),
  platform: platformSchema,
});

export const mfaVerifyBody = z.object({
  mfaToken: z.string().min(1).max(2048),
  platform: platformSchema,
  code: totpCodeSchema.optional(),
  recoveryCode: recoveryCodeSchema.optional(),
}).superRefine(exactlyOneFactor);

export const refreshBody = z.object({
  platform: platformSchema,
  refreshToken: z.unknown().optional(),
});

export const logoutBody = z.object({
  platform: platformSchema,
  refreshToken: z.unknown().optional(),
});

export const totpConfirmBody = z.object({
  code: totpCodeSchema,
});

export const totpDisableBody = z.object({
  code: totpCodeSchema.optional(),
  recoveryCode: recoveryCodeSchema.optional(),
}).superRefine(exactlyOneFactor);

export interface PublicUser { readonly id: string; readonly email: string }

export type SignInResult =
  | { status: 'signed_in'; user: PublicUser; session: { id: string; platform: 'web' }; isNewUser: boolean }
  | { status: 'signed_in'; user: PublicUser; session: { id: string; platform: 'native' }; isNewUser: boolean;
      accessToken: string; accessTokenExpiresAt: string; refreshToken: string }
  | { status: 'mfa_required'; mfaToken: string; mfaTokenExpiresAt: string };

export interface RefreshNativeResponse { accessToken: string; accessTokenExpiresAt: string; refreshToken: string }

export interface MeResponse {
  user: PublicUser;
  session: { id: string; platform: Platform };
  totp: { enabled: boolean; recoveryCodesRemaining: number };
}

export interface TotpEnrollResponse { secret: string; otpauthUri: string; expiresAt: string; qrPngDataUrl: string }

export interface TotpConfirmResponse { recoveryCodes: string[] }

export type RouteAuth = 'platform' | 'refresh' | 'optional' | 'session' | 'recent';

export interface RouteSpec {
  readonly method: 'GET' | 'POST';
  readonly path: `/${string}`;
  readonly auth: RouteAuth;
  readonly body: readonly string[];
  readonly success: readonly number[];
  readonly errors: readonly string[];
}

export const AUTH_ROUTES: readonly RouteSpec[] = [
  {
    method: 'POST',
    path: '/google',
    auth: 'platform',
    body: ['idToken', 'platform'],
    success: [200],
    errors: [
      'invalid_request',
      'invalid_google_token',
      'origin_not_allowed',
      'google_email_unverified',
      'google_email_not_authoritative',
      'email_linked_to_other_google_account',
      'google_email_conflict',
      'rate_limited',
      'google_unavailable',
    ],
  },
  {
    method: 'POST',
    path: '/magic-link',
    auth: 'platform',
    body: ['email', 'platform'],
    success: [202],
    errors: ['invalid_request', 'origin_not_allowed', 'rate_limited', 'email_unavailable'],
  },
  {
    method: 'POST',
    path: '/magic-link/redeem',
    auth: 'platform',
    body: ['token', 'email', 'platform'],
    success: [200],
    errors: ['invalid_request', 'invalid_or_expired_link', 'origin_not_allowed', 'rate_limited'],
  },
  {
    method: 'POST',
    path: '/mfa/verify',
    auth: 'platform',
    body: ['mfaToken', 'platform', 'code', 'recoveryCode'],
    success: [200],
    errors: ['invalid_request', 'invalid_code', 'invalid_mfa_token', 'origin_not_allowed', 'rate_limited'],
  },
  {
    method: 'POST',
    path: '/refresh',
    auth: 'refresh',
    body: ['platform', 'refreshToken'],
    success: [204, 200],
    errors: ['session_ended', 'origin_not_allowed', 'rate_limited'],
  },
  {
    method: 'POST',
    path: '/logout',
    auth: 'optional',
    body: ['platform', 'refreshToken'],
    success: [204],
    errors: ['origin_not_allowed'],
  },
  {
    method: 'POST',
    path: '/logout-all',
    auth: 'session',
    body: [],
    success: [204],
    errors: ['unauthenticated', 'origin_not_allowed'],
  },
  {
    method: 'GET',
    path: '/me',
    auth: 'session',
    body: [],
    success: [200],
    errors: ['unauthenticated'],
  },
  {
    method: 'POST',
    path: '/totp/enroll',
    auth: 'recent',
    body: [],
    success: [200],
    errors: ['unauthenticated', 'origin_not_allowed', 'reauth_required', 'totp_already_enabled'],
  },
  {
    method: 'POST',
    path: '/totp/enroll/confirm',
    auth: 'recent',
    body: ['code'],
    success: [200],
    errors: ['invalid_code', 'enrollment_expired', 'unauthenticated', 'origin_not_allowed', 'reauth_required', 'rate_limited'],
  },
  {
    method: 'POST',
    path: '/totp/disable',
    auth: 'recent',
    body: ['code', 'recoveryCode'],
    success: [204],
    errors: ['invalid_code', 'unauthenticated', 'origin_not_allowed', 'reauth_required', 'totp_not_enabled', 'rate_limited'],
  },
];

export const AUTH_COMMON_ERRORS: readonly string[] = [
  'internal',
  'unavailable',
  'malformed_json',
  'payload_too_large',
  'unsupported_media_type',
];
