import { createApiClient, type Session } from '../../src/api/client';
import { createAuth, type Auth } from '../../src/auth/auth';
import { PATHS } from '../../src/auth/contract';
import { createSecureTokenStore, type TokenStore } from '../../src/auth/tokens';
import { createAuthStore, type AuthState } from '../../src/auth/store';
import { fakeFetch, fakeSecureStore, jsonResponse, memoryMarker, requestText } from '../helpers/fakes';

const EMAIL = ['a', 'example.com'].join('@');
const USER = { id: 'u1', email: EMAIL };
const TOKEN = 'A'.repeat(43);
const CODES = Array.from({ length: 10 }, (_, index) => String(index).padStart(20, '0'));

interface Call { url: string; init: RequestInit }

const TABLE: {
  name: string;
  method: string;
  path: string;
  webKeys: string[];
  nativeKeys: string[];
  platform: boolean;
  initial?: AuthState;
  refresh?: boolean;
  run: (auth: Auth) => Promise<unknown>;
}[] = [
  { name: 'google', method: 'POST', path: '/auth/google', webKeys: ['idToken', 'platform'], nativeKeys: ['idToken', 'platform'], platform: true, run: (auth) => auth.signInWithGoogle('id-token') },
  { name: 'magic link', method: 'POST', path: '/auth/magic-link', webKeys: ['email', 'platform'], nativeKeys: ['email', 'platform'], platform: true, run: (auth) => auth.requestMagicLink(EMAIL) },
  { name: 'redeem', method: 'POST', path: '/auth/magic-link/redeem', webKeys: ['email', 'platform', 'token'], nativeKeys: ['email', 'platform', 'token'], platform: true, run: (auth) => auth.redeemMagicLink({ token: TOKEN, email: EMAIL }) },
  { name: 'mfa code', method: 'POST', path: '/auth/mfa/verify', webKeys: ['code', 'mfaToken', 'platform'], nativeKeys: ['code', 'mfaToken', 'platform'], platform: true, initial: { status: 'mfaRequired', mfaToken: 'mfa-1' }, run: (auth) => auth.verifyMfa({ code: '123456' }) },
  { name: 'mfa recovery', method: 'POST', path: '/auth/mfa/verify', webKeys: ['mfaToken', 'platform', 'recoveryCode'], nativeKeys: ['mfaToken', 'platform', 'recoveryCode'], platform: true, initial: { status: 'mfaRequired', mfaToken: 'mfa-1' }, run: (auth) => auth.verifyMfa({ recoveryCode: 'abcde12345abcde12345' }) },
  { name: 'refresh', method: 'POST', path: '/auth/refresh', webKeys: ['platform'], nativeKeys: ['platform', 'refreshToken'], platform: true, refresh: true, run: (auth) => auth.loadMe() },
  { name: 'me', method: 'GET', path: '/auth/me', webKeys: [], nativeKeys: [], platform: false, run: (auth) => auth.loadMe() },
  { name: 'logout', method: 'POST', path: '/auth/logout', webKeys: ['platform'], nativeKeys: ['platform', 'refreshToken'], platform: true, run: (auth) => auth.signOut() },
  { name: 'enroll', method: 'POST', path: '/auth/totp/enroll', webKeys: [], nativeKeys: [], platform: false, run: (auth) => auth.beginTotpEnrollment() },
  { name: 'confirm', method: 'POST', path: '/auth/totp/enroll/confirm', webKeys: ['code'], nativeKeys: ['code'], platform: false, run: (auth) => auth.confirmTotpEnrollment('123456') },
  { name: 'reset with a code', method: 'POST', path: '/auth/totp/reset', webKeys: ['code'], nativeKeys: ['code'], platform: false, run: (auth) => auth.beginTotpReset({ code: '123 456' }) },
  { name: 'reset with a recovery code', method: 'POST', path: '/auth/totp/reset', webKeys: ['recoveryCode'], nativeKeys: ['recoveryCode'], platform: false, run: (auth) => auth.beginTotpReset({ recoveryCode: 'ABCDE-12345-abcde-12345' }) },
  { name: 'reset confirm', method: 'POST', path: '/auth/totp/reset/confirm', webKeys: ['code'], nativeKeys: ['code'], platform: false, run: (auth) => auth.confirmTotpReset('123456') },
];

function allowedHeaders(kind: 'cookie' | 'bearer', init: RequestInit): void {
  const names = [...new Headers(init.headers).keys()];
  for (const name of names) expect(['accept', 'content-type', 'authorization']).toContain(name);
  const authorization = new Headers(init.headers).get('authorization');
  if (kind === 'cookie') expect(authorization).toBeNull();
  else if (authorization !== null) expect(authorization.startsWith('Bearer ')).toBe(true);
}

test('every call matches the 1.5 table, declares the session platform and sends no custom header', async () => {
  for (const kind of ['cookie', 'bearer'] as const) {
    for (const row of TABLE) {
      const platform = kind === 'cookie' ? 'web' : 'native';
      let meHits = 0;
      const secure = fakeSecureStore({ items: { 'kit.refreshToken': 'rt-1' } });
      const tokens: TokenStore = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
      await tokens.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, tokens.generation());
      const session: Session = kind === 'cookie' ? { kind: 'cookie' } : { kind: 'bearer', tokens };
      const network = fakeFetch((call) => answer(platform, call, row.refresh === true, () => { meHits += 1; return meHits; }));
      const auth = createAuth({
        api: createApiClient({
          baseUrl: 'https://api.example.com',
          session,
          fetch: network.fetch,
          onSessionEnded: () => undefined,
        }),
        session,
        store: createAuthStore(row.initial ?? { status: 'signedIn', user: USER }),
        config: { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google: null },
      });
      await row.run(auth);
      const match = network.calls.filter((call) => new URL(call.url).pathname === row.path && (call.init.method ?? 'GET') === row.method);
      expect(match.length).toBeGreaterThan(0);
      const call = match[0];
      if (call === undefined) throw new Error('missing call');
      const keys = kind === 'cookie' ? row.webKeys : row.nativeKeys;
      const raw = call.init.body;
      const parsed = raw === undefined ? [] : Object.keys(JSON.parse(requestText(raw)) as Record<string, unknown>).sort();
      expect(parsed).toEqual([...keys].sort());
      if (row.platform) {
        const body = JSON.parse(requestText(call.init.body)) as { platform?: string };
        expect(body.platform).toBe(platform);
      }
      for (const recorded of network.calls) allowedHeaders(kind, recorded.init);
    }
  }
});

function answer(platform: 'web' | 'native', call: Call, refresh: boolean, meHits: () => number): Response {
  const path = new URL(call.url).pathname;
  if (path === PATHS.refresh) {
    return platform === 'web'
      ? jsonResponse(204)
      : jsonResponse(200, { accessToken: 'at-2', accessTokenExpiresAt: '2026-01-01T00:00:00.000Z', refreshToken: 'rt-2' });
  }
  if (path === PATHS.me) {
    if (refresh && meHits() === 1) return jsonResponse(401, { error: 'unauthenticated' });
    return jsonResponse(200, { user: USER, session: { id: 's1', platform }, totp: { enabled: false, recoveryCodesRemaining: 0 } });
  }
  if (path === PATHS.logout) return jsonResponse(204);
  if (path === PATHS.magicLink) return jsonResponse(202, { ok: true });
  if (path === PATHS.totpEnrollConfirm || path === PATHS.totpResetConfirm) return jsonResponse(200, { recoveryCodes: CODES });
  if (path === PATHS.totpEnroll || path === PATHS.totpReset) {
    return jsonResponse(200, { secret: 'S', otpauthUri: 'otpauth://totp/x', expiresAt: '2026-01-01T00:00:00.000Z', qrPngDataUrl: 'data:image/png;base64,AAAA' });
  }
  return jsonResponse(200, {
    status: 'signed_in',
    user: USER,
    session: { id: 's1', platform },
    accessToken: 'at-9',
    accessTokenExpiresAt: '2026-01-01T00:00:00.000Z',
    refreshToken: 'rt-9',
  });
}
