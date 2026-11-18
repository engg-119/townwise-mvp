jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import { resetProfiles } from '../../../src/portal/profile/useProfile';
import type { LocationSummary } from '../../../src/portal/schemas';
import { countsLine, googleMapsUrl, lettered, LOCATIONS_MAP_COPY, mentionedLine } from '../../../src/portal/settings/LocationsMap';
import { ACCESS, fakePortalApi, LOCATIONS, locationOf, meOf, orgOf, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { mapOf } from '../onboarding/places-fakes';
import { withRoutes } from '../team/fixtures';

// D47: Settings (P18) shows one map of every location with a Google place, each pin lettered in the organization's
// order, and a legend naming each letter's location and town; a location without a place is listed as not on the map.

afterEach(async () => {
  await cleanup();
  resetProfiles();
});

const [FIRST, SECOND] = LOCATIONS as [LocationSummary, LocationSummary];
const THIRD = locationOf('l3', 'Canoe Club', { townId: null, name: 'Lebanon', state: 'NH' });

function setup(opts: {
  role?: 'org_admin' | 'member'; locations?: LocationSummary[]; requested?: number | null; search?: boolean; mapOn?: boolean;
} = {}): { api: FakePortalApi; bodies: unknown[] } {
  const role = opts.role ?? 'org_admin';
  const org = { ...orgOf(role, opts.locations ?? LOCATIONS, opts.requested ?? null), placeSearch: opts.search ?? true };
  const api = fakePortalApi({ me: meOf(role === 'org_admin' ? ACCESS.admin : ACCESS.member), org });
  // GET /api/org/locations/map: the map of the organization's distinct places, each pin at a made-up position.
  const bodies: unknown[] = [];
  const answer = (): unknown => {
    const { placeIds } = lettered(org.locations);
    bodies.push({ placeIds });
    if (opts.mapOn === false) return { map: null, pins: [] };
    return { map: mapOf(placeIds), pins: placeIds.map((placeId, i) => ({ placeId, letter: String.fromCharCode(65 + i), x: 0.2 + i * 0.3, y: 0.5 })) };
  };
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [] }), '/api/me/profile': () => ({ displayName: null, askName: false }), '/api/org/locations/map?theme=dark': answer } });
  return { api, bodies };
}

describe('lettered', () => {
  test('letters the locations with a place, A first, in the organization’s order, skipping the rest', () => {
    const placed = [{ ...FIRST, placeId: 'ChIJa' }, { ...SECOND, placeId: null }, { ...THIRD, placeId: 'ChIJc' }];
    const { rows, placeIds } = lettered(placed);
    expect(rows.map((row) => [row.letter, row.location.id])).toEqual([['A', 'l1'], ['B', 'l3']]);
    expect(placeIds).toEqual(['ChIJa', 'ChIJc']);
  });

  test('two locations on the same place share its letter, and the map is asked for each place once', () => {
    const placed = [{ ...FIRST, placeId: 'ChIJa' }, { ...SECOND, placeId: 'ChIJb' }, { ...THIRD, placeId: 'ChIJa' }];
    const { rows, placeIds } = lettered(placed);
    expect(rows.map((row) => [row.letter, row.location.id])).toEqual([['A', 'l1'], ['B', 'l2'], ['A', 'l3']]);
    expect(placeIds).toEqual(['ChIJa', 'ChIJb']);
  });
});

describe('row details (2026-11-18)', () => {
  test('the Google Maps link carries the place id and the town, never the name', () => {
    const url = googleMapsUrl('ChIJTestPlace0001', { name: 'Hanover', state: 'NH' });
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=Hanover%2C+NH&query_place_id=ChIJTestPlace0001');
  });

  test('counts read as days of sales and notes, singular and plural', () => {
    const one = { ...FIRST, coverage: { ...FIRST.coverage, dayCount: 1 }, notesCount: 1 };
    const many = { ...FIRST, coverage: { ...FIRST.coverage, dayCount: 1234 }, notesCount: 0 };
    expect(countsLine(one)).toBe('1 day of sales · 1 note');
    expect(countsLine(many)).toBe('1,234 days of sales · 0 notes');
  });
});

describe('P18 Settings: the map of every location (D47)', () => {
  test('asks for one lettered map in the organization’s order, and the legend names each letter’s location and town', async () => {
    const { api, bodies } = setup({ locations: [{ ...THIRD, placeId: 'ChIJTestPlace0003' }, { ...FIRST, placeId: 'ChIJTestPlace0001' }, SECOND] });
    await renderApp('/settings', api);
    expect(await screen.findByRole('heading', { name: LOCATIONS_MAP_COPY.title })).toBeTruthy();
    expect(await screen.findByLabelText('Map of Test Group’s locations')).toBeTruthy();
    expect(bodies).toEqual([{ placeIds: ['ChIJTestPlace0003', 'ChIJTestPlace0001'] }]);
    // The order and letters are pinned by `lettered` above; here, each row's words.
    for (const text of ['A', 'Canoe Club', 'Lebanon, NH', 'B', 'Main Street Bar', 'Hanover, NH']) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText('C')).toBeNull();
    // No place: no letter, and the admin gets the way to link it.
    expect(screen.getByText('Norwich, VT')).toBeTruthy();
    expect(screen.getByText(LOCATIONS_MAP_COPY.notPlaced)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find River Grill on Google Maps' })).toBeTruthy();
    // Each linked row: its counts, that it is linked, its settings and Google Maps by place id with the town as the query.
    expect(screen.getAllByText(LOCATIONS_MAP_COPY.linked)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Location settings for Canoe Club' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in Google Maps: Canoe Club' })).toBeTruthy();
  });

  test('with the map off the legend is a plain list with no letters', async () => {
    const { api } = setup({ locations: [{ ...FIRST, placeId: 'ChIJTestPlace0001' }, SECOND], mapOn: false });
    await renderApp('/settings', api);
    expect(await screen.findByText('Main Street Bar')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByLabelText('Map of Test Group’s locations')).toBeNull(); });
    expect(screen.queryByText('A')).toBeNull();
  });

  test('with no place yet there is no map request, and a member gets the list without the link', async () => {
    const { api, bodies } = setup({ role: 'member' });
    await renderApp('/settings', api);
    expect(await screen.findByText('River Grill')).toBeTruthy();
    expect(bodies).toEqual([]);
    expect(screen.queryByRole('link', { name: /on Google Maps$/ })).toBeNull();
  });

  test('with one location it names the organization, and an admin whose request named more sees the line asking for the others', async () => {
    const { api } = setup({ locations: [{ ...FIRST, placeId: 'ChIJTestPlace0001' }], requested: 3 });
    await renderApp('/settings', api);
    expect(await screen.findByText(mentionedLine(3))).toBeTruthy();
    expect(await screen.findByText('A')).toBeTruthy();
    // One location: the organization's name leads, and the location's own name is said once with its town.
    expect(screen.getByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  });

  test('a member sees the counts and Google Maps but no Location settings', async () => {
    const { api } = setup({ role: 'member', locations: [{ ...FIRST, placeId: 'ChIJTestPlace0001' }, SECOND] });
    await renderApp('/settings', api);
    expect(await screen.findByRole('link', { name: 'Open in Google Maps: Main Street Bar' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Location settings for/ })).toBeNull();
    expect(screen.getAllByText(/days? of sales · \d+ notes?$/).length).toBe(2);
  });

  test('under view-as Location settings is disabled and described by the read-only line', async () => {
    const { api } = setup({ locations: [{ ...FIRST, placeId: 'ChIJTestPlace0001' }] });
    api.me = viewAsMe(ACCESS.admin);
    await renderApp('/settings', api);
    // A disabled LinkButton renders as a disabled button (ui/Button.tsx), as every write on Settings does under view-as.
    const link = await screen.findByRole('button', { name: 'Location settings for Test Group' });
    expect(link.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.queryByRole('link', { name: 'Location settings for Test Group' })).toBeNull();
  });

  test('hover targets appear over the pins only once the image loads; pressing a pin lights it, names it and lights its row', async () => {
    const { api } = setup({ locations: [{ ...THIRD, placeId: 'ChIJTestPlace0003' }, { ...FIRST, placeId: 'ChIJTestPlace0001' }] });
    await renderApp('/settings', api);
    const image = await screen.findByLabelText('Map of Test Group’s locations');
    // Before the image loads there is nothing to point at.
    expect(screen.queryByRole('button', { name: 'A: Canoe Club' })).toBeNull();
    await act(async () => { await fireEvent(image, 'load'); });
    const pin = screen.getByRole('button', { name: 'A: Canoe Club' });
    expect(pin.props.accessibilityState).toMatchObject({ selected: false });
    await fireEvent.press(pin);
    expect(screen.getByRole('button', { name: 'A: Canoe Club' }).props.accessibilityState).toMatchObject({ selected: true });
    // The label over the map, besides the row's own name.
    expect(screen.getAllByText('Canoe Club')).toHaveLength(2);
    // Pressing the other row moves the light to its pin.
    await fireEvent.press(screen.getByText('Main Street Bar'));
    expect(screen.getByRole('button', { name: 'B: Main Street Bar' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole('button', { name: 'A: Canoe Club' }).props.accessibilityState).toMatchObject({ selected: false });
    // Focus (the keyboard's path) lights a pin, and leaving puts the light out.
    await fireEvent(screen.getByRole('button', { name: 'A: Canoe Club' }), 'focus');
    expect(screen.getByRole('button', { name: 'A: Canoe Club' }).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent(screen.getByRole('button', { name: 'A: Canoe Club' }), 'blur');
    expect(screen.getByRole('button', { name: 'A: Canoe Club' }).props.accessibilityState).toMatchObject({ selected: false });
  });

  test('when the image fails (Google refusing the key) there are no targets and no letters', async () => {
    const { api } = setup({ locations: [{ ...FIRST, placeId: 'ChIJTestPlace0001' }, SECOND] });
    await renderApp('/settings', api);
    const image = await screen.findByLabelText('Map of Test Group’s locations');
    await act(async () => { await fireEvent(image, 'error'); });
    expect(screen.queryByRole('button', { name: /^A: / })).toBeNull();
    expect(screen.queryByText('A')).toBeNull();
    expect(screen.getByText('Main Street Bar')).toBeTruthy();
  });

  test('with the Places search off, an unlinked location has no link to find it', async () => {
    const { api } = setup({ search: false });
    await renderApp('/settings', api);
    expect(await screen.findByText('River Grill')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /on Google Maps$/ })).toBeNull();
  });
});
