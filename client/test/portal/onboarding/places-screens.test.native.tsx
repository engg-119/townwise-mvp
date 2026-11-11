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
  ACCESS, deferred, fakePortalApi, LOCATIONS, locationOf, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake, salesOf } from '../locations/fakes';
import { DETAILS, installPlaces, LONG_NAME, sentWrites, type PlacesFake } from './places-fakes';

// The three screens with the Google Places search on (decision 13): P3 Request access as Steps 1 and 2, P10 Add
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

  async function fillAbout(): Promise<void> {
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
  }

  test('Step 1 “Find your restaurants” checks several places; Continue opens Step 2 with them in place of Town, and Send carries each one', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    const { router } = await renderApp('/request-access', api);
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Find your restaurants' })).toBeTruthy();
    expect(places.checks).toBe(1);
    expect(screen.queryByLabelText('Organization name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' }).props.accessibilityState).toMatchObject({ disabled: true });
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Continue with 1 place' })).toBeTruthy(); });
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 2 places' }));
    expect(await screen.findByText('Step 2 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
    expect(screen.getByLabelText('Organization name').props.value).toBe('Lou’s Restaurant');
    expect(screen.queryByLabelText('Town')).toBeNull();
    const summary = group('Your places on Google Maps');
    expect(within(summary).getByText('Lou’s Restaurant')).toBeTruthy();
    expect(within(summary).getByText('Lou’s Bakery')).toBeTruthy();
    expect(screen.getByLabelText('Number of locations').props.value).toBe('2');
    await fillAbout();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
    expect(sentWrites(api)).toEqual([{
      method: 'POST', path: '/api/access-requests',
      body: { orgName: 'Lou’s Restaurant', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'hanover-nh' }, locationCount: 2,
        places: [
          { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', town: { townId: 'hanover-nh' } },
          { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', town: { townId: null, name: 'Norwich', state: 'VT' } },
        ] },
    }]);
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
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 3 places' }));
    expect((await screen.findByLabelText('Number of locations')).props.value).toBe('3');
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '5');
    await fireEvent.press(screen.getByRole('button', { name: 'Change places' }));
    await fireEvent.press(await screen.findByRole('button', { name: `Remove ${RESTAURANT}` }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 2 places' }));
    expect((await screen.findByLabelText('Number of locations')).props.value).toBe('5');
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fillAbout();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('You checked 2 places, so enter at least 2.')).toBeTruthy();
    expect(sentWrites(api)).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Change places' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 2 places' }));
    expect((await screen.findByLabelText('Number of locations')).props.value).toBe('2');
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
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 2 places' }));
    expect((await screen.findByLabelText('Number of locations')).props.value).toBe('3');
  });

  test('Change places keeps them checked; Can’t find it sends no places; Search Google Maps instead comes back to them', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 2 places' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Change places' }));
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: RESTAURANT }).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByRole('checkbox', { name: BAKERY }).props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    expect(await screen.findByLabelText('Town')).toBeTruthy();
    expect(screen.queryByText('Step 2 of 3')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Organization name'), 'Sample Diner');
    await fillAbout();
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Hanover, NH' }));
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(sentWrites(api)).toHaveLength(1); });
    expect(sentWrites(api)[0]?.body).not.toHaveProperty('places');
  });

  test('Search Google Maps instead shows the checked places again', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: BAKERY }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 2 places' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Change places' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Search Google Maps instead' }));
    await screen.findByText('Step 1 of 3');
    expect(group(RESTAURANT)).toBeTruthy();
    expect(group(BAKERY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with 2 places' })).toBeTruthy();
  });

  test('Continue waits while a place is loading', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    places.holdingDetails = true;
    await fireEvent.press(await screen.findByRole('checkbox', { name: RESTAURANT }));
    await waitFor(() => { expect(places.heldDetails).toHaveLength(1); });
    expect(screen.getByRole('button', { name: /^Continue/ }).props.accessibilityState).toMatchObject({ disabled: true });
    places.holdingDetails = false;
    await act(async () => { for (const release of places.heldDetails.splice(0)) release(); await Promise.resolve(); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continue with 1 place' }).props.accessibilityState).toMatchObject({ disabled: false });
    });
  });

  test('a Google name over 80 characters is cut to 80 in places, and fills Organization name whole', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Long');
    await fireEvent.press(await screen.findByRole('checkbox', { name: new RegExp(`^${LONG_NAME.name}`) }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 1 place' }));
    expect((await screen.findByLabelText('Organization name')).props.value).toHaveLength(100);
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
    expect(screen.queryByRole('button', { name: 'Search Google Maps instead' })).toBeNull();
  });

  test('with the search off the form is as it was; under view-as nothing is sent, not even the check', async () => {
    const off = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(off, { on: false });
    await renderApp('/request-access', off);
    expect(await screen.findByLabelText('Organization name')).toBeTruthy();
    expect(screen.queryByText('Step 1 of 3')).toBeNull();
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

  test('checking two places gives each a Name from Google; Add 2 locations creates them one after another and opens the first', async () => {
    const { api } = setup();
    serveLocations(api);
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await check(BAKERY);
    expect((await nameOf(RESTAURANT)).props.value).toBe('Lou’s Restaurant');
    expect((await nameOf(BAKERY)).props.value).toBe('Lou’s Bakery');
    await fireEvent.press(screen.getByRole('button', { name: 'Add 2 locations' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Restaurant', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } },
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Bakery', town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: 'ChIJTestPlace0002' } },
    ]);
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
    await find(P10_SEARCH, 'Lou Lebanon');
    await check(LEBANON);
    const held = holdOrg(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    // Hanover was added and Lebanon's name is taken: while the organization reads again, the form stays.
    expect(await within(group(LEBANON)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(screen.queryByText('Loading your locations')).toBeNull();
    // The read answers with Hanover, which would open its Home: the form and Lebanon's row stay.
    await held.release();
    expect(router.getPathname()).toBe('/dashboard');
    expect(within(group(LEBANON)).getByText(LEBANON_LINE)).toBeTruthy();
    expect(within(group(LEBANON)).getByText(LOCATION_COPY.taken)).toBeTruthy();
    await fireEvent.changeText(within(group(LEBANON)).getByLabelText('Name'), 'Lou’s Restaurant Lebanon');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l4'); });
    expect(sentWrites(api).map((write) => (write.body as { name: string }).name)).toEqual([
      'Lou’s Restaurant', 'Lou’s Restaurant', 'Lou’s Restaurant Lebanon',
    ]);
  });

  test('P9: removing the row a press left lets the page move on to the location it added', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin', [])) });
    installPlaces(api);
    serveLocations(api, {}, []);
    const { router } = await renderApp('/dashboard', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await find(P10_SEARCH, 'Lou Lebanon');
    await check(LEBANON);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(LEBANON)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    expect(router.getPathname()).toBe('/dashboard');
    await fireEvent.press(screen.getByRole('button', { name: `Remove ${LEBANON}` }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
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

  test('two rows with the same Google name: the second says the name is taken and keeps its Name; a new name adds it', async () => {
    const { api } = setup();
    serveLocations(api);
    const { router } = await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Lou');
    await check(RESTAURANT);
    await find(P10_SEARCH, 'Lou Lebanon');
    await check(LEBANON);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add 2 locations' }));
    expect(await within(group(LEBANON)).findByText(LOCATION_COPY.taken)).toBeTruthy();
    const name = within(group(LEBANON)).getByLabelText('Name');
    expect(name.props.value).toBe('Lou’s Restaurant');
    expect(within(group(LEBANON)).getByText(LEBANON_LINE)).toBeTruthy();
    await fireEvent.changeText(name, 'Lou’s Restaurant Lebanon');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l4'); });
    expect(sentWrites(api).map((write) => write.body)).toEqual([
      { name: 'Lou’s Restaurant', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' },
      { name: 'Lou’s Restaurant', town: { townId: null, name: 'Lebanon', state: 'NH' }, placeId: 'ChIJTestPlace0004' },
      { name: 'Lou’s Restaurant Lebanon', town: { townId: null, name: 'Lebanon', state: 'NH' }, placeId: 'ChIJTestPlace0004' },
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

  test('a Google name over 80 characters starts the Name at 80', async () => {
    const { api } = setup();
    await renderApp('/locations/new', api);
    await find(P10_SEARCH, 'Long');
    await check(`${LONG_NAME.name}, ${LONG_NAME.detail}`);
    const name = await nameOf(`${LONG_NAME.name}, ${LONG_NAME.detail}`);
    expect(name.props.value).toBe(LONG_NAME.name.slice(0, 80));
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
    expect((await nameOf(RESTAURANT)).props.value).toBe('Lou’s Restaurant');
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
  function setup(opts: { viewAs?: boolean; on?: boolean; placeId?: string | null } = {}): { api: FakePortalApi; places: PlacesFake } {
    const locations = [{ ...FIRST, placeId: opts.placeId ?? null }, SECOND];
    const org = orgOf('org_admin', locations);
    const fake = locationsFake({ sales: { l1: salesOf([]), l2: salesOf([]) } });
    const api = fakePortalApi({
      me: opts.viewAs === true ? viewAsMe(ACCESS.admin) : meOf(ACCESS.admin),
      org: opts.on === false ? org : placed(org),
      fallback: fake,
    });
    return { api, places: installPlaces(api) };
  }

  test('finds the place, says the town moves, and Use this place sends the place with its town, then Saved', async () => {
    const { api } = setup();
    const moved = locationOf('l1', 'Main Street Bar', { townId: null, name: 'Norwich', state: 'VT' }, { placeId: 'ChIJTestPlace0002' });
    api.answers['/api/org/locations/l1'] = () => {
      api.org = placed(orgOf('org_admin', [moved, SECOND]));
      return { location: moved };
    };
    await renderApp('/locations/l1/settings', api);
    expect(await screen.findByRole('heading', { name: 'Change this location’s place' })).toBeTruthy();
    expect(screen.getByText('Not linked to a place on Google Maps.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Find this location’s place' }));
    await find('Search Google Maps for this location', 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    expect(screen.getByText('Using this place moves Main Street Bar to Norwich, VT.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Use this place' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(sentWrites(api)).toEqual([{
      method: 'PATCH', path: '/api/org/locations/l1', body: { town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: 'ChIJTestPlace0002' },
    }]);
    expect(await screen.findByText('Linked to a place on Google Maps. Townwise keeps Google’s id for it and its town.')).toBeTruthy();
    // The Name and town form now shows the place's town, so saving it keeps the place.
    expect(screen.getByLabelText('Town name').props.value).toBe('Norwich');
    expect(screen.getByText('Changing the town here takes the Google Maps place off this location.')).toBeTruthy();
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
    expect(await screen.findByText('Google Maps isn’t answering right now. Nothing changed; try again later.')).toBeTruthy();
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

  test('P3: Continue moves to the Step 2 heading, and Change places to the search field', async () => {
    const moves = focusMoves();
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    // The page opening and checking take no focus.
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'Lou’s Restaurant, Hanover, NH, USA' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue with 1 place' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Change places' }));
    await screen.findByText('Step 1 of 3');
    expect(moves()).toEqual(['About you', SEARCH]);
  });

  test('P16: opening moves to the field; Cancel and Use this place move to the line that says whether it is linked', async () => {
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
    await screen.findByText('Saved.');
    expect(moves()).toEqual([
      'Search Google Maps for this location', 'Not linked to a place on Google Maps.',
      'Search Google Maps for this location', 'Here’s what we found',
      'Linked to a place on Google Maps. Townwise keeps Google’s id for it and its town.',
    ]);
  });
});
