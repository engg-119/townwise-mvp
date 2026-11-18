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
import { Dimensions, Pressable, Text, View } from 'react-native';
import type { z } from 'zod';

import { ApiError } from '../../src/api/client';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import { usePortal } from '../../src/portal/PortalProvider';
import { useLocation } from '../../src/portal/shell/LocationShell';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, LOCATIONS, locationOf, meOf, offline, orgOf, type FakePortalApi,
} from '../helpers/portal';

// The location layout (spec 15.2) around stand-in pages: the first load, a reload of the organization
// (reloadOrg, after a write), a reload whose answer lacks the location, a failed reload, and a new GET /api/me,
// after which cached organization data is cleared (4.3). When the layout puts its loading line or error in place
// of the page, expo-router moves the address to the location's first page, so those tests open the page again
// from the top bar's sections. Home's title greets the person by the name they gave Townwise (P11); TownwiseAI has
// no page header (P25, D26).

afterEach(async () => {
  await cleanup();
  resetProfiles();
  jest.restoreAllMocks();
});

const TAB = '(gate)/(app)/(client)/locations/[locationId]/town';
const AGENT = '(gate)/(app)/(client)/locations/[locationId]/agent';
const HOME = '(gate)/(app)/(client)/locations/[locationId]/index';

/** TownwiseAI's stand-in: the layout draws no header around it. */
function AgentProbe(): React.JSX.Element {
  return <View><Text>Agent probe</Text></View>;
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
  return renderRouter(appRoutes(seededRoot(auth), { [TAB]: Probe, [AGENT]: AgentProbe, [HOME]: Probe }), { initialUrl: path });
}

function adminApi(): FakePortalApi {
  return fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
}

/** Town, under the top bar's More (D38), opening More's row when it is closed. */
async function townLink() {
  if (screen.queryByLabelText('More') === null) await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('button', { name: 'More' }));
  return within(screen.getByLabelText('More')).getByRole('link', { name: 'Town' });
}

test('the first load says “Loading this location”, then shows the header and the page', async () => {
  const api = adminApi();
  const held = holdOrg(api);
  await renderTab(api);
  expect(within(await screen.findByTestId('skeleton-location')).getByText('Loading this location')).toBeTruthy();
  expect(screen.queryByText(/^Probe:/)).toBeNull();
  await held.release();
  expect(await screen.findByText('Probe: Main Street Bar, org_admin')).toBeTruthy();
  expect(screen.getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Town' })).toBeTruthy();
  expect((await townLink()).props.accessibilityState).toMatchObject({ selected: true });
});

test('on a phone the top bar’s sections are under Menu, with the current one marked (D51)', async () => {
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 320 });
  try {
    const router = await renderTab(adminApi());
    await screen.findByText('Probe: Main Street Bar, org_admin');
    expect(screen.queryByLabelText('Main')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Menu' }));
    const main = screen.getByLabelText('Main');
    expect(within(main).getAllByRole('link')).toHaveLength(12);
    expect(within(main).getByRole('link', { name: 'Town' }).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(within(main).getByRole('link', { name: 'Home' }));
    expect(router.getPathname()).toBe('/locations/l1');
    expect(screen.getByRole('button', { name: 'Menu' }).props.accessibilityState).toMatchObject({ expanded: false });
  } finally {
    spy.mockRestore();
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
  // Locations opens the organization’s one remaining location, never the missing one; with one, the eyebrow is its town.
  expect(await screen.findByText('Norwich, VT')).toBeTruthy();
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
  await fireEvent.press(await townLink());
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
  expect(within(await screen.findByTestId('skeleton-location')).getByText('Loading this location')).toBeTruthy();
  expect(screen.queryByText('Probe: Main Street Bar, org_admin')).toBeNull();
  await held.release();
  await screen.findByText('Main Street Bar, Hanover, NH');
  expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
  await fireEvent.press(await townLink());
  expect(await screen.findByText('Probe: Main Street Bar, member')).toBeTruthy();
});

describe('the eyebrow (spec 15.2, D29)', () => {
  const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } as const;

  it('with one location the eyebrow is the town only', async () => {
    const only = locationOf('l1', 'Main Street Bar', HANOVER);
    await renderTab(fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', [only]) }));
    await screen.findByText('Probe: Main Street Bar, org_admin');
    expect(screen.getByText('Hanover, NH')).toBeTruthy();
    expect(screen.queryByText('Main Street Bar, Hanover, NH')).toBeNull();
  });

  it('with several, a name ending in its town reads “Sawtooth Kitchen, Hanover, NH”', async () => {
    const sawtooth = locationOf('l1', 'Sawtooth Kitchen, Hanover', HANOVER);
    const second = LOCATIONS[1];
    if (second === undefined) throw new Error('LOCATIONS needs two');
    await renderTab(fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', [sawtooth, second]) }));
    await screen.findByText('Probe: Sawtooth Kitchen, Hanover, org_admin');
    expect(screen.getByText('Sawtooth Kitchen, Hanover, NH')).toBeTruthy();
    expect(screen.queryByText('Sawtooth Kitchen, Hanover, Hanover, NH')).toBeNull();
  });
});

describe('Home’s title and TownwiseAI’s missing header', () => {
  it('Home greets by name as the page’s h1, top left, and the eyebrow still names the location', async () => {
    const api = adminApi();
    const held = deferred<unknown>();
    serveProfile(api, () => held.promise);
    await renderTab(api, '/locations/l1');
    await screen.findByText('Probe: Main Street Bar, org_admin');
    // While the name loads, the greeting has none.
    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
    await act(async () => { held.resolve({ displayName: 'Cam', askName: false }); await held.promise; });
    const title = await screen.findByRole('heading', { name: 'Welcome back, Cam.' });
    // Top left: the eyebrow over the title, in the header's left column, before the location's links.
    const eyebrow = screen.getByText('Main Street Bar, Hanover, NH');
    expect(title.parent).toBe(eyebrow.parent);
    expect(screen.getByRole('link', { name: 'All locations' })).toBeTruthy();
    // Every other tab keeps its own title.
    await fireEvent.press(await townLink());
    expect(await screen.findByRole('heading', { name: 'Town' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Welcome back/ })).toBeNull();
  });

  it('on a phone Home greets the same way, with no doubled full stop', async () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 320 });
    const api = adminApi();
    serveProfile(api, () => ({ displayName: 'St.', askName: false }));
    await renderTab(api, '/locations/l1');
    expect(await screen.findByRole('heading', { name: 'Welcome back, St.' })).toBeTruthy();
  });

  it('a name that can’t be read greets without one, and only Home reads it', async () => {
    const api = adminApi();
    const profile = serveProfile(api, () => offline());
    await renderTab(api);
    await screen.findByText('Probe: Main Street Bar, org_admin');
    expect(profile.reads).toBe(0);
    await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('link', { name: 'Home' }));
    await waitFor(() => { expect(profile.reads).toBe(1); });
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
  });

  it('TownwiseAI has no page header at any width: no eyebrow, no greeting, no h1, no switcher or links, and no profile read', async () => {
    const api = adminApi();
    const profile = serveProfile(api, () => ({ displayName: 'Cam', askName: false }));
    for (const width of [320, 1280]) {
      jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width });
      await renderTab(api, '/locations/l1/agent');
      await screen.findByText('Agent probe');
      expect(screen.queryByText('Main Street Bar, Hanover, NH')).toBeNull();
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'All locations' })).toBeNull();
      // On a phone the sections are under Menu (D51).
      if (width === 320) await fireEvent.press(screen.getByRole('button', { name: 'Menu' }));
      expect(within(screen.getByLabelText('Main')).getByRole('link', { name: 'TownwiseAI' }).props.accessibilityState).toMatchObject({ selected: true });
      await cleanup();
    }
    expect(profile.reads).toBe(0);
  });
});
