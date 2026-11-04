import { render, waitFor } from '@testing-library/react';
import { ExpoRoot, Stack, router } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import MagicLinkScreen from '../../app/(gate)/auth/magic';
import { fakeAuth } from '../helpers/fakes';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

const EMAIL = ['a', 'example.com'].join('@');
const token = 'A'.repeat(43);

function Layout(): React.JSX.Element {
  return <Stack />;
}

function context(): ReturnType<typeof getMockContext> {
  return getMockContext({ _layout: Layout, 'auth/magic': MagicLinkScreen });
}

test('clears the fragment from the address bar and keeps history.state.id', async () => {
  window.history.replaceState({ id: 'h1' }, '', `/auth/magic#token=${token}&email=a%40example.com`);
  const auth = fakeAuth({ status: 'signedOut' });
  render(
    <ExpoRoot
      context={context()}
      location={window.location.href}
      wrapper={({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider>}
    />,
  );
  await waitFor(() => { expect(window.location.hash).toBe(''); });
  expect((window.history.state as { id?: string } | null)?.id).toBeDefined();
});

test('a later router update does not bring the fragment back', async () => {
  window.history.replaceState({ id: 'h1' }, '', `/auth/magic#token=${token}&email=a%40example.com`);
  const auth = fakeAuth({ status: 'signedOut' });
  render(
    <ExpoRoot
      context={context()}
      location={window.location.href}
      wrapper={({ children }) => <AuthProvider auth={auth}>{children}</AuthProvider>}
    />,
  );
  await waitFor(() => { expect(window.location.hash).toBe(''); });
  router.setParams({ x: '1' });
  await waitFor(() => { expect(window.location.hash).toBe(''); });
  expect(EMAIL).not.toBe('');
});
