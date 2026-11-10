jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { useEffect } from 'react';
import { act, cleanup, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Dimensions, Pressable, ScrollView, Text, View } from 'react-native';
import type { z } from 'zod';

import { ApiError } from '../../src/api/client';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import { usePortal } from '../../src/portal/PortalProvider';
import { useLocation, useScrollingHead } from '../../src/portal/shell/LocationShell';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, LOCATIONS, meOf, offline, orgOf, type FakePortalApi,
} from '../helpers/portal';

// The location layout (spec 15.2) around stand-in pages: the first load, a reload of the organization
// (reloadOrg, after a write), a reload whose answer lacks the location, a failed reload, and a new GET /api/me,
// after which cached organization data is cleared (4.3). When the layout puts its loading line or error in place
// of the page, expo-router moves the address to the location's first page, so those tests open the page again
// from the top bar's sections. TownwiseAI's title greets the person by the name they gave Townwise (P25, D26).

afterEach(async () => {
  await cleanup();
  resetProfiles();
  jest.restoreAllMocks();
});

const TAB = '(gate)/(app)/(client)/locations/[locationId]/town';
const AGENT = '(gate)/(app)/(client)/locations/[locationId]/agent';

/** TownwiseAI's stand-in: on phones it draws the compact header the layout hands it, as the real page does. */
function AgentProbe(): React.JSX.Element {
  const head = useScrollingHead();
  return <View>{head}<Text>Agent probe</Text></View>;
}

/** Answers GET /api/me/profile with `answer` (a body, an ApiError to throw, or a promise of either), and counts reads. */
function serveProfile(api: FakePortalApi, answer: () => unknown): { reads: number } {
  const served = { reads: 0 };
  const json = api.json.bind(api);
  api.json = <T,>(path: `/${string}`, schema: z.ZodType<T>, opts?: Parameters<FakePortalApi['json']>[2]): Promise<T> => {
    if (path !== '/api/me/profile') return json(path, schema, opts);
    served.reads += 1;
    return Promise.resolve(answer()).then((value: unknown) => {
      if (value instanceof ApiError) throw value;
      return schema.parse(value);
    });
  };
  return served;
}

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
  return renderRouter(appRoutes(seededRoot(auth), { [TAB]: Probe, [AGENT]: AgentProbe }), { initialUrl: path });
}

function adminApi(): FakePortalApi {
  return fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
}

test('the first load says “Loading this location”, then shows the header and the page', async () => {
  const api = adminApi();
  const held = holdOrg(api);
  await renderTab(api);
  expect(await screen.findByText('Loading this location')).toBeTruthy();
  expect(screen.queryByText(/^Probe:/)).toBeNull();
  await held.release();
  expect(await screen.findByText('Probe: Main Street Bar, org_admin')).toBeTruthy();
  expect(screen.getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Town' })).toBeTruthy();
  expect(within(screen.getByLabelText('Main')).getByRole('link', { name: 'Town' }).props.accessibilityState).toMatchObject({ selected: true });
});

test('on a phone the top bar’s sections scroll, without animating, to keep the current one in view, on mount and on a new route', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 320 });
  try {
    const router = await renderTab(adminApi());
    await screen.findByText('Probe: Main Street Bar, org_admin');
    const sections = screen.getByLabelText('Sections');
    // A 320px region, and eight links 90px wide and 4px apart in a nav that starts at the 16px margin: Town, the
    // fifth, ends at 16 + 466 = 482px, and keeps 16px after it in view.
    await fireEvent(sections, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 45 } } });
    const links = within(sections).getAllByRole('link');
    expect(links).toHaveLength(8);
    expect(within(sections).getByRole('link', { name: 'Town' }).props.accessibilityState).toMatchObject({ selected: true });
    for (const [index, link] of links.entries()) {
      await fireEvent(link, 'layout', { nativeEvent: { layout: { x: index * 94, y: 0, width: 90, height: 44 } } });
    }
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 482 + 16 - 320, animated: false });
    await fireEvent.press(within(sections).getByRole('link', { name: 'Home' }));
    expect(router.getPathname()).toBe('/locations/l1');
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });
  } finally {
    spy.mockRestore();
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
  await fireEvent.press(screen.getByRole('link', { name: 'Locations' }));
  // Locations opens the organization’s one remaining location, never the missing one.
  expect(await screen.findByText('River Grill, Norwich, VT')).toBeTruthy();
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
  expect(await screen.findByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  expect(screen.queryByText('Can’t reach Townwise. Check your connection and try again.')).toBeNull();
  await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('link', { name: 'Town' }));
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
  await screen.findByText('Main Street Bar, Hanover, NH');
  expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
  await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('link', { name: 'Town' }));
  expect(await screen.findByText('Probe: Main Street Bar, member')).toBeTruthy();
});

describe('TownwiseAI’s title', () => {
  it('greets by name as the page’s h1, top left, and the eyebrow still names the location', async () => {
    const api = adminApi();
    const held = deferred<unknown>();
    serveProfile(api, () => held.promise);
    await renderTab(api, '/locations/l1/agent');
    await screen.findByText('Agent probe');
    // While the name loads, the greeting has none.
    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
    await act(async () => { held.resolve({ displayName: 'Cam', askName: false }); await held.promise; });
    const title = await screen.findByRole('heading', { name: 'Welcome back, Cam.' });
    expect(screen.queryByRole('heading', { name: 'TownwiseAI' })).toBeNull();
    // Top left: the eyebrow over the title, in the header's left column, before the location's links.
    const eyebrow = screen.getByText('Main Street Bar, Hanover, NH');
    expect(title.parent).toBe(eyebrow.parent);
    expect(within(screen.getByLabelText('Main')).getByRole('link', { name: 'TownwiseAI' }).props.accessibilityState).toMatchObject({ selected: true });
    // Every other tab keeps its own title.
    await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('link', { name: 'Town' }));
    expect(await screen.findByRole('heading', { name: 'Town' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Welcome back/ })).toBeNull();
  });

  it('on a phone the compact header greets the same way, on one line, with no doubled full stop', async () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 320 });
    const api = adminApi();
    serveProfile(api, () => ({ displayName: 'St.', askName: false }));
    await renderTab(api, '/locations/l1/agent');
    const title = await screen.findByRole('heading', { name: 'Welcome back, St.' });
    expect(title.props.numberOfLines).toBe(1);
    expect(screen.getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
  });

  it('a name that can’t be read greets without one, and no other tab reads it', async () => {
    const api = adminApi();
    const profile = serveProfile(api, () => offline());
    await renderTab(api);
    await screen.findByText('Probe: Main Street Bar, org_admin');
    expect(profile.reads).toBe(0);
    await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('link', { name: 'TownwiseAI' }));
    await screen.findByText('Agent probe');
    await waitFor(() => { expect(profile.reads).toBe(1); });
    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
  });
});
