jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';
import { AccessibilityInfo } from 'react-native';

import { LOCATION_COPY, PLACE_COPY } from '../../../src/portal/AddLocationForm';
import { townLine } from '../../../src/portal/places/PlaceCard';
import type { LocationSummary, OrgResponse } from '../../../src/portal/schemas';
import {
  ACCESS, deferred, fakePortalApi, LOCATIONS, locationOf, meOf, offline, orgOf, refusal, REQUEST, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake, salesOf } from '../locations/fakes';
import { DETAILS, installPlaces, LONG_NAME, sentWrites, type PlacesFake } from './places-fakes';

// The three screens with the Google Places search on (decision 13): P3 Request access on one screen (Steps 1 and 2), P10 Add
// location, and P16's “Change this location’s place”. Each sends the place's id with the place's town (P3 and P10 one
// per checked place, P10 with each row's outcome on the row); 503 places_unavailable while searching leaves the manual
// fields with a line that says why; with the search off, and under view-as, the screens are as they were without it
// (their own tests: gate-pages, settings, dashboard).

afterEach(async () => {
  await cleanup();
});

const SEARCH = 'Search for your restaurant or bar';
const [FIRST, SECOND] = LOCATIONS as [LocationSummary, LocationSummary];

async function find(label: string, text: string): Promise<void> {
  await fireEvent.changeText(await screen.findByLabelText(label), text);
  // The search waits 250ms after typing (renderRouter runs on fake timers).
  await act(async () => {
    jest.advanceTimersByTime(250);
    await Promise.resolve();
  });
}

async function pick(name: string): Promise<void> {
  await fireEvent.press(await screen.findByRole('button', { name }));
  await screen.findByText('Here’s what we found');
}

function placed(org: OrgResponse): OrgResponse {
  return { ...org, placeSearch: true };
}

/** The groups (Views with role group) named `name`: a checked place's row is one, named by place and town as its box is. */
function groups(name: string): ReturnType<typeof screen.getAllByLabelText> {
  return screen.queryAllByLabelText(name).filter((node) => node.props.role === 'group');
}

/** The one group named `name`. */
function group(name: string): ReturnType<typeof screen.getByLabelText> {
  const found = groups(name);
  const [node] = found;
  if (node === undefined || found.length > 1) throw new Error(`expected one group named ${name}, found ${String(found.length)}`);
  return node;
}

describe('P3 Request access with the search on', () => {
  const RESTAURANT = 'Lou’s Restaurant, Hanover, NH, USA';
  const BAKERY = 'Lou’s Bakery, Norwich, VT, USA';
  const LEBANON = 'Lou’s Restaurant, Lebanon, NH, USA';
  const STREET = '12 South Main Street, Street address · Hanover, NH, USA';
  const NOTHING_CHECKED = 'Check your restaurant above, or enter your town yourself.';

  async function fillAbout(): Promise<void> {
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
  }

  test('one screen: checking places fills Organization name from the first business and Number of locations, and Send carries each place with its kind', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    const { router } = await renderApp('/request-access', api);
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Find your restaurants' })).toBeTruthy();
    // Both steps are on the one page, with no Continue and no Town.
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Continue/ })).toBeNull();
    expect(screen.queryByLabelText('Town')).toBeNull();
    expect(places.checks).toBe(1);
    expect(screen.getByLabelText('Organization name').props.value).toBe('');
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(screen.getByLabelText('Organization name').props.value).toBe('Lou’s Restaurant'); });
    expect(screen.getByLabelText('Number of locations').props.value).toBe('1');
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await waitFor(() => { expect(screen.getByLabelText('Number of locations').props.value).toBe('2'); });
    // The checked places stay in the checklist; there is no summary and no Change places.
    expect(groups('Your places on Google Maps')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Change places' })).toBeNull();
    await fillAbout();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
    expect(sentWrites(api)).toEqual([{
      method: 'POST', path: '/api/access-requests',
      body: { orgName: 'Lou’s Restaurant', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'hanover-nh' }, locationCount: 2,
        places: [
          { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', kind: 'business', town: { townId: 'hanover-nh' } },
          { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', kind: 'business', town: { townId: null, name: 'Norwich', state: 'VT' } },
        ] },
    }]);
  });

  test('an address as the first place leaves Organization name empty', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    await find(SEARCH, '12 South');
    await fireEvent.press(await screen.findByRole('checkbox', { name: STREET }));
    await waitFor(() => { expect(screen.getByLabelText('Number of locations').props.value).toBe('1'); });
    expect(screen.getByLabelText('Organization name').props.value).toBe('');
    // A business checked after it fills the name, and a name the person types stays.
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await waitFor(() => { expect(screen.getByLabelText('Organization name').props.value).toBe('Lou’s Bakery'); });
    await fireEvent.changeText(screen.getByLabelText('Organization name'), 'Lou’s Group');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(screen.getByLabelText('Number of locations').props.value).toBe('3'); });
    expect(screen.getByLabelText('Organization name').props.value).toBe('Lou’s Group');
    await fillAbout();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(sentWrites(api)).toHaveLength(1); });
    const body = sentWrites(api)[0]?.body as { orgName: string; places: { placeId: string; kind: string }[] };
    expect(body.orgName).toBe('Lou’s Group');
    expect(body.places.map((place) => [place.placeId, place.kind])).toEqual([
      ['ChIJTestPlace0006', 'address'], ['ChIJTestPlace0002', 'business'], ['ChIJTestPlace0001', 'business'],
    ]);
  });

  test('Send with nothing checked says to check a place or enter the town, and sends nothing', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    await renderApp('/request-access', api);
    await fireEvent.changeText(await screen.findByLabelText('Organization name'), 'Sample Diner');
    await fillAbout();
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(NOTHING_CHECKED)).toBeTruthy();
    expect(screen.queryByText('Pick a town, or choose Another town.')).toBeNull();
    expect(sentWrites(api)).toEqual([]);
    // Checking a place answers it.
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(screen.queryByText(NOTHING_CHECKED)).toBeNull(); });
  });

  test('Number of locations follows the checked places, never below the number typed', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await find(SEARCH, 'Lou Lebanon');
    await fireEvent.press(await screen.findByRole('checkbox', { name: LEBANON }));
    await waitFor(() => { expect(screen.getByLabelText('Number of locations').props.value).toBe('3'); });
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '5');
    await fireEvent.press(await screen.findByRole('button', { name: `Remove ${RESTAURANT}` }));
    await waitFor(() => { expect(groups(RESTAURANT)).toEqual([]); });
    expect(screen.getByLabelText('Number of locations').props.value).toBe('5');
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fillAbout();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('You checked 2 places, so enter at least 2.')).toBeTruthy();
    expect(sentWrites(api)).toEqual([]);
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(screen.getByLabelText('Number of locations').props.value).toBe('3'); });
  });

  test('a rejected request’s count stays the floor when its sender searches Google Maps instead', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.rejected) });
    installPlaces(api);
    await renderApp('/request-access', api);
    expect((await screen.findByLabelText('Number of locations')).props.value).toBe('3');
    await fireEvent.press(await screen.findByRole('button', { name: 'Search Google Maps instead' }));
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await waitFor(() => { expect(groups(BAKERY)).toHaveLength(1); });
    expect(screen.getByLabelText('Number of locations').props.value).toBe('3');
    // The rejected request's name stays: it is the person's own answer.
    expect(screen.getByLabelText('Organization name').props.value).toBe(REQUEST.orgName);
  });

  test('Can’t find it? shows Town in the same form and sends no places; Search Google Maps instead brings the checked places back', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await waitFor(() => { expect(screen.getByLabelText('Number of locations').props.value).toBe('2'); });
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter your town yourself' }));
    expect(await screen.findByLabelText('Town')).toBeTruthy();
    expect(screen.queryByLabelText(SEARCH)).toBeNull();
    expect(screen.queryByText('Step 1 of 3')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Search Google Maps instead' }));
    expect(await screen.findByLabelText(SEARCH)).toBeTruthy();
    expect(group(RESTAURANT)).toBeTruthy();
    expect(group(BAKERY)).toBeTruthy();
    expect(screen.queryByLabelText('Town')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter your town yourself' }));
    await fireEvent.changeText(await screen.findByLabelText('Organization name'), 'Sample Diner');
    await fillAbout();
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Hanover, NH' }));
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(sentWrites(api)).toHaveLength(1); });
    expect(sentWrites(api)[0]?.body).toEqual({
      orgName: 'Sample Diner', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'hanover-nh' }, locationCount: 1,
    });
  });

  test('Send waits while a place is loading', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    places.holdingDetails = true;
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(places.heldDetails).toHaveLength(1); });
    expect(screen.getByRole('button', { name: 'Send request' }).props.accessibilityState).toMatchObject({ disabled: true });
    places.holdingDetails = false;
    await act(async () => { for (const release of places.heldDetails.splice(0)) release(); await Promise.resolve(); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send request' }).props.accessibilityState).toMatchObject({ disabled: false });
    });
  });

  test('a Google name over 80 characters is cut to 80 in places, and fills Organization name whole', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Long');
    await fireEvent.press(await screen.findByRole('checkbox', { name: new RegExp(`^${LONG_NAME.name}`) }));
    await waitFor(() => { expect(screen.getByLabelText('Organization name').props.value).toHaveLength(100); });
    await fillAbout();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(sentWrites(api)).toHaveLength(1); });
    const body = sentWrites(api)[0]?.body as { places: { name: string }[] };
    expect(body.places[0]?.name).toHaveLength(80);
  });

  test('503 places_unavailable while searching: the form as it is, with a line that says why', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    places.results.Lou = refusal(503, 'places_unavailable');
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    expect(await screen.findByText('Google Maps isn’t answering right now, so you can enter your restaurant yourself.')).toBeTruthy();
    expect(screen.getByLabelText('Town')).toBeTruthy();
    expect(screen.queryByLabelText(SEARCH)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search Google Maps instead' })).toBeNull();
  });

  test('with the search off the form is as it was; under view-as nothing is sent, not even the check', async () => {
    const off = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(off, { on: false });
    await renderApp('/request-access', off);
    expect(await screen.findByLabelText('Organization name')).toBeTruthy();
    expect(screen.getByLabelText('Town')).toBeTruthy();
    expect(screen.queryByText('Step 1 of 3')).toBeNull();
    expect(screen.queryByText('Step 2 of 3')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search Google Maps instead' })).toBeNull();
    await cleanup();
    const viewing = fakePortalApi({ me: viewAsMe(ACCESS.noOrg) });
    const places = installPlaces(viewing);
    await renderApp('/request-access', viewing);
    expect(await screen.findByLabelText('Organization name')).toBeTruthy();
    expect(places.checks).toBe(0);
    expect(writes(viewing)).toEqual([]);
  });
});

describe('P10 Add location with the search on', () => {
  const P10_SEARCH = 'Search Google Maps for the location';
  const RESTAURANT = 'Lou’s Restaurant, Hanover, NH, USA';
  const BAKERY = 'Lou’s Bakery, Norwich, VT, USA';
  const LEBANON = 'Lou’s Restaurant, Lebanon, NH, USA';
  const LEBANON_LINE = townLine({ townId: null, name: 'Lebanon', state: 'NH' });
  /** Another Lou’s Restaurant in Hanover: its Name starts as the first one's does. */
  const WEST = 'Lou’s Restaurant, West Wheelock Street, Hanover, NH, USA';
  const HANOVER_LINE = townLine({ townId: 'hanover-nh', name: 'Hanover', state: 'NH' });
  const ADDRESS_ROW = '12 South Main Street, Street address · Hanover, NH, USA';

  function setup(): { api: FakePortalApi; places: PlacesFake } {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin')) });
    return { api, places: installPlaces(api) };
  }

  /**
   * POST /api/org/locations as the API answers it: `refuse` answers a place's own refusal, a name a location already
   * uses is 409 location_name_taken, and each new location takes the next id from l3 and joins GET /api/org, which
   * starts with `base`.
   */
  function serveLocations(api: FakePortalApi, refuse: Record<string, Error> = {}, base: readonly LocationSummary[] = LOCATIONS): void {
    const added: LocationSummary[] = [];
    api.answers['/api/org/locations'] = (raw) => {
      const body = raw as { name: string; placeId?: string };
      const refused = body.placeId === undefined ? undefined : refuse[body.placeId];
      if (refused !== undefined) return refused;
      if ([...base, ...added].some((location) => location.name === body.name)) return refusal(409, 'location_name_taken');
      const town = (body.placeId === undefined ? undefined : DETAILS[body.placeId]?.town) ?? FIRST.town;
      const location = locationOf(`l${String(added.length + 3)}`, body.name, town, { placeId: body.placeId ?? null });
      added.push(location);
      api.org = placed(orgOf('org_admin', [...base, ...added]));
      return { location };
    };
  }

  /** Holds every GET /api/org until `release` lets it through, or `fail` answers it offline, as over a slow network. */
  function holdOrg(api: FakePortalApi): { release: () => Promise<void>; fail: () => Promise<void> } {
    const gate = deferred<null>();
    const json = api.json.bind(api);
    api.json = (path, schema, opts) => (path === '/api/org' ? gate.promise.then(() => json(path, schema, opts)) : json(path, schema, opts));
    const settle = async (open: () => void): Promise<void> => {
      api.json = json;
      await act(async () => {
        open();
        await gate.promise.catch(() => undefined);
      });
      // The read's answer reaches the page a few promise turns after the gate opens.
      await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
    };
    return {
      release: () => settle(() => { gate.resolve(null); }),
      fail: () => settle(() => { gate.reject(offline()); }),
    };
  }

  async function check(name: string): Promise<void> {
    await fireEvent.press(await screen.findByRole('checkbox', { name }));
  }

  /** The Name field of the checked row named `name`, once Google has answered for it. */
  async function nameOf(name: string): Promise<ReturnType<typeof screen.getByLabelText>> {
    return waitFor(() => within(group(name)).getByLabelText('Name'));
  }

  function orgReads(api: FakePortalApi): number {
    return api.calls.filter((call) => call.method === 'GET' && call.path === '/api/org').length;
  }

  test('two places checked: each Name starts as “{Google name}, {Town}”; Add 2 locations creates them one after another and opens the first', async () => {
    const { api } = setup();
    serveLocations(api);
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    expect((await nameOf(RESTAURANT)).props.value).toBe('Lou’s Restaurant, Hanover');
    expect((await nameOf(BAKERY)).props.value).toBe('Lou’s Bakery, Norwich');
    await fireEvent.press(screen.getByRole('button', { name: 'Add 2 locations' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Restaurant, Hanover', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } },
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Bakery, Norwich', town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: 'ChIJTestPlace0002' } },
    ]);
  });

  test('P9 with none yet and one place checked: no Name field, and the location is named “{Google name}, {Town}”', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, {}, []);
    const { router } = await renderApp('/dashboard', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await waitFor(() => { expect(within(group(RESTAURANT)).getByText(HANOVER_LINE)).toBeTruthy(); });
    expect(within(group(RESTAURANT)).queryByLabelText('Name')).toBeNull();
    // A second check asks a Name of each, with its default; removing it hides them again.
    await check(BAKERY);
    expect((await nameOf(RESTAURANT)).props.value).toBe('Lou’s Restaurant, Hanover');
    expect((await nameOf(BAKERY)).props.value).toBe('Lou’s Bakery, Norwich');
    await fireEvent.press(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
    expect(within(group(RESTAURANT)).queryByLabelText('Name')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Restaurant, Hanover', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } },
    ]);
  });

  test('adding to an organization with one location shows Name, and the existing location keeps its name', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [FIRST])) });
    installPlaces(api);
    serveLocations(api, {}, [FIRST]);
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(BAKERY);
    expect((await nameOf(BAKERY)).props.value).toBe('Lou’s Bakery, Norwich');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    // One POST, and nothing renames Main Street Bar.
    expect(sentWrites(api)).toEqual([
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Bakery, Norwich', town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: 'ChIJTestPlace0002' } },
    ]);
  });

  test('an address place’s Name starts as “{organization}, {Town}”', async () => {
    const { api } = setup();
    serveLocations(api);
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, '12 South');
    await check(ADDRESS_ROW);
    expect((await nameOf(ADDRESS_ROW)).props.value).toBe('Test Group, Hanover');
  });

  test('P9 by hand with none yet: no Name field, and the location is named “{organization}, {Town}”', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, {}, []);
    const { router } = await renderApp('/dashboard', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    await fireEvent.press(await screen.findByLabelText('Town'));
    expect(screen.queryByLabelText('Name')).toBeNull();
    await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([{ method: 'POST', path: '/api/org/locations', body: { name: 'Test Group, Stowe', town: { townId: 'stowe-vt' } } }]);
  });

  test('each row says its outcome: added rows leave, a taken name stays with its line, the limit stops the rest', async () => {
    const { api } = setup();
    serveLocations(api, { ChIJTestPlace0002: refusal(409, 'location_name_taken'), ChIJTestPlace0004: refusal(409, 'location_limit') });
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await find(P10_SEARCH, 'Lou Lebanon');
    await check(LEBANON);
    const reads = orgReads(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 3 locations' }));
    expect(await screen.findByText(LOCATION_COPY.limit)).toBeTruthy();
    // The Hanover row left; the Lebanon one, refused by the limit, stays without a line of its own.
    expect(groups(RESTAURANT)).toHaveLength(0);
    expect(within(group(LEBANON)).getByText(LEBANON_LINE)).toBeTruthy();
    for (const text of [LOCATION_COPY.taken, LOCATION_COPY.limit, PLACE_COPY.notAdded, PLACE_COPY.changed]) {
      expect(within(group(LEBANON)).queryByText(text)).toBeNull();
    }
    // Announced, as the press's other outcomes are: focus stays on the button.
    expect(within(group(BAKERY)).getByText(LOCATION_COPY.taken).props.role).toBe('alert');
    expect(sentWrites(api)).toHaveLength(3);
    await waitFor(() => { expect(orgReads(api)).toBeGreaterThan(reads); });
    expect(router.getPathname()).toBe('/locations/new');
    expect(screen.getByRole('button', { name: 'Add 2 locations' })).toBeTruthy();
  });

  test('a 503 says the place wasn’t added on its row and stops the rest; Enter it yourself starts from that row', async () => {
    const { api } = setup();
    serveLocations(api, { ChIJTestPlace0001: refusal(503, 'places_unavailable') });
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await fireEvent.changeText(await nameOf(RESTAURANT), 'Lou’s on Main');
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(RESTAURANT)).findByText(PLACE_COPY.notAdded)).toBeTruthy();
    expect(within(group(BAKERY)).queryByText(PLACE_COPY.notAdded)).toBeNull();
    expect(sentWrites(api)).toHaveLength(1);
    // “Check the town, then add the location without it”: Name and Town as that row had them.
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    expect((await screen.findByLabelText('Name')).props.value).toBe('Lou’s on Main');
    expect(screen.getByLabelText('Town').props.accessibilityValue).toEqual({ text: 'Hanover, NH' });
  });

  test('while adding, each Name is read-only and Can’t find it? waits', async () => {
    const { api } = setup();
    serveLocations(api);
    const serve = api.answers['/api/org/locations'];
    const held = deferred<null>();
    api.answers['/api/org/locations'] = (body) => held.promise.then(() => serve?.(body));
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect((await nameOf(BAKERY)).props.editable).toBe(false);
    expect(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    expect(screen.queryByLabelText('Town')).toBeNull();
    await act(async () => { held.resolve(null); await held.promise; });
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
  });

  test('while the organization reads again after a press that leaves a row, and when that read fails, the search keeps the row', async () => {
    const { api } = setup();
    serveLocations(api, { ChIJTestPlace0002: refusal(409, 'location_name_taken') });
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    const held = holdOrg(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(BAKERY)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(screen.getByLabelText(P10_SEARCH)).toBeTruthy();
    expect(screen.queryByLabelText('Town')).toBeNull();
    await held.fail();
    expect(screen.getByLabelText(P10_SEARCH)).toBeTruthy();
    expect(within(group(BAKERY)).getByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add location' })).toBeTruthy();
  });

  test('P9 with none yet: a press that adds one and leaves one keeps the form and that row, through the reload; a new name adds it', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, {}, []);
    const { router } = await renderApp('/dashboard', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await find(P10_SEARCH, 'Lou West');
    await check(WEST);
    const held = holdOrg(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    // The first was added and the second's name is taken: while the organization reads again, the form stays, and
    // the row left keeps its Name although it is now the only one.
    expect(await within(group(WEST)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(screen.queryByText('Loading your locations')).toBeNull();
    // The read answers with the first, which would open its Home: the form and the row left stay.
    await held.release();
    expect(router.getPathname()).toBe('/dashboard');
    expect(within(group(WEST)).getByText(HANOVER_LINE)).toBeTruthy();
    expect(within(group(WEST)).getByText(LOCATION_COPY.taken)).toBeTruthy();
    await fireEvent.changeText(within(group(WEST)).getByLabelText('Name'), 'Lou’s on West Wheelock');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l4'); });
    expect(sentWrites(api).map((write) => (write.body as { name: string }).name)).toEqual([
      'Lou’s Restaurant, Hanover', 'Lou’s Restaurant, Hanover', 'Lou’s on West Wheelock',
    ]);
  });

  test('P9: removing the row a press left lets the page move on to the location it added', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, {}, []);
    const { router } = await renderApp('/dashboard', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await find(P10_SEARCH, 'Lou West');
    await check(WEST);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(WEST)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(router.getPathname()).toBe('/dashboard');
    await fireEvent.press(screen.getByRole('button', { name: `Remove ${WEST}` }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
  });

  test('P9 with none yet: a single place whose name the API refuses shows its Name, holding the default, to fix it', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, { ChIJTestPlace0001: refusal(409, 'location_name_taken') }, []);
    const { router } = await renderApp('/dashboard', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await waitFor(() => { expect(within(group(RESTAURANT)).getByText(HANOVER_LINE)).toBeTruthy(); });
    expect(within(group(RESTAURANT)).queryByLabelText('Name')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    expect(await within(group(RESTAURANT)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(within(group(RESTAURANT)).getByLabelText('Name').props.value).toBe('Lou’s Restaurant, Hanover');
    expect(router.getPathname()).toBe('/dashboard');
  });

  test('P9 with none yet: a Name typed while two were checked stays shown, and is sent, once the other is removed', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, {}, []);
    const { router } = await renderApp('/dashboard', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await fireEvent.changeText(await nameOf(RESTAURANT), 'Lou’s on Main');
    await fireEvent.press(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
    expect(within(group(RESTAURANT)).getByLabelText('Name').props.value).toBe('Lou’s on Main');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s on Main', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } },
    ]);
  });

  test('Add location waits while a place is loading, and sends nothing', async () => {
    const { api, places } = setup();
    serveLocations(api);
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await nameOf(RESTAURANT);
    places.holdingDetails = true;
    await check(BAKERY);
    await waitFor(() => { expect(places.heldDetails).toHaveLength(1); });
    const add = screen.getByRole('button', { name: 'Add location' });
    expect(add.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(add);
    expect(sentWrites(api)).toEqual([]);
    places.holdingDetails = false;
    await act(async () => { for (const release of places.heldDetails.splice(0)) release(); await Promise.resolve(); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add 2 locations' }).props.accessibilityState).toMatchObject({ disabled: false });
    });
  });

  test('Google answering differently says so on its row, and the next row is still added', async () => {
    const { api } = setup();
    serveLocations(api, { ChIJTestPlace0001: refusal(400, 'place_town_mismatch') });
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(RESTAURANT)).findByText(PLACE_COPY.changed)).toBeTruthy();
    await waitFor(() => { expect(groups(BAKERY)).toEqual([]); });
    expect(sentWrites(api)).toHaveLength(2);
    expect(router.getPathname()).toBe('/locations/new');
  });

  test('two places with one Google name in one town: the second says the name is taken and keeps its Name; a new name adds it', async () => {
    const { api } = setup();
    serveLocations(api);
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await find(P10_SEARCH, 'Lou West');
    await check(WEST);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(WEST)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    const name = within(group(WEST)).getByLabelText('Name');
    expect(name.props.value).toBe('Lou’s Restaurant, Hanover');
    expect(within(group(WEST)).getByText(HANOVER_LINE)).toBeTruthy();
    await fireEvent.changeText(name, 'Lou’s on West Wheelock');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l4'); });
    expect(sentWrites(api).map((write) => write.body)).toEqual([
      { name: 'Lou’s Restaurant, Hanover', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' },
      { name: 'Lou’s Restaurant, Hanover', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0007' },
      { name: 'Lou’s on West Wheelock', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0007' },
    ]);
  });

  test('an empty Name says “Enter the location’s name.” on its row and sends nothing', async () => {
    const { api } = setup();
    serveLocations(api);
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await fireEvent.changeText(await nameOf(BAKERY), '   ');
    await fireEvent.press(screen.getByRole('button', { name: 'Add 2 locations' }));
    expect(within(group(BAKERY)).getByText('Enter the location’s name.')).toBeTruthy();
    expect(within(group(RESTAURANT)).queryByText('Enter the location’s name.')).toBeNull();
    expect(sentWrites(api)).toEqual([]);
  });

  test('a Google name over 80 characters is cut so the Name keeps its town within 80', async () => {
    const { api } = setup();
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Long');
    await check(`${LONG_NAME.name}, ${LONG_NAME.detail}`);
    const name = await nameOf(`${LONG_NAME.name}, ${LONG_NAME.detail}`);
    expect(name.props.value).toBe(`${LONG_NAME.name.slice(0, 71)}, Hanover`);
    expect(name.props.maxLength).toBe(80);
  });

  test('another failure stops the batch with Try again, which adds the rows left and opens the first it added', async () => {
    const { api } = setup();
    serveLocations(api);
    const serve = api.answers['/api/org/locations'];
    let failing = true;
    api.answers['/api/org/locations'] = (body) => {
      if (failing && (body as { placeId?: string }).placeId === 'ChIJTestPlace0002') {
        failing = false;
        return offline();
      }
      return serve?.(body);
    };
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    expect(groups(RESTAURANT)).toEqual([]);
    expect(router.getPathname()).toBe('/locations/new');
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l4'); });
    expect(sentWrites(api).map((write) => (write.body as { placeId: string }).placeId)).toEqual(['ChIJTestPlace0001', 'ChIJTestPlace0002', 'ChIJTestPlace0002']);
  });

  test('Can’t find it? Enter it yourself adds one by hand; Search Google Maps instead comes back to the checked rows', async () => {
    const { api } = setup();
    serveLocations(api);
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await nameOf(RESTAURANT);
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    expect((await screen.findByLabelText('Name')).props.value).toBe('');
    expect(screen.getByLabelText('Town')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Search Google Maps instead' }));
    expect((await nameOf(RESTAURANT)).props.value).toBe('Lou’s Restaurant, Hanover');
    expect(screen.getByRole('button', { name: 'Add location' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Harbor Room');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([{ method: 'POST', path: '/api/org/locations', body: { name: 'Harbor Room', town: { townId: 'stowe-vt' } } }]);
  });

  test('under view-as the form is the fields alone, read-only, and nothing is sent', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: placed(orgOf('org_admin')) });
    const places = installPlaces(api);
    await renderApp('/locations/new', api);
    expect((await screen.findByLabelText('Name')).props.editable).toBe(false);
    expect(screen.queryByLabelText('Search Google Maps for the location')).toBeNull();
    expect(places.checks + places.autocompletes.length).toBe(0);
    expect(writes(api)).toEqual([]);
  });
});

describe('P16 Change this location’s place', () => {
  function setup(opts: { viewAs?: boolean; on?: boolean; placeId?: string | null; one?: boolean } = {}): { api: FakePortalApi; places: PlacesFake } {
    const locations = [{ ...FIRST, placeId: opts.placeId ?? null }, ...(opts.one === true ? [] : [SECOND])];
    const org = orgOf('org_admin', locations);
    const fake = locationsFake({ sales: { l1: salesOf([]), l2: salesOf([]) } });
    const api = fakePortalApi({
      me: opts.viewAs === true ? viewAsMe(ACCESS.admin) : meOf(ACCESS.admin),
      org: opts.on === false ? org : placed(org),
      fallback: fake,
    });
    return { api, places: installPlaces(api) };
  }

  test('finds the place, says the town moves; Use this place fills in its name, and Save changes sends name, town and place (D47)', async () => {
    const { api } = setup();
    const moved = locationOf('l1', 'Main Street Bar', { townId: null, name: 'Norwich', state: 'VT' }, { placeId: 'ChIJTestPlace0002' });
    api.answers['/api/org/locations/l1'] = () => {
      api.org = placed(orgOf('org_admin', [moved, SECOND]));
      return { location: moved };
    };
    await renderApp('/locations/l1/settings', api);
    // D47: the place leads the first section, under Name, and the town shows as text.
    expect(await screen.findByRole('heading', { name: 'Name and place' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Name and town' })).toBeNull();
    expect(screen.getByText('Not linked to a place on Google Maps.')).toBeTruthy();
    expect(screen.queryByLabelText('Town')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Find this location’s place' }));
    await find('Search Google Maps for this location', 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    expect(screen.getByText('Using this place moves Main Street Bar to Norwich, VT.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Use this place' }));
    // Nothing is saved yet: the place waits in the form, and Name holds its default (D29), which the person can change.
    expect(sentWrites(api)).toEqual([]);
    expect(screen.getByLabelText('Name').props.value).toBe('Lou’s Bakery, Norwich');
    expect(screen.getByText('From Google Maps. Change it if you like; it’s saved as this location’s name when you save.')).toBeTruthy();
    expect(screen.getByText('Norwich, VT')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Lou’s');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(sentWrites(api)).toEqual([{
      method: 'PATCH', path: '/api/org/locations/l1',
      body: { name: 'Lou’s', town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: 'ChIJTestPlace0002' },
    }]);
    expect(await screen.findByText('Linked to a place on Google Maps. Townwise keeps Google’s id for it and its town.')).toBeTruthy();
    expect(screen.getByText('Norwich, VT')).toBeTruthy();
    // Enter the town yourself opens the Town fields with the place's town, so saving them as they are keeps the place.
    await fireEvent.press(screen.getByRole('button', { name: 'Enter the town yourself' }));
    expect(screen.getByLabelText('Town name').props.value).toBe('Norwich');
    expect(screen.getByText('Changing the town here takes the Google Maps place off this location.')).toBeTruthy();
  });

  test('a linked location shows the map of its place; Save changes keeps the town without opening the fields', async () => {
    const { api, places } = setup({ placeId: 'ChIJTestPlace0009' });
    api.answers['/api/org/locations/l1'] = () => ({ location: { ...FIRST, placeId: 'ChIJTestPlace0009' } });
    await renderApp('/locations/l1/settings', api);
    expect(await screen.findByLabelText('Map of Main Street Bar')).toBeTruthy();
    expect(places.mapCalls).toEqual([['ChIJTestPlace0009']]);
    expect(screen.getByText('Hanover, NH')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(sentWrites(api)).toEqual([{
      method: 'PATCH', path: '/api/org/locations/l1', body: { name: 'Main Street Bar', town: { townId: 'hanover-nh' } },
    }]);
  });

  test('with one location the line about moving names the organization (D29)', async () => {
    const { api } = setup({ one: true });
    await renderApp('/locations/l1/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Find this location’s place' }));
    await find('Search Google Maps for this location', 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    expect(screen.getByText('Using this place moves Test Group to Norwich, VT.')).toBeTruthy();
  });

  test('a name typed before picking stays; the place’s name is offered, and Don’t use this place puts everything back', async () => {
    const { api } = setup();
    await renderApp('/locations/l1/settings', api);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Main St');
    await fireEvent.press(screen.getByRole('button', { name: 'Find this location’s place' }));
    await find('Search Google Maps for this location', 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Use this place' }));
    expect(screen.getByLabelText('Name').props.value).toBe('Main St');
    await fireEvent.press(screen.getByRole('button', { name: 'Use “Lou’s Bakery, Norwich” as the name' }));
    expect(screen.getByLabelText('Name').props.value).toBe('Lou’s Bakery, Norwich');
    await fireEvent.press(screen.getByRole('button', { name: 'Don’t use this place' }));
    expect(screen.getByLabelText('Name').props.value).toBe('Main Street Bar');
    expect(screen.getByText('Hanover, NH')).toBeTruthy();
    expect(screen.getByText('Not linked to a place on Google Maps.')).toBeTruthy();
    expect(sentWrites(api)).toEqual([]);
  });

  test('503 while saving: nothing changed, and the line says so', async () => {
    const { api } = setup({ placeId: 'ChIJTestPlace0009' });
    api.answers['/api/org/locations/l1'] = () => refusal(503, 'places_unavailable');
    await renderApp('/locations/l1/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Change this location’s place' }));
    await find('Search Google Maps for this location', 'Lou');
    await pick('Lou’s Restaurant, Hanover, NH, USA');
    // Same town: no line about moving.
    expect(screen.queryByText(/^Using this place moves/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Use this place' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Google Maps isn’t answering right now. Nothing changed; try again later.')).toBeTruthy();
    // The place left the form; the location keeps its name.
    expect(screen.getByLabelText('Name').props.value).toBe('Main Street Bar');
  });

  test('under view-as the button is disabled and described by the read-only line; with the search off there is no section', async () => {
    const { api } = setup({ viewAs: true, placeId: 'ChIJTestPlace0009' });
    await renderApp('/locations/l1/settings', api);
    const button = await screen.findByRole('button', { name: 'Change this location’s place' });
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(button);
    expect(screen.queryByLabelText('Search Google Maps for this location')).toBeNull();
    expect(writes(api)).toEqual([]);
    await cleanup();
    const off = setup({ on: false });
    await renderApp('/locations/l1/settings', off.api);
    expect(await screen.findByRole('heading', { name: 'Name and town' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Change this location’s place' })).toBeNull();
  });
});

describe('focus follows the steps', () => {
  // On native the screen reader moves to what replaced the part that had it (places/focus.ts); the web's focus() is
  // pinned in places-search.test.web.tsx. Each entry names where it moved: a field by its label, text by its words.
  function focusMoves(): () => string[] {
    const moves: string[] = [];
    // Read when the event is sent: what the screen reader would say then.
    jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation((node) => {
      const props = (node as unknown as { props: { accessibilityLabel?: string; children?: unknown } }).props;
      moves.push(props.accessibilityLabel ?? String(props.children));
    });
    return () => moves;
  }
  afterEach(() => { jest.restoreAllMocks(); });

  test('P3: Can’t find it moves focus to Town, and Search Google Maps instead to the search field', async () => {
    const moves = focusMoves();
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    // The page opening and checking take no focus.
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'Lou’s Restaurant, Hanover, NH, USA' }));
    await waitFor(() => { expect(screen.getByLabelText('Organization name').props.value).toBe('Lou’s Restaurant'); });
    expect(moves()).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter your town yourself' }));
    await screen.findByLabelText('Town');
    await fireEvent.press(screen.getByRole('button', { name: 'Search Google Maps instead' }));
    await screen.findByText('Step 1 of 3');
    expect(moves()).toEqual(['Town', SEARCH]);
  });

  test('P16: opening moves to the field; Cancel to the linked line; Use this place to the place in the form; Save back to the linked line', async () => {
    const moves = focusMoves();
    const locations = [{ ...FIRST, placeId: null }, SECOND];
    const api = fakePortalApi({
      me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', locations)),
      fallback: locationsFake({ sales: { l1: salesOf([]), l2: salesOf([]) } }),
    });
    installPlaces(api);
    const moved = locationOf('l1', 'Main Street Bar', { townId: null, name: 'Norwich', state: 'VT' }, { placeId: 'ChIJTestPlace0002' });
    api.answers['/api/org/locations/l1'] = () => {
      api.org = placed(orgOf('org_admin', [moved, SECOND]));
      return { location: moved };
    };
    await renderApp('/locations/l1/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Find this location’s place' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Find this location’s place' }));
    await find('Search Google Maps for this location', 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Use this place' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved.');
    expect(moves()).toEqual([
      'Search Google Maps for this location', 'Not linked to a place on Google Maps.',
      'Search Google Maps for this location', 'Here’s what we found', 'On Google Maps',
      'Linked to a place on Google Maps. Townwise keeps Google’s id for it and its town.',
    ]);
  });
});
