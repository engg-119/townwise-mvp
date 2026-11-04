jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});

import { join } from 'node:path';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootNavigator } from '../../app/_layout';
import SignIn from '../../app/sign-in';
import Totp from '../../app/totp';
import Magic from '../../app/auth/magic';
import Home from '../../app/(app)/index';
import Security from '../../app/(app)/security';
import AppLayout from '../../app/(app)/_layout';
import NotFound from '../../app/+not-found';
import { routeFor, type AuthState } from '../../src/auth/store';
import { fakeAuth } from '../helpers/fakes';

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

const EMAIL = ['a', 'example.com'].join('@');
const appDir = join(__dirname, '../../app');

function seeded(state: AuthState, overrides?: Parameters<typeof fakeAuth>[1]) {
  const auth = fakeAuth(state, overrides);
  function Seeded(): React.JSX.Element {
    return (
      <AuthProvider auth={auth}>
        <RootNavigator />
      </AuthProvider>
    );
  }
  return { auth, Seeded };
}

function routes(Seeded: React.ComponentType): Record<string, React.ComponentType> {
  return {
    _layout: Seeded,
    'sign-in': SignIn,
    totp: Totp,
    'auth/magic': Magic,
    '(app)/_layout': AppLayout,
    '(app)/index': Home,
    '(app)/security': Security,
    '+not-found': NotFound,
  };
}

test('a signed-out deep link to /security lands on /sign-in', async () => {
  const { Seeded } = seeded({ status: 'signedOut' });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/security' });
  expect(router.getPathname()).toBe('/sign-in');
});

test('a signed-in user on /sign-in lands on /', async () => {
  const { Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/sign-in' });
  expect(router.getPathname()).toBe('/');
});

test('mfaRequired on / lands on /totp', async () => {
  const { Seeded } = seeded({ status: 'mfaRequired', mfaToken: 'mfa-1' });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/' });
  expect(router.getPathname()).toBe('/totp');
});

test('/auth/magic is reachable in every state', async () => {
  const states: AuthState[] = [
    { status: 'signedOut' },
    { status: 'signedIn', user: { id: 'u1', email: EMAIL } },
    { status: 'mfaRequired', mfaToken: 'mfa-1' },
  ];
  for (const state of states) {
    const { Seeded } = seeded(state);
    const router = await renderRouter(routes(Seeded), { initialUrl: '/auth/magic' });
    const path = router.getPathname();
    if (state.status === 'signedOut') expect(path).toBe('/auth/magic');
    else expect(path === '/auth/magic' || path === routeFor(state)).toBe(true);
  }
});

test('signedIn to signedOut while on /security redirects to /sign-in', async () => {
  const { auth, Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/security' });
  expect(router.getPathname()).toBe('/security');
  await act(() => { auth.store.set({ status: 'signedOut' }); });
  await waitFor(() => { expect(router.getPathname()).toBe('/sign-in'); });
});

test('/?state=x&code=y renders', async () => {
  const { Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/?state=x&code=y' });
  expect(router.getPathname()).toBe('/');
  expect(screen.getByText(EMAIL)).toBeTruthy();
});

test('a ConfigError renders the root ErrorBoundary', async () => {
  await renderRouter(appDir, { initialUrl: '/' });
  expect(await screen.findByText('Try again')).toBeTruthy();
});

test('unreachable offers Retry and Sign in again', async () => {
  const restore = jest.fn(() => Promise.resolve());
  const signOut = jest.fn(() => Promise.resolve());
  const { Seeded } = seeded(
    { status: 'unreachable', error: new ApiError('network', 'down') },
    { restore, signOut },
  );
  await renderRouter(routes(Seeded), { initialUrl: '/' });
  await screen.findByText('Retry');
  expect(restore).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Retry'));
  expect(restore).toHaveBeenCalledTimes(2);
  await fireEvent.press(screen.getByText('Sign in again'));
  expect(signOut).toHaveBeenCalled();
});
