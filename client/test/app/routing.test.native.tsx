jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { join } from 'node:path';
import * as SplashScreen from 'expo-splash-screen';
import { act, cleanup, fireEvent, renderRouter, screen, testRouter, waitFor } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import MarketingHome from '../../app/(marketing)/index';
import About from '../../app/(marketing)/about';
import Privacy from '../../app/(marketing)/privacy';
import Terms from '../../app/(marketing)/terms';
import PublicSecurity from '../../app/(marketing)/security';
import AuthGate from '../../app/(gate)/_layout';
import SignIn from '../../app/(gate)/sign-in';
import Totp from '../../app/(gate)/totp';
import Magic from '../../app/(gate)/auth/magic';
import AppLayout from '../../app/(gate)/(app)/_layout';
import Dashboard from '../../app/(gate)/(app)/dashboard';
import Security from '../../app/(gate)/(app)/settings/security';
import NotFound from '../../app/+not-found';
import { routeFor, type AuthState } from '../../src/auth/store';
import { fakeAuth } from '../helpers/fakes';

const hideAsync = jest.mocked(SplashScreen.hideAsync);

beforeEach(() => {
  hideAsync.mockClear();
});

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
        <RootStack />
      </AuthProvider>
    );
  }
  return { auth, Seeded };
}

function routes(Seeded: React.ComponentType): Record<string, React.ComponentType> {
  return {
    _layout: Seeded,
    '(marketing)/_layout': MarketingLayout,
    '(marketing)/index': MarketingHome,
    '(marketing)/about': About,
    '(marketing)/privacy': Privacy,
    '(marketing)/terms': Terms,
    '(marketing)/security': PublicSecurity,
    '(gate)/_layout': AuthGate,
    '(gate)/sign-in': SignIn,
    '(gate)/totp': Totp,
    '(gate)/auth/magic': Magic,
    '(gate)/(app)/_layout': AppLayout,
    '(gate)/(app)/dashboard': Dashboard,
    '(gate)/(app)/settings/security': Security,
    '+not-found': NotFound,
  };
}

function pending(): Promise<void> {
  return new Promise<void>(() => undefined);
}

test('a signed-out deep link to /settings/security lands on /sign-in', async () => {
  const { Seeded } = seeded({ status: 'signedOut' });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/settings/security' });
  expect(router.getPathname()).toBe('/sign-in');
});

test('a signed-in user on /sign-in lands on /dashboard', async () => {
  const { Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/sign-in' });
  expect(router.getPathname()).toBe('/dashboard');
});

test('/ signed in lands on /dashboard, which links to /settings/security', async () => {
  const { Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/' });
  expect(router.getPathname()).toBe('/dashboard');
  await fireEvent.press(screen.getByText('Security'));
  expect(router.getPathname()).toBe('/settings/security');
});

test('/ signed out lands on /sign-in', async () => {
  const { Seeded } = seeded({ status: 'signedOut' });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/' });
  expect(router.getPathname()).toBe('/sign-in');
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

test('signedIn to signedOut while on /settings/security redirects to /sign-in', async () => {
  const { auth, Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/settings/security' });
  expect(router.getPathname()).toBe('/settings/security');
  await act(() => { auth.store.set({ status: 'signedOut' }); });
  await waitFor(() => { expect(router.getPathname()).toBe('/sign-in'); });
});

test('/?state=x&code=y lands on /dashboard', async () => {
  const { Seeded } = seeded({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/?state=x&code=y' });
  expect(router.getPathname()).toBe('/dashboard');
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

test('a cold start at / keeps the splash up until restore settles', async () => {
  const { auth, Seeded } = seeded({ status: 'restoring' }, { restore: pending });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/' });
  expect(hideAsync).not.toHaveBeenCalled();
  await act(() => { auth.store.set({ status: 'signedOut' }); });
  await waitFor(() => { expect(router.getPathname()).toBe('/sign-in'); });
  expect(hideAsync).toHaveBeenCalled();
});

test('a cold start at /privacy hides the splash without restoring; Back shows Loading while the gate restores', async () => {
  const restore = jest.fn(pending);
  const { Seeded } = seeded({ status: 'restoring' }, { restore });
  await renderRouter(routes(Seeded), { initialUrl: '/privacy' });
  expect(screen.getByText('Privacy')).toBeTruthy();
  expect(hideAsync).toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Back'));
  expect(screen.getByLabelText('Loading')).toBeTruthy();
  expect(restore).toHaveBeenCalledTimes(1);
});

test('an unknown path hides the splash; Go to home shows Loading while the gate restores', async () => {
  const restore = jest.fn(pending);
  const { Seeded } = seeded({ status: 'restoring' }, { restore });
  await renderRouter(routes(Seeded), { initialUrl: '/nope' });
  expect(screen.getByText('This screen does not exist.')).toBeTruthy();
  expect(hideAsync).toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Go to home'));
  expect(await screen.findByLabelText('Loading')).toBeTruthy();
  expect(restore).toHaveBeenCalledTimes(1);
});

test('sign-in links to /privacy and /terms, and Back returns to /sign-in', async () => {
  const { Seeded } = seeded({ status: 'signedOut' });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/sign-in' });
  await fireEvent.press(screen.getByText('Privacy Policy'));
  expect(router.getPathname()).toBe('/privacy');
  await fireEvent.press(screen.getByText('Back'));
  expect(router.getPathname()).toBe('/sign-in');
  await fireEvent.press(screen.getByText('Terms'));
  expect(router.getPathname()).toBe('/terms');
  await fireEvent.press(screen.getByText('Back'));
  expect(router.getPathname()).toBe('/sign-in');
});

test('Back on a cold-start public page enters the app, and the guards pick the screen', async () => {
  const { Seeded } = seeded({ status: 'signedOut' });
  const router = await renderRouter(routes(Seeded), { initialUrl: '/privacy' });
  await fireEvent.press(screen.getByText('Back'));
  await waitFor(() => { expect(router.getPathname()).toBe('/sign-in'); });
});

test('restore runs once across moves between public pages and the gate', async () => {
  const restore = jest.fn(() => Promise.resolve());
  const { Seeded } = seeded({ status: 'signedOut' }, { restore });
  await renderRouter(routes(Seeded), { initialUrl: '/privacy' });
  expect(restore).toHaveBeenCalledTimes(0);
  await testRouter.push('/sign-in');
  expect(restore).toHaveBeenCalledTimes(1);
  await testRouter.back('/privacy');
  expect(restore).toHaveBeenCalledTimes(1);
  await testRouter.push('/sign-in');
  expect(restore).toHaveBeenCalledTimes(1);
});
