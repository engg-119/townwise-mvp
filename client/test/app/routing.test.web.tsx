import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import MarketingHome from '../../app/(marketing)/index';
import PublicSecurity from '../../app/(marketing)/security';
import AuthGate from '../../app/(gate)/_layout';
import AppLayout from '../../app/(gate)/(app)/_layout';
import Dashboard from '../../app/(gate)/(app)/dashboard';
import Security from '../../app/(gate)/(app)/settings/security';
import type { Auth } from '../../src/auth/auth';
import type { AuthState } from '../../src/auth/store';
import { fakeAuth } from '../helpers/fakes';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

function Layout(props: { state: AuthState }): React.JSX.Element {
  const auth = fakeAuth(props.state);
  return (
    <AuthProvider auth={auth}>
      <AuthGate />
    </AuthProvider>
  );
}

function renderAt(path: string, auth: Auth): void {
  window.history.replaceState(null, '', path);
  // The web entry wraps the app in Head's provider (expo-router's qualified-entry).
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({
          _layout: () => <AuthProvider auth={auth}><RootStack /></AuthProvider>,
          '(marketing)/_layout': MarketingLayout,
          '(marketing)/index': MarketingHome,
          '(marketing)/security': PublicSecurity,
          '(gate)/_layout': AuthGate,
          '(gate)/sign-in': () => <p>Sign-in screen</p>,
          '(gate)/totp': () => null,
          '(gate)/auth/magic': () => null,
          '(gate)/(app)/_layout': AppLayout,
          '(gate)/(app)/dashboard': Dashboard,
          '(gate)/(app)/settings/security': Security,
        })}
        location={path}
      />
    </Head.Provider>,
  );
}

test('shows a loading indicator while restoring', () => {
  render(
    <ExpoRoot
      context={getMockContext({ _layout: () => <Layout state={{ status: 'restoring' }} />, index: () => null })}
      location="/"
    />,
  );
  expect(screen.getByLabelText('Loading')).toBeTruthy();
});

test('unreachable on web offers only Retry', () => {
  render(
    <ExpoRoot
      context={getMockContext({
        _layout: () => <Layout state={{ status: 'unreachable', error: new ApiError('network', 'down') }} />,
        index: () => null,
      })}
      location="/"
    />,
  );
  expect(screen.getByText('Retry')).toBeTruthy();
  expect(screen.queryByText('Sign in again')).toBeNull();
});

test.each<[string, AuthState]>([
  ['restoring', { status: 'restoring' }],
  ['unreachable', { status: 'unreachable', error: new ApiError('network', 'down') }],
])('/ renders the marketing page without restoring while %s', (_name, state) => {
  const restore = jest.fn(() => Promise.resolve());
  renderAt('/', fakeAuth(state, { restore }));
  expect(screen.getByRole('heading', { level: 1, name: 'The Northeast has one season. Your town has its own.' })).toBeTruthy();
  expect(screen.queryByLabelText('Loading')).toBeNull();
  expect(restore).not.toHaveBeenCalled();
});

test('/sign-in still waits for restore', () => {
  renderAt('/sign-in', fakeAuth({ status: 'restoring' }));
  expect(screen.getByLabelText('Loading')).toBeTruthy();
  expect(screen.queryByText('Sign-in screen')).toBeNull();
});

test('a signed-out /settings/security redirects to /sign-in', async () => {
  renderAt('/settings/security', fakeAuth({ status: 'signedOut' }));
  expect(await screen.findByText('Sign-in screen')).toBeTruthy();
  await waitFor(() => { expect(window.location.pathname).toBe('/sign-in'); });
});

test('the public /security page links to /settings/security', () => {
  renderAt('/security', fakeAuth({ status: 'signedOut' }));
  expect(screen.getByRole('heading', { name: 'Security' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Two-factor settings' }).getAttribute('href')).toBe('/settings/security');
});
