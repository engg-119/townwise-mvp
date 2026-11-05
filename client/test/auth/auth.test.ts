import { createApiClient, type Session } from '../../src/api/client';
import { createAuth, normalizeRecoveryCode, normalizeTotpCode, type Auth } from '../../src/auth/auth';
import { createSecureTokenStore, type TokenStore } from '../../src/auth/tokens';
import { createAuthStore } from '../../src/auth/store';
import { fakeFetch, fakeSecureStore, jsonResponse, memoryMarker, requestText } from '../helpers/fakes';

const EMAIL = ['a', 'example.com'].join('@');
const USER = { id: 'u1', email: EMAIL };
function sessionBody(platform: 'web' | 'native') {
  return { id: 's1', platform };
}

function signedInBody(platform: 'web' | 'native', extra?: Record<string, string>) {
  return {
    status: 'signed_in',
    user: USER,
    session: sessionBody(platform),
    accessToken: 'at-1',
    accessTokenExpiresAt: '2026-01-01T00:00:00.000Z',
    refreshToken: 'rt-1',
    ...extra,
  };
}

function meBody(platform: 'web' | 'native') {
  return { user: USER, session: sessionBody(platform), totp: { enabled: false, recoveryCodesRemaining: 0 } };
}

function harness(opts: {
  kind: 'cookie' | 'bearer';
  initial?: Parameters<typeof createAuthStore>[0];
  secure?: ReturnType<typeof fakeSecureStore>;
  failReads?: boolean;
  handler: (call: { url: string; init: RequestInit }) => Response | Promise<Response>;
}): { auth: Auth; network: ReturnType<typeof fakeFetch>; secure: ReturnType<typeof fakeSecureStore>; tokens: TokenStore } {
  const secure = opts.secure ?? fakeSecureStore(opts.failReads === true ? { items: { 'kit.refreshToken': 'rt-1' }, failReads: true } : { items: { 'kit.refreshToken': 'rt-1' } });
  const tokens = createSecureTokenStore({ secureStore: secure, marker: memoryMarker(true) });
  const session: Session = opts.kind === 'cookie' ? { kind: 'cookie' } : { kind: 'bearer', tokens };
  const store = createAuthStore(opts.initial);
  const network = fakeFetch(opts.handler);
  const api = createApiClient({
    baseUrl: 'https://api.example.com',
    session,
    fetch: network.fetch,
    onSessionEnded: () => {
      if (store.getState().status === 'signedIn') {
        store.set({ status: 'signedOut', notice: 'Your session ended. Sign in again.' });
      }
    },
  });
  const auth = createAuth({
    api,
    session,
    store,
    config: { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google: null },
  });
  return { auth, network, secure, tokens };
}

async function seed(tokens: TokenStore): Promise<void> {
  await tokens.save({ accessToken: 'at-1', refreshToken: 'rt-1' }, tokens.generation());
}

test('restore ok', async () => {
  const { auth } = harness({
    kind: 'cookie',
    handler: () => jsonResponse(200, meBody('web')),
  });
  await auth.restore();
  expect(auth.store.getState()).toEqual({ status: 'signedIn', user: USER });
});

test('restore 401', async () => {
  let meCalls = 0;
  const { auth } = harness({
    kind: 'cookie',
    handler: (call) => {
      if (new URL(call.url).pathname.endsWith('/auth/refresh')) return jsonResponse(204);
      meCalls += 1;
      return jsonResponse(meCalls === 1 ? 401 : 401, { error: 'unauthenticated' });
    },
  });
  await auth.restore();
  expect(auth.store.getState()).toEqual({ status: 'signedOut' });
});

test('restore network to unreachable', async () => {
  const { auth } = harness({
    kind: 'cookie',
    handler: () => Promise.reject(new Error('offline')),
  });
  await auth.restore();
  const state = auth.store.getState();
  expect(state.status).toBe('unreachable');
  if (state.status === 'unreachable') expect(state.error.kind).toBe('network');
});

test('restore storage to unreachable', async () => {
  const secure = fakeSecureStore({ items: { 'kit.refreshToken': 'rt-1' }, failReads: true });
  const { auth } = harness({
    kind: 'bearer',
    secure,
    handler: () => jsonResponse(200, meBody('native')),
  });
  await auth.restore();
  const state = auth.store.getState();
  expect(state.status).toBe('unreachable');
  if (state.status === 'unreachable') expect(state.error.kind).toBe('storage');
  expect(secure.items.get('kit.refreshToken')).toBe('rt-1');
});

test('restore retry', async () => {
  let down = true;
  const { auth } = harness({
    kind: 'cookie',
    handler: () => {
      if (down) return Promise.reject(new Error('offline'));
      return jsonResponse(200, meBody('web'));
    },
  });
  await auth.restore();
  expect(auth.store.getState().status).toBe('unreachable');
  down = false;
  await auth.restore();
  expect(auth.store.getState()).toEqual({ status: 'signedIn', user: USER });
});

test('Google ok', async () => {
  const { auth, tokens } = harness({
    kind: 'bearer',
    handler: () => jsonResponse(200, signedInBody('native')),
  });
  await seed(tokens);
  await auth.signInWithGoogle('id-token');
  expect(auth.store.getState()).toEqual({ status: 'signedIn', user: USER });
});

test('Google mfa_required', async () => {
  const { auth } = harness({
    kind: 'cookie',
    handler: () => jsonResponse(200, { status: 'mfa_required', mfaToken: 'mfa-1', mfaTokenExpiresAt: '2026-01-01T00:00:00.000Z' }),
  });
  await auth.signInWithGoogle('id-token');
  expect(auth.store.getState()).toEqual({ status: 'mfaRequired', mfaToken: 'mfa-1' });
});

test('MFA invalid_code stays', async () => {
  const { auth } = harness({
    kind: 'cookie',
    initial: { status: 'mfaRequired', mfaToken: 'mfa-1' },
    handler: () => jsonResponse(400, { error: 'invalid_code' }),
  });
  await expect(auth.verifyMfa({ code: '123456' })).rejects.toMatchObject({ code: 'invalid_code' });
  expect(auth.store.getState()).toEqual({ status: 'mfaRequired', mfaToken: 'mfa-1' });
});

test('MFA invalid_mfa_token to signedOut with notice', async () => {
  const { auth } = harness({
    kind: 'cookie',
    initial: { status: 'mfaRequired', mfaToken: 'mfa-1' },
    handler: () => jsonResponse(401, { error: 'invalid_mfa_token' }),
  });
  await expect(auth.verifyMfa({ code: '123456' })).rejects.toMatchObject({ code: 'invalid_mfa_token' });
  expect(auth.store.getState()).toEqual({ status: 'signedOut', notice: 'That took too long. Sign in again.' });
});

test('recovery code sent normalized', async () => {
  let body: unknown;
  const { auth } = harness({
    kind: 'cookie',
    initial: { status: 'mfaRequired', mfaToken: 'mfa-1' },
    handler: (call) => {
      body = JSON.parse(requestText(call.init.body)) as unknown;
      return jsonResponse(200, signedInBody('web'));
    },
  });
  await auth.verifyMfa({ recoveryCode: 'ABCDE-12345-abcde-12345' });
  expect(body).toMatchObject({ recoveryCode: 'abcde12345abcde12345' });
});

test('cancelMfa', () => {
  const { auth } = harness({ kind: 'cookie', initial: { status: 'mfaRequired', mfaToken: 'mfa-1' }, handler: () => jsonResponse(200, {}) });
  auth.cancelMfa();
  expect(auth.store.getState()).toEqual({ status: 'signedOut' });
});

test('normalizeTotpCode', () => {
  expect(normalizeTotpCode('123 456')).toBe('123456');
  expect(normalizeTotpCode('1234567')).toBe('123456');
});

test('normalizeRecoveryCode', () => {
  expect(normalizeRecoveryCode('ABCDE-12345-abcde-12345')).toBe('abcde12345abcde12345');
});

test('session end from refresh failure never calls logout', async () => {
  const { auth, network, tokens } = harness({
    kind: 'bearer',
    initial: { status: 'signedIn', user: USER },
    handler: (call) => {
      const path = new URL(call.url).pathname;
      if (path.endsWith('/auth/refresh')) return jsonResponse(401, { error: 'session_ended' });
      return jsonResponse(401, { error: 'unauthenticated' });
    },
  });
  await seed(tokens);
  await expect(auth.loadMe()).rejects.toMatchObject({ kind: 'signed_out' });
  expect(auth.store.getState()).toEqual({ status: 'signedOut', notice: 'Your session ended. Sign in again.' });
  expect(network.calls.some((call) => new URL(call.url).pathname.endsWith('/auth/logout'))).toBe(false);
});

test('anonymous restore does not report a session end', async () => {
  const { auth } = harness({
    kind: 'cookie',
    handler: (call) => {
      if (new URL(call.url).pathname.endsWith('/auth/refresh')) return jsonResponse(401, { error: 'session_ended' });
      return jsonResponse(401, { error: 'unauthenticated' });
    },
  });
  await auth.restore();
  expect(auth.store.getState()).toEqual({ status: 'signedOut' });
});

test('web sign-out that fails on the network keeps the user signed in and reports the failure', async () => {
  const { auth } = harness({
    kind: 'cookie',
    initial: { status: 'signedIn', user: USER },
    handler: () => Promise.reject(new Error('offline')),
  });
  await expect(auth.signOut()).rejects.toMatchObject({ kind: 'network' });
  expect(auth.store.getState()).toEqual({ status: 'signedIn', user: USER });
});

test('native sign-out offline still deletes the refresh token', async () => {
  const { auth, secure, tokens } = harness({
    kind: 'bearer',
    initial: { status: 'signedIn', user: USER },
    handler: () => Promise.reject(new Error('offline')),
  });
  await seed(tokens);
  await auth.signOut();
  expect(secure.items.size).toBe(0);
  expect(auth.store.getState()).toEqual({ status: 'signedOut' });
});

test('cookie transport stores nothing and drops tokens found in a sign-in response body', async () => {
  const { auth } = harness({
    kind: 'cookie',
    handler: () => jsonResponse(200, signedInBody('web', { accessToken: 'at-x', refreshToken: 'rt-x' })),
  });
  await auth.signInWithGoogle('id-token');
  const encoded = JSON.stringify(auth.store.getState());
  expect(encoded).not.toContain('at-x');
  expect(encoded).not.toContain('rt-x');
  const storage = (globalThis as { localStorage?: { length: number } }).localStorage;
  if (storage !== undefined) expect(storage.length).toBe(0);
});
