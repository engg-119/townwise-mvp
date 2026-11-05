import { AccessibilityInfo, Dimensions } from 'react-native';
import { cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import SecurityScreen from '../../app/(gate)/(app)/(account)/settings/security';
import { fakeAuth } from '../helpers/fakes';

const EMAIL = ['a', 'example.com'].join('@');
const CODES = Array.from({ length: 10 }, (_, index) => String(index).padStart(20, '0'));
// A made-up base32 setup key, low in entropy so it never reads as a real secret.
const SECRET = 'TOWNWISE'.repeat(4);
const URI = `otpauth://totp/Townwise:a?secret=${SECRET}&issuer=Townwise`;
const ENROLLMENT = { secret: SECRET, otpauthUri: URI, expiresAt: '2026-01-01T00:00:00Z', qrPngDataUrl: 'data:image/png;base64,AAAA' };
const WINDOW = Dimensions.get('window');

function wrap(auth: ReturnType<typeof fakeAuth>): React.ComponentType<{ children: React.ReactNode }> {
  return function Wrapper({ children }) {
    return <AuthProvider auth={auth}>{children}</AuthProvider>;
  };
}

async function renderSecurity(overrides?: Parameters<typeof fakeAuth>[1]): Promise<void> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { beginTotpEnrollment: () => Promise.resolve(ENROLLMENT), ...overrides });
  await renderRouter({ security: SecurityScreen }, { initialUrl: '/security', wrapper: wrap(auth) });
}

/** Where each text or accessible name first appears in the rendered tree, in reading order. */
function order(names: readonly string[]): number[] {
  const tree = JSON.stringify(screen.toJSON());
  return names.map((name) => {
    const at = tree.indexOf(JSON.stringify(name));
    if (at < 0) throw new Error(`not found: ${name}`);
    return at;
  });
}

test('the spec’s words: Two-step sign-in, and a panel that says what setup takes', async () => {
  await renderSecurity();
  expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeTruthy();
  expect(screen.getByText('Settings')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Before you start' })).toBeTruthy();
  expect(screen.getByText('You need an authenticator app on your phone. Setup has two steps: add Townwise to the app, then enter the 6-digit code it shows.')).toBeTruthy();
  expect(screen.queryByText(/two-factor/i)).toBeNull();
});

test('one enroll request per press and none on mount', async () => {
  const beginTotpEnrollment = jest.fn(() => Promise.resolve(ENROLLMENT));
  await renderSecurity({ beginTotpEnrollment });
  expect(beginTotpEnrollment).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  expect(beginTotpEnrollment).toHaveBeenCalledTimes(1);
});

test('step 1 offers the authenticator link, the setup key in fours and the QR; step 2 the code', async () => {
  await renderSecurity();
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  expect(await screen.findByRole('heading', { name: 'Add Townwise to your authenticator app' })).toBeTruthy();
  expect(screen.getByText('Step 1')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open in authenticator app' }).props.href).toBe(URI);
  expect(screen.getByText('Setup key')).toBeTruthy();
  expect(screen.getByText('TOWN WISE TOWN WISE TOWN WISE TOWN WISE')).toBeTruthy();
  expect(screen.getByLabelText('Authentication QR code')).toBeTruthy();
  expect(screen.getByText('Step 2')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Enter the code' })).toBeTruthy();
  expect(screen.getByLabelText('Code').props).toMatchObject({ inputMode: 'numeric', autoComplete: 'one-time-code' });
  // Native has no clipboard in this app: the key is selectable instead of a Copy button.
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  expect(screen.getByText('TOWN WISE TOWN WISE TOWN WISE TOWN WISE').props.selectable).toBe(true);
});

test('a link that is not otpauth is not offered', async () => {
  await renderSecurity({ beginTotpEnrollment: () => Promise.resolve({ ...ENROLLMENT, otpauthUri: 'https://example.com/' }) });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  await screen.findByText('Setup key');
  expect(screen.queryByRole('link', { name: 'Open in authenticator app' })).toBeNull();
});

test.each([
  [375, ['Open in authenticator app', 'Setup key', 'Authentication QR code']],
  [1024, ['Authentication QR code', 'Setup key', 'Open in authenticator app']],
])('at %ipx, the order of the link, the key and the QR', async (width, expected) => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width });
  await renderSecurity();
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  await screen.findByText('Setup key');
  const positions = order(expected);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test('a wrong code prints under the code field, with a curly apostrophe, as an alert announced on iOS', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  await renderSecurity({
    confirmTotpEnrollment: () => Promise.reject(new ApiError('http', 'invalid', { status: 400, code: 'invalid_code' })),
  });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  await fireEvent.changeText(await screen.findByLabelText('Code'), '000000');
  await fireEvent.press(screen.getByText('Confirm'));
  const text = 'That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.';
  const element = await screen.findByText(text);
  expect(element.props.role).toBe('alert');
  expect(element.props['aria-live']).toBe('assertive');
  expect(announce).toHaveBeenCalledWith(text);
  const [field, message, confirm] = order(['Code', text, 'Confirm']);
  expect(field).toBeLessThan(message ?? 0);
  expect(message).toBeLessThan(confirm ?? 0);
});

test('shows recovery codes once after confirm in a panel, and forgets them after I saved these', async () => {
  let loads = 0;
  const loadMe = jest.fn(() => {
    loads += 1;
    const enabled = loads > 1;
    return Promise.resolve({
      user: { id: 'u1', email: EMAIL },
      totp: { enabled, recoveryCodesRemaining: enabled ? 10 : 0 },
    });
  });
  await renderSecurity({ loadMe, confirmTotpEnrollment: () => Promise.resolve({ recoveryCodes: CODES }) });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  await fireEvent.press(await screen.findByText('Confirm'));
  expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeTruthy();
  expect(screen.getByText('If you lose your phone, sign in with one of these instead of a code. Each works once.')).toBeTruthy();
  expect(screen.getByText('Other devices were signed out.')).toBeTruthy();
  for (const code of CODES) expect(screen.getByText(code)).toBeTruthy();
  const loadsBefore = loadMe.mock.calls.length;
  await fireEvent.press(screen.getByText('I saved these'));
  await screen.findByText('Two-step sign-in is on. 10 recovery codes left.');
  for (const code of CODES) expect(screen.queryByText(code)).toBeNull();
  expect(loadMe.mock.calls.length).toBeGreaterThan(loadsBefore);
});

test('one recovery code left reads in the singular', async () => {
  await renderSecurity({
    loadMe: () => Promise.resolve({ user: { id: 'u1', email: EMAIL }, totp: { enabled: true, recoveryCodesRemaining: 1 } }),
  });
  expect(await screen.findByText('Two-step sign-in is on. 1 recovery code left.')).toBeTruthy();
});

test.each([
  ['confirming', 'confirmTotpEnrollment'],
  ['starting', 'beginTotpEnrollment'],
] as const)('reauth_required while %s offers sign-in again', async (_when, method) => {
  const signOut = jest.fn(() => Promise.resolve());
  await renderSecurity({ signOut, [method]: () => Promise.reject(new ApiError('http', 'reauth', { status: 403, code: 'reauth_required' })) });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  if (method === 'confirmTotpEnrollment') await fireEvent.press(await screen.findByText('Confirm'));
  expect(await screen.findByText('For your security, sign in again to set up two-step sign-in.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Sign in again'));
  expect(signOut).toHaveBeenCalledWith('Sign in again to finish setting up two-step sign-in.');
});

test('a failed start says why instead of doing nothing', async () => {
  await renderSecurity({ beginTotpEnrollment: () => Promise.reject(new ApiError('network', 'offline')) });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
});

test('totp_already_enabled with a failed reload says why instead of dropping the error', async () => {
  let loads = 0;
  const loadMe = jest.fn(() => {
    loads += 1;
    if (loads > 1) return Promise.reject(new ApiError('network', 'offline'));
    return Promise.resolve({ user: { id: 'u1', email: EMAIL }, totp: { enabled: false, recoveryCodesRemaining: 0 } });
  });
  await renderSecurity({
    loadMe,
    beginTotpEnrollment: () => Promise.reject(new ApiError('http', 'enabled', { status: 409, code: 'totp_already_enabled' })),
  });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  expect(loadMe).toHaveBeenCalledTimes(2);
});

test('enrollment_expired returns to the start state', async () => {
  await renderSecurity({
    confirmTotpEnrollment: () => Promise.reject(new ApiError('http', 'expired', { status: 400, code: 'enrollment_expired' })),
  });
  await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
  await fireEvent.press(await screen.findByText('Confirm'));
  expect(await screen.findByText('Setup timed out. Start again.')).toBeTruthy();
  expect(screen.getByText('Set up two-step sign-in')).toBeTruthy();
});
