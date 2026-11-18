import { z } from 'zod';

export const PATHS = {
  google: '/auth/google',
  magicLink: '/auth/magic-link',
  magicLinkRedeem: '/auth/magic-link/redeem',
  mfaVerify: '/auth/mfa/verify',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  me: '/auth/me',
  totpEnroll: '/auth/totp/enroll',
  totpEnrollConfirm: '/auth/totp/enroll/confirm',
  totpReset: '/auth/totp/reset',
  totpResetConfirm: '/auth/totp/reset/confirm',
} as const;

export const errorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
});

const sessionSchema = z.object({
  id: z.string(),
  platform: z.enum(['web', 'native']),
});

const mfaRequiredSchema = z.object({
  status: z.literal('mfa_required'),
  mfaToken: z.string(),
  mfaTokenExpiresAt: z.string(),
});

const signedInWebSchema = z.object({
  status: z.literal('signed_in'),
  user: userSchema,
  session: sessionSchema,
});

const signedInNativeSchema = signedInWebSchema.extend({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
});

/** Web responses have no token fields. `z.object` strips a token a misconfigured server adds, including `isNewUser`. */
export const webSignInResultSchema = z.discriminatedUnion('status', [signedInWebSchema, mfaRequiredSchema]);
export const nativeSignInResultSchema = z.discriminatedUnion('status', [signedInNativeSchema, mfaRequiredSchema]);

export const nativeGrantSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
});

export const meSchema = z.object({
  user: userSchema,
  session: sessionSchema,
  totp: z.object({
    enabled: z.boolean(),
    recoveryCodesRemaining: z.number(),
  }),
});

export const magicLinkSentSchema = z.object({ ok: z.literal(true) });

export const totpEnrollmentSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
  expiresAt: z.string(),
  qrPngDataUrl: z.string().startsWith('data:image/png;base64,'),
});

export const recoveryCodesSchema = z.object({
  recoveryCodes: z.array(z.string()).length(10),
});

export type WebSignInResult = z.infer<typeof webSignInResultSchema>;
export type NativeSignInResult = z.infer<typeof nativeSignInResultSchema>;
export type SignInResult = WebSignInResult | NativeSignInResult;
