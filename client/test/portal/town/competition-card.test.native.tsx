jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen } from 'expo-router/testing-library';

import { addDays, localToday } from '../../../src/portal/locations/dates';
import { resetProfiles } from '../../../src/portal/profile/useProfile';
import {
  COMPETITION_FAILED, COMPETITION_NO_EVENTS, COMPETITION_NO_PLACE, COMPETITION_NONE, COMPETITION_PLACES_OFF, COMPETITION_SOURCE,
  COMPETITION_WEB_HEADING,
} from '../../../src/portal/town/research-copy';
import { ACCESS, fakePortalApi, meOf, orgOf, refusal, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { mapOf } from '../onboarding/places-fakes';
import { withRoutes } from '../team/fixtures';

// P15's Competition card (D66 design decisions 10 and 15, task 7.3): Google's nearby places lettered on a map, each
// with its upcoming public events, and "Competing events found on the web" for the businesses no live competitor
// matched; with no place or Google off, the gap's line and the web list. Letters only beside a map that loaded. A read
// only. Made-up names, places and links.

const BASE = '/api/org/locations/l1';

function event(id: string, title: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `l-${id.repeat(24)}`, head: 'base', title, start: '2026-12-03', end: '2026-12-03', weekdays: null, startTime: '19:00',
    kind: 'event', category: 'dining', status: 'scheduled', origin: 'competitor', confidence: 'medium', where: null, who: null,
    competitor: { entityId: 'e1', placeId: null }, sources: [{ label: 'example.com', url: 'https://example.com/e' }],
    lastSeenAt: '2026-11-18T12:00:00.000Z', edited: false, hidden: false, ...fields,
  };
}

const COMPETITORS = [
  { letter: 'A', placeId: 'ChIJa', name: 'Example Tavern', type: 'bar', distanceM: 120, x: 0.3, y: 0.4, events: [event('a', 'Trivia night')] },
  { letter: 'B', placeId: 'ChIJb', name: 'Example Diner', type: 'american_restaurant', distanceM: 1234, x: 0.6, y: 0.5, events: [] },
];
const WEB = [{ name: 'Example Brewpub', events: [event('c', 'Live music', { confidence: 'low' })] }];

function setup(competition: unknown): FakePortalApi {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  const from = localToday();
  withRoutes(api, {
    gets: {
      [`${BASE}/research`]: () => ({
        on: true, available: true, town: null, location: null, next: null, gaps: [], entities: [], hidden: [],
      }),
      [`${BASE}/calendar?from=${from}&to=${addDays(from, 6)}`]: () => ({
        town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, researched: true, covers: null, events: [], found: [],
      }),
      [`${BASE}/competition?theme=dark`]: () => competition,
      '/api/me/profile': () => ({ displayName: null, askName: false }),
    },
  });
  return api;
}

afterEach(async () => {
  await cleanup();
  resetProfiles();
});

test('the lettered map, each competitor with its events, and the web list', async () => {
  const api = setup({ gap: null, map: mapOf(['ChIJa', 'ChIJb']), competitors: COMPETITORS, web: WEB });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByLabelText('Map of restaurants, bars and cafes near Main Street Bar')).toBeTruthy();
  expect(screen.getByText('A. Example Tavern')).toBeTruthy();
  expect(screen.getByText('Bar · 120 m')).toBeTruthy();
  expect(screen.getByText('Trivia night')).toBeTruthy();
  expect(screen.getByText('B. Example Diner')).toBeTruthy();
  expect(screen.getByText('American restaurant · 1.2 km')).toBeTruthy();
  expect(screen.getByText(COMPETITION_NO_EVENTS)).toBeTruthy();
  expect(screen.getByText(COMPETITION_SOURCE)).toBeTruthy();
  expect(screen.getByText(COMPETITION_WEB_HEADING)).toBeTruthy();
  expect(screen.getByText('Example Brewpub')).toBeTruthy();
  expect(screen.getByText('Live music')).toBeTruthy();
  expect(screen.getByText(/ · Unconfirmed$/)).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('a map that fails to load drops the letters and keeps the list', async () => {
  const api = setup({ gap: null, map: mapOf(['ChIJa', 'ChIJb']), competitors: COMPETITORS, web: [] });
  await renderApp('/locations/l1/town', api);
  const map = await screen.findByLabelText('Map of restaurants, bars and cafes near Main Street Bar');
  await fireEvent(map, 'error');
  expect(await screen.findByText('Example Tavern')).toBeTruthy();
  expect(screen.queryByText('A. Example Tavern')).toBeNull();
  expect(screen.queryByLabelText('Map of restaurants, bars and cafes near Main Street Bar')).toBeNull();
});

test('no place: the line, no map, and the web list still shows', async () => {
  const api = setup({ gap: 'no_place', map: null, competitors: [], web: WEB });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText(COMPETITION_NO_PLACE)).toBeTruthy();
  expect(screen.getByText('Example Brewpub')).toBeTruthy();
  expect(screen.queryByText(COMPETITION_SOURCE)).toBeNull();
});

test('Google off: the line and the web list', async () => {
  const api = setup({ gap: 'places_off', map: null, competitors: [], web: WEB });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText(COMPETITION_PLACES_OFF)).toBeTruthy();
  expect(screen.getByText('Live music')).toBeTruthy();
});

test('nothing near', async () => {
  const api = setup({ gap: null, map: null, competitors: [], web: [] });
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText(COMPETITION_NONE)).toBeTruthy();
  expect(screen.queryByText(COMPETITION_WEB_HEADING)).toBeNull();
});

test('a failed read says so', async () => {
  const api = setup(refusal(429, 'rate_limited'));
  await renderApp('/locations/l1/town', api);
  expect(await screen.findByText(COMPETITION_FAILED)).toBeTruthy();
});
