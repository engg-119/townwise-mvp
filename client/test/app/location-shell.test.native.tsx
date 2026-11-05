jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { useEffect } from 'react';
import { act, cleanup, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { usePortal } from '../../src/portal/PortalProvider';
import { useLocation } from '../../src/portal/shell/LocationShell';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, LOCATIONS, meOf, offline, orgOf, type FakePortalApi,
} from '../helpers/portal';

// The location layout (spec 15.2) around a stand-in tab page: the first load, a reload of the organization
// (reloadOrg, after a write), a reload whose answer lacks the location, a failed reload, and a new GET /api/me,
// after which cached organization data is cleared (4.3). When the layout puts its loading line or error in place
// of the page, expo-router moves the address to the location's first tab, so those tests open the tab again.

afterEach(async () => {
  await cleanup();
});

const TAB = '(gate)/(app)/(client)/locations/[locationId]/town';

let mounts = 0;

function Probe(): React.JSX.Element {
  const { location, org } = useLocation();
  const { reloadOrg, refreshMe } = usePortal();
  useEffect(() => { mounts += 1; }, []);
  return (
    <View>
      <Text>{`Probe: ${location.name}, ${org.role}`}</Text>
      <Pressable role="button" accessibilityLabel="Reload" onPress={reloadOrg}><Text>Reload</Text></Pressable>
      <Pressable role="button" accessibilityLabel="Read access again" onPress={() => { void refreshMe(); }}>
        <Text>Read access again</Text>
      </Pressable>
    </View>
  );
}

/** Holds every GET /api/org until `release`, as over a slow network. */
function holdOrg(api: FakePortalApi): { release: () => Promise<void> } {
  const gate = deferred<null>();
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => (path === '/api/org' ? gate.promise.then(() => json(path, schema, opts)) : json(path, schema, opts));
  return {
    release: async () => {
      api.json = json;
      await act(async () => { gate.resolve(null); await gate.promise; });
    },
  };
}

async function renderTab(api: FakePortalApi, path = '/locations/l1/town') {
  mounts = 0;
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  return renderRouter(appRoutes(seededRoot(auth), { [TAB]: Probe }), { initialUrl: path });
}

function adminApi(): FakePortalApi {
  return fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
}

test('the first load says “Loading this location”, then shows the header, the tabs and the page', async () => {
  const api = adminApi();
  const held = holdOrg(api);
  await renderTab(api);
  expect(await screen.findByText('Loading this location')).toBeTruthy();
  expect(screen.queryByText(/^Probe:/)).toBeNull();
  await held.release();
  expect(await screen.findByText('Probe: Main Street Bar, org_admin')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Main Street Bar' })).toBeTruthy();
  expect(screen.getByLabelText('Location sections')).toBeTruthy();
});

test('on a phone the tab row scrolls, without animating, to keep the current tab in view, on mount and on a new route', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  try {
    const router = await renderTab(adminApi());
    await screen.findByText('Probe: Main Street Bar, org_admin');
    const sections = screen.getByLabelText('Location sections');
    // A 320px row, and six tabs 90px wide, 4px apart from 4px in: Town, the fourth, ends at 376px.
    await fireEvent(sections, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 53 } } });
    const links = within(sections).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(within(sections).getByRole('link', { name: 'Town' }).props.accessibilityState).toMatchObject({ selected: true });
    for (const [index, link] of links.entries()) {
      await fireEvent(link, 'layout', { nativeEvent: { layout: { x: 4 + index * 94, y: 4, width: 90, height: 44 } } });
    }
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 376 + 4 - 320, animated: false });
    await fireEvent.press(within(sections).getByRole('link', { name: 'Forecast' }));
    expect(router.getPathname()).toBe('/locations/l1');
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });
  } finally {
    scrollTo.mockRestore();
  }
});

test('a reload keeps the page mounted on its tab with the answer before it, then shows the new one', async () => {
  const api = adminApi();
  const router = await renderTab(api);
  await screen.findByText('Probe: Main Street Bar, org_admin');
  expect(mounts).toBe(1);
  const held = holdOrg(api);
  api.org = orgOf('org_admin', LOCATIONS.map((location) => (location.id === 'l1' ? { ...location, name: 'Main Street Tavern' } : location)));
  await fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
  expect(screen.queryByText('Loading this location')).toBeNull();
  expect(screen.getByText('Probe: Main Street Bar, org_admin')).toBeTruthy();
  await held.release();
  expect(await screen.findByText('Probe: Main Street Tavern, org_admin')).toBeTruthy();
  expect(router.getPathname()).toBe('/locations/l1/town');
  expect(mounts).toBe(1);
});

test('a reload whose answer lacks the location says it isn’t available, with a way back to Locations', async () => {
  const api = adminApi();
  const router = await renderTab(api);
  await screen.findByText('Probe: Main Street Bar, org_admin');
  // Deleted elsewhere.
  api.org = orgOf('org_admin', LOCATIONS.filter((location) => location.id !== 'l1'));
  await fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
  expect(screen.queryByText(/^Probe:/)).toBeNull();
  const back = screen.getAllByRole('link', { name: 'Locations' })[1];
  if (back === undefined) throw new Error('no way back');
  await fireEvent.press(back);
  // Locations opens the organization’s one remaining location, never the missing one.
  expect(await screen.findByRole('heading', { name: 'River Grill' })).toBeTruthy();
  expect(router.getPathname()).toBe('/locations/l2');
});

test('a failed reload shows the error with Try again, which reads the organization again', async () => {
  const api = adminApi();
  await renderTab(api);
  await screen.findByText('Probe: Main Street Bar, org_admin');
  api.org = offline();
  await fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  expect(screen.queryByText(/^Probe:/)).toBeNull();
  api.org = orgOf('org_admin');
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'Main Street Bar' })).toBeTruthy();
  expect(screen.queryByText('Can’t reach Townwise. Check your connection and try again.')).toBeNull();
  await fireEvent.press(within(screen.getByLabelText('Location sections')).getByRole('link', { name: 'Town' }));
  expect(await screen.findByText('Probe: Main Street Bar, org_admin')).toBeTruthy();
});

test('after a new GET /api/me the answer before it is cleared, so the page never shows it again', async () => {
  const api = adminApi();
  await renderTab(api);
  await screen.findByText('Probe: Main Street Bar, org_admin');
  // Demoted while the page was open.
  api.me = meOf(ACCESS.member);
  api.org = orgOf('member');
  const held = holdOrg(api);
  await fireEvent.press(screen.getByRole('button', { name: 'Read access again' }));
  expect(await screen.findByText('Loading this location')).toBeTruthy();
  expect(screen.queryByText('Probe: Main Street Bar, org_admin')).toBeNull();
  await held.release();
  const tabs = await screen.findByLabelText('Location sections');
  expect(within(tabs).queryByRole('link', { name: 'Settings' })).toBeNull();
  await fireEvent.press(within(tabs).getByRole('link', { name: 'Town' }));
  expect(await screen.findByText('Probe: Main Street Bar, member')).toBeTruthy();
});
