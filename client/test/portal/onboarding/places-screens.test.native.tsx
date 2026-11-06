jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo } from 'react-native';

import type { LocationSummary, OrgResponse } from '../../../src/portal/schemas';
import {
  ACCESS, fakePortalApi, LOCATIONS, locationOf, meOf, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake, salesOf } from '../locations/fakes';
import { installPlaces, sentWrites, type PlacesFake } from './places-fakes';

// The three screens with the Google Places search on (decision 13): P3 Request access as Steps 1 and 2, P10 Add
// location, and P16's “Change this location’s place”. Each sends the confirmed place's id with the place's town; 503
// places_unavailable leaves the manual fields with a line that says why; with the search off, and under view-as, the
// screens are as they were without it (their own tests: gate-pages, settings, dashboard).

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

describe('P3 Request access with the search on', () => {
  test('Step 1 finds the restaurant; Looks right opens Step 2 with its name, and Send carries the place and its town', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    const { router } = await renderApp('/request-access', api);
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Find your restaurant' })).toBeTruthy();
    expect(places.checks).toBe(1);
    expect(screen.queryByLabelText('Organization name')).toBeNull();
    await find(SEARCH, 'Lou');
    await pick('Lou’s Restaurant, Hanover, NH, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    expect(await screen.findByText('Step 2 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'About you' })).toBeTruthy();
    expect(screen.getByLabelText('Organization name').props.value).toBe('Lou’s Restaurant');
    // The place gives the town: no Town field, and the place says where it came from.
    expect(screen.queryByLabelText('Town')).toBeNull();
    expect(screen.getByText('Hanover, NH, one of the twelve towns Townwise has researched.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
    expect(sentWrites(api)).toEqual([{
      method: 'POST', path: '/api/access-requests',
      body: { orgName: 'Lou’s Restaurant', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'hanover-nh' }, locationCount: 1, placeId: 'ChIJTestPlace0001' },
    }]);
  });

  test('Change place goes back to Step 1; Can’t find it opens the form as it is, with no place sent', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Change place' }));
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
    expect(await screen.findByLabelText('Town')).toBeTruthy();
    expect(screen.queryByText('Step 2 of 3')).toBeNull();
    expect(screen.getByRole('button', { name: 'Search Google Maps instead' })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Organization name'), 'Sample Diner');
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Hanover, NH' }));
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(sentWrites(api)).toHaveLength(1); });
    expect(sentWrites(api)[0]?.body).not.toHaveProperty('placeId');
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
  function setup(): { api: FakePortalApi; places: PlacesFake } {
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin')) });
    return { api, places: installPlaces(api) };
  }

  test('the confirmed place fills Name and gives the town; Add location sends its id, and asks the API nothing first', async () => {
    const { api, places } = setup();
    const added = locationOf('l3', 'Lou’s Restaurant', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, { placeId: 'ChIJTestPlace0001' });
    api.answers['/api/org/locations'] = () => {
      api.org = placed(orgOf('org_admin', [...LOCATIONS, added]));
      return { location: added };
    };
    const { router } = await renderApp('/locations/new', api);
    await find('Search Google Maps for the location', 'Lou');
    expect(places.checks).toBe(0);
    await pick('Lou’s Restaurant, Hanover, NH, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    expect((await screen.findByLabelText('Name')).props.value).toBe('Lou’s Restaurant');
    expect(screen.queryByLabelText('Town')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l3'); });
    expect(sentWrites(api)).toEqual([{
      method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s Restaurant', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' },
    }]);
  });

  test('503 on Add: the fields as they are, with the place’s town filled in and a line; the next Add sends no place', async () => {
    const { api } = setup();
    api.answers['/api/org/locations'] = () => refusal(503, 'places_unavailable');
    await renderApp('/locations/new', api);
    await find('Search Google Maps for the location', 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Add location' }));
    expect(await screen.findByText('Google Maps isn’t answering right now, so the place wasn’t added. Check the town, then add the location without it.')).toBeTruthy();
    expect(screen.getByLabelText('Town name').props.value).toBe('Norwich');
    expect(screen.getByLabelText('State').props.value).toBe('VT');
    await fireEvent.press(screen.getByRole('button', { name: 'Add location' }));
    await waitFor(() => { expect(sentWrites(api)).toHaveLength(2); });
    expect(sentWrites(api)[1]?.body).toEqual({ name: 'Lou’s Bakery', town: { townId: null, name: 'Norwich', state: 'VT' } });
  });

  test('400 place_town_mismatch: back to the search with a line that says Google answered differently', async () => {
    const { api } = setup();
    api.answers['/api/org/locations'] = () => refusal(400, 'place_town_mismatch');
    await renderApp('/locations/new', api);
    await find('Search Google Maps for the location', 'Lou');
    await pick('Lou’s Restaurant, Hanover, NH, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Add location' }));
    expect(await screen.findByText('Google Maps answered differently this time. Search for the place again, or enter it yourself.')).toBeTruthy();
    expect(screen.getByLabelText('Search Google Maps for the location')).toBeTruthy();
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
    expect(await screen.findByText('Linked to a place on Google Maps. Townwise keeps only Google’s id for it.')).toBeTruthy();
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

  test('P3: the card, then Looks right to the Step 2 heading, Change place to the field, and Search again to the field', async () => {
    const moves = focusMoves();
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    installPlaces(api);
    await renderApp('/request-access', api);
    await find(SEARCH, 'Lou');
    // The page opening takes no focus.
    expect(moves()).toEqual([]);
    await pick('Lou’s Restaurant, Hanover, NH, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Change place' }));
    await screen.findByText('Step 1 of 3');
    await find(SEARCH, 'Lou');
    await pick('Lou’s Bakery, Norwich, VT, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Search again' }));
    expect(moves()).toEqual(['Here’s what we found', 'About you', SEARCH, 'Here’s what we found', SEARCH]);
  });

  test('P10: Looks right moves to the place in the form', async () => {
    const moves = focusMoves();
    const api = fakePortalApi({ me: meOf(ACCESS.admin), org: placed(orgOf('org_admin')) });
    installPlaces(api);
    await renderApp('/locations/new', api);
    await find('Search Google Maps for the location', 'Lou');
    await pick('Lou’s Restaurant, Hanover, NH, USA');
    await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
    await screen.findByLabelText('Name');
    expect(moves()).toEqual(['Here’s what we found', 'On Google Maps']);
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
      'Linked to a place on Google Maps. Townwise keeps only Google’s id for it.',
    ]);
  });
});
