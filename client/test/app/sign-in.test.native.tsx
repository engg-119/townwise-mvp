jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { Dimensions, StyleSheet, type StyleProp, type TextStyle } from 'react-native';

afterEach(async () => {
  await cleanup();
});

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import type { Auth } from '../../src/auth/auth';
import { resetGoogleButtonState } from '../../src/auth/GoogleButton';
import type { AuthState } from '../../src/auth/store';
import SignIn from '../../app/(gate)/sign-in';
import { fakeAuth } from '../helpers/fakes';

const google = {
  webClientId: '123-abc.apps.googleusercontent.com',
  iosClientId: '456-def.apps.googleusercontent.com',
};
const config = { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google };

beforeEach(() => {
  resetGoogleButtonState();
  jest.clearAllMocks();
});

async function renderSignIn(state: AuthState, overrides?: Partial<Auth>): Promise<Awaited<ReturnType<typeof render>>> {
  const auth = fakeAuth(state, { config, ...overrides });
  return render(<SignIn />, {
    wrapper: ({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider>,
  });
}

test('one Continue with Google button, links to the terms and privacy pages, and no email field', async () => {
  const view = await renderSignIn({ status: 'signedOut' });
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  expect(screen.getByText('By continuing, you agree to the Terms and the Privacy Policy.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Terms' }).props.href).toBe('/terms');
  expect(screen.getByRole('link', { name: 'Privacy Policy' }).props.href).toBe('/privacy');
  // /request-access would send a signed-out visitor straight back here, so the page has no early-access link; the
  // note under the card is spec P1's line for new people and teammates.
  expect(screen.queryByRole('link', { name: 'Request early access' })).toBeNull();
  expect(screen.queryByText('Request early access')).toBeNull();
  expect(screen.queryByText('Townwise is in development. No forecasts are for sale yet.')).toBeNull();
  expect(view.container.queryAll((instance) => instance.type === 'TextInput')).toHaveLength(0);
  expect(screen.queryByLabelText('Email')).toBeNull();
  expect(screen.queryByText(/sign up/i)).toBeNull();
  // Native has no marketing page, so the wordmark is not a link there.
  expect(screen.getByText('Townwise').props.href).toBeUndefined();
});

test('the P1 copy: the lead, and the line for new people and for teammates', async () => {
  await renderSignIn({ status: 'signedOut' });
  expect(screen.getByText('Use your Google account. Townwise has no passwords.')).toBeTruthy();
  expect(screen.getByText('New to Townwise? Continue with Google, then tell us about your restaurant. Joining your team? Use the email address your admin added.')).toBeTruthy();
  expect(screen.queryByText(/first sign-in creates/)).toBeNull();
});

test('the ID token goes to the server, and its errors keep their messages', async () => {
  jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'id-1', user: { id: 'g', email: 'a@b.c' } } } as never);
  jest.mocked(GoogleSignin.signOut).mockResolvedValue(null);
  const signInWithGoogle = jest.fn(() => Promise.reject(new ApiError('http', 'limited', { status: 429, retryAfterSeconds: 120 })));
  await renderSignIn({ status: 'signedOut' }, { signInWithGoogle });
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
  expect(signInWithGoogle).toHaveBeenCalledWith('id-1');
});

test('a failed Google sign-in says so', async () => {
  jest.mocked(GoogleSignin.signIn).mockRejectedValue(new Error('boom'));
  await renderSignIn({ status: 'signedOut' });
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(await screen.findByText('Google sign-in didn’t go through. Try again.')).toBeTruthy();
});

test('shows the sign-out notice', async () => {
  await renderSignIn({ status: 'signedOut', notice: 'You’ve been signed out. Sign in again to continue.' });
  expect(screen.getByText('You’ve been signed out. Sign in again to continue.')).toBeTruthy();
});

test('says sign-in is off when no Google client is configured', async () => {
  await renderSignIn({ status: 'signedOut' }, { config: { ...config, google: null } });
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText('Sign-in is turned off right now. Try again later.')).toBeTruthy();
});

test('on iOS without an iOS client ID, says sign-in is off instead of showing nothing', async () => {
  await renderSignIn({ status: 'signedOut' }, { config: { ...config, google: { webClientId: google.webClientId, iosClientId: null } } });
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText('Sign-in is turned off right now. Try again later.')).toBeTruthy();
});

test.each([
  [403, 'google_email_not_authoritative', 'Townwise accepts Gmail addresses and Google Workspace accounts. This Google account uses a different email provider.'],
  [403, 'google_email_unverified', 'Your Google account’s email isn’t verified yet. Verify it with Google, then try again.'],
  [409, 'email_linked_to_other_google_account', 'This email is already linked to a different Google account. Sign in with that account, or write to hello@townwise.tech.'],
  [409, 'google_email_conflict', 'Another Townwise account already uses this email. Write to hello@townwise.tech and we’ll sort it out.'],
  [403, 'origin_not_allowed', 'Sign-in isn’t available from this address. Go to townwise.tech to sign in.'],
  [503, 'google_unavailable', 'Google isn’t responding. Try again in a minute.'],
  [404, 'not_found', 'Sign-in is turned off right now. Try again later.'],
])('a %i %s refusal says why, as an alert', async (status, code, text) => {
  jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'id-1', user: { id: 'g', email: 'a@b.c' } } } as never);
  jest.mocked(GoogleSignin.signOut).mockResolvedValue(null);
  const signInWithGoogle = jest.fn(() => Promise.reject(new ApiError('http', 'x', { status, code })));
  await renderSignIn({ status: 'signedOut' }, { signInWithGoogle });
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect((await screen.findByText(text)).props.role).toBe('alert');
  // The server's answer has come back, so the button is back for another try.
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
});

test('while the server checks the Google token, the button gives way to a disabled Signing you in', async () => {
  jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'id-1', user: { id: 'g', email: 'a@b.c' } } } as never);
  jest.mocked(GoogleSignin.signOut).mockResolvedValue(null);
  const signInWithGoogle = jest.fn(() => new Promise<void>(() => undefined));
  await renderSignIn({ status: 'signedOut' }, { signInWithGoogle });
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(await screen.findByRole('button', { name: 'Signing you in…', disabled: true })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  expect(signInWithGoogle).toHaveBeenCalledTimes(1);
});

test('the lines around the card are 16/24 on a phone and 14/20 wider, with no padding on the native links', async () => {
  const lines = [
    'Use a Gmail address or a Google Workspace account.',
    'By continuing, you agree to the Terms and the Privacy Policy.',
    'New to Townwise? Continue with Google, then tell us about your restaurant. Joining your team? Use the email address your admin added.',
  ];
  const style = (text: string): TextStyle => StyleSheet.flatten(screen.getByText(text).props.style as StyleProp<TextStyle>) ?? {};
  const window = Dimensions.get('window');
  for (const [width, size] of [[1024, { fontSize: 14, lineHeight: 20 }], [390, { fontSize: 16, lineHeight: 24 }]] as const) {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...window, width });
    try {
      await renderSignIn({ status: 'signedOut' });
      for (const line of lines) expect(style(line)).toMatchObject(size);
      // Native nested text takes no padding, so the links keep their text-sized box.
      expect(style('Terms')).not.toHaveProperty('paddingVertical');
      await cleanup();
    } finally {
      spy.mockRestore();
    }
  }
});
