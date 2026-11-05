jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));
// Another mailbox in the one constant: every portal line that names the address must follow it. The link carries
// a subject, so an address read back from the link would carry it too.
jest.mock('../../src/marketing/links', () => ({
  ...jest.requireActual<object>('../../src/marketing/links'),
  CONTACT_EMAIL: 'team@example.org',
  CONTACT_HREF: 'mailto:team@example.org?subject=Townwise',
}));

import { render } from '@testing-library/react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { cleanup, fireEvent, screen } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { resetGoogleButtonState } from '../../src/auth/GoogleButton';
import { LOCATION_COPY } from '../../src/portal/AddLocationForm';
import { CONTACT_EMAIL, CONTACT_HREF } from '../../src/portal/contact';
import SignIn from '../../app/(gate)/sign-in';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';

afterEach(async () => {
  await cleanup();
});

test('the address is the site’s CONTACT_EMAIL, not read back from the link', () => {
  expect(CONTACT_HREF).toBe('mailto:team@example.org?subject=Townwise');
  expect(CONTACT_EMAIL).toBe('team@example.org');
});

test('Add location’s limit names the address', () => {
  expect(LOCATION_COPY.limit).toBe('You’ve reached 25 locations. Write to team@example.org for more.');
});

test.each([
  ['email_linked_to_other_google_account', 'This email is already linked to a different Google account. Sign in with that account, or write to team@example.org.'],
  ['google_email_conflict', 'Another Townwise account already uses this email. Write to team@example.org and we’ll sort it out.'],
])('the sign-in refusal %s names the address', async (code, text) => {
  resetGoogleButtonState();
  jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'id-1', user: { id: 'g', email: 'a@b.c' } } } as never);
  jest.mocked(GoogleSignin.signOut).mockResolvedValue(null);
  const auth = fakeAuth({ status: 'signedOut' }, {
    config: { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google: { webClientId: 'w', iosClientId: 'i' } },
    signInWithGoogle: () => Promise.reject(new ApiError('http', 'x', { status: 409, code })),
  });
  await render(<SignIn />, { wrapper: ({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider> });
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(await screen.findByText(text)).toBeTruthy();
});

test.each([
  ['rejected', ACCESS.rejected],
  ['paused', ACCESS.suspended],
] as const)('No access, %s: the questions line links the address', async (_variant, access) => {
  await renderApp('/no-access', fakePortalApi({ me: meOf(access) }));
  const link = await screen.findByRole('link', { name: 'team@example.org' });
  expect(link.props.href).toBe('mailto:team@example.org?subject=Townwise');
  expect(screen.queryByText(/hello@townwise\.tech/)).toBeNull();
});
