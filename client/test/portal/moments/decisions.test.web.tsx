import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';
import { Text } from 'react-native';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';

// The welcome on web with MomentProvider mounted by PortalGate (spec 15.8): the live region says it once, the
// visuals are hidden from assistive tech, the page underneath is reachable, and under view-as nothing plays.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

const WELCOME = { firstName: 'Pat', restaurant: 'Sample Mountain Tavern' };
const WELCOMED = 'Welcome to Townwise, Pat. Sample Mountain Tavern, ready to set up.';

function Probe(): React.JSX.Element {
  return <Text role="heading">Probe page</Text>;
}

function renderAt(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  const routes = appRoutes(seededRoot(auth), { '(marketing)/index': () => null, '(gate)/(app)/(client)/dashboard': Probe });
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(routes)} location={path} />
    </Head.Provider>,
  );
}

function layer(): HTMLElement | null {
  return screen.queryByTestId('statement-layer');
}

function welcomePosts(api: FakePortalApi) {
  return writes(api).filter((call) => call.path === '/api/me/welcome');
}

afterEach(() => {
  cleanup();
});

test('the welcome covers the first page, is said once by the live region, posts once and hands the page back', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin, { welcome: WELCOME }) });
  renderAt('/dashboard', api);
  expect(await screen.findByRole('heading', { name: 'Probe page' })).toBeTruthy();
  expect(layer()?.getAttribute('aria-hidden')).toBe('true');
  const region = screen.getByTestId('moment-live-region');
  expect(region.getAttribute('aria-live')).toBe('polite');
  await waitFor(() => { expect(region.textContent).toBe(WELCOMED); });
  expect(welcomePosts(api)).toEqual([{ method: 'POST', path: '/api/me/welcome', body: undefined }]);
  await waitFor(() => { expect(layer()).toBeNull(); }, { timeout: 4500 });
  expect(region.textContent).toBe('');
  expect(welcomePosts(api)).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Probe page' })).toBeTruthy();
}, 10_000);

test('under view-as nothing plays and nothing is posted', async () => {
  const api = fakePortalApi({ me: { ...viewAsMe(ACCESS.admin), welcome: WELCOME } });
  renderAt('/dashboard', api);
  expect(await screen.findByRole('heading', { name: 'Probe page' })).toBeTruthy();
  await act(async () => { await Promise.resolve(); });
  expect(layer()).toBeNull();
  expect(screen.getByTestId('moment-live-region').textContent).toBe('');
  expect(welcomePosts(api)).toEqual([]);
});
