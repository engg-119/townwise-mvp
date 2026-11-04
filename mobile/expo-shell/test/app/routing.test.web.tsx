import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootNavigator } from '../../app/_layout';
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
      <RootNavigator />
    </AuthProvider>
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
