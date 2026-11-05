import { cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import SecurityScreen from '../../app/(gate)/(app)/settings/security';
import { fakeAuth } from '../helpers/fakes';

const EMAIL = ['a', 'example.com'].join('@');
const CODES = Array.from({ length: 10 }, (_, index) => String(index).padStart(20, '0'));

function wrap(auth: ReturnType<typeof fakeAuth>): React.ComponentType<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return <AuthProvider auth={auth}>{children}</AuthProvider>;
  };
}

test('one enroll request per press and none on mount', async () => {
  const beginTotpEnrollment = jest.fn(() => Promise.resolve({
    secret: 'S',
    otpauthUri: 'otpauth://totp/x',
    expiresAt: '2026-01-01T00:00:00Z',
    qrPngDataUrl: 'data:image/png;base64,AAAA',
  }));
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { beginTotpEnrollment });
  await renderRouter({ security: SecurityScreen }, { initialUrl: '/security', wrapper: wrap(auth) });
  expect(beginTotpEnrollment).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByText('Set up two-factor'));
  expect(beginTotpEnrollment).toHaveBeenCalledTimes(1);
});

test('shows recovery codes once after confirm and forgets them after I saved these', async () => {
  let loads = 0;
  const loadMe = jest.fn(() => {
    loads += 1;
    const enabled = loads > 1;
    return Promise.resolve({
      user: { id: 'u1', email: EMAIL },
      totp: { enabled, recoveryCodesRemaining: enabled ? 10 : 0 },
    });
  });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, {
    loadMe,
    confirmTotpEnrollment: () => Promise.resolve({ recoveryCodes: CODES }),
  });
  await renderRouter({ security: SecurityScreen }, { initialUrl: '/security', wrapper: wrap(auth) });
  await fireEvent.press(await screen.findByText('Set up two-factor'));
  await fireEvent.press(await screen.findByText('Confirm'));
  expect(await screen.findByText('Save these somewhere safe. Each works once.')).toBeTruthy();
  for (const code of CODES) expect(screen.getByText(code)).toBeTruthy();
  const loadsBefore = loadMe.mock.calls.length;
  await fireEvent.press(screen.getByText('I saved these'));
  await screen.findByText('Two-factor is on. 10 recovery codes left.');
  for (const code of CODES) expect(screen.queryByText(code)).toBeNull();
  expect(loadMe.mock.calls.length).toBeGreaterThan(loadsBefore);
});

test('reauth_required offers sign-in again', async () => {
  const signOut = jest.fn(() => Promise.resolve());
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, {
    signOut,
    confirmTotpEnrollment: () => Promise.reject(new ApiError('http', 'reauth', { status: 403, code: 'reauth_required' })),
  });
  await renderRouter({ security: SecurityScreen }, { initialUrl: '/security', wrapper: wrap(auth) });
  await fireEvent.press(await screen.findByText('Set up two-factor'));
  await fireEvent.press(await screen.findByText('Confirm'));
  expect(await screen.findByText('For your security, sign in again to change two-factor settings.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Sign in again'));
  expect(signOut).toHaveBeenCalledWith('Sign in again to finish setting up two-factor.');
});

test('enrollment_expired returns to the start state', async () => {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, {
    confirmTotpEnrollment: () => Promise.reject(new ApiError('http', 'expired', { status: 400, code: 'enrollment_expired' })),
  });
  await renderRouter({ security: SecurityScreen }, { initialUrl: '/security', wrapper: wrap(auth) });
  await fireEvent.press(await screen.findByText('Set up two-factor'));
  await fireEvent.press(await screen.findByText('Confirm'));
  expect(await screen.findByText('Setup timed out. Start again.')).toBeTruthy();
  expect(screen.getByText('Set up two-factor')).toBeTruthy();
});
