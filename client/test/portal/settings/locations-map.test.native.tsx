jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, screen, waitFor } from 'expo-router/testing-library';

import { resetProfiles } from '../../../src/portal/profile/useProfile';
import type { LocationSummary } from '../../../src/portal/schemas';
import { countsLine, googleMapsUrl, lettered, LOCATIONS_MAP_COPY, mentionedLine } from '../../../src/portal/settings/LocationsMap';
import { ACCESS, fakePortalApi, LOCATIONS, locationOf, meOf, orgOf, type FakePortalApi } from '../../helpers/portal';
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
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [] }), '/api/me/profile': () => ({ displayName: null, askName: false }) } });
  const bodies: unknown[] = [];
  api.answers['/api/places/map'] = (raw) => {
    bodies.push(raw);
    return { map: opts.mapOn === false ? null : mapOf((raw as { placeIds: string[] }).placeIds) };
  };
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
    expect(bodies).toEqual([{ placeIds: ['ChIJTestPlace0003', 'ChIJTestPlace0001'], theme: 'dark', labeled: true }]);
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

  test('with the Places search off, an unlinked location has no link to find it', async () => {
    const { api } = setup({ search: false });
    await renderApp('/settings', api);
    expect(await screen.findByText('River Grill')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /on Google Maps$/ })).toBeNull();
  });
});
