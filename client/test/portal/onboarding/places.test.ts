import {
  checkPlaceSearch, createLocationAt, placeChanged, placeName, placesMapFor, placesUnavailable, placeSuggestionSchema, sendAccessRequestAt,
  setLocationPlace, suggestionLabel, suggestionLine, townInputOf, townLabel, type UsablePlace,
} from '../../../src/portal/onboarding/places';
import { accessRequestSchema } from '../../../src/portal/schemas';
import { searchStatus } from '../../../src/portal/onboarding/usePlaceSearch';
import { GOOGLE_SOURCE, PLACES_SOURCE, townLine } from '../../../src/portal/places/PlaceCard';
import { ACCESS, fakePortalApi, locationOf, meOf, offline, refusal, writes } from '../../helpers/portal';
import { DETAILS, installPlaces, mapOf } from './places-fakes';

// The Places module's calls and words (onboarding/places.ts, usePlaceSearch.ts, places/PlaceCard.tsx): the on/off
// check never asks Google, the writes carry the place id and the place's own town, and every line says plainly what
// Google Maps answered.

const HANOVER = DETAILS.ChIJTestPlace0001;
if (HANOVER === undefined || HANOVER.town === null) throw new Error('fixture');
const PLACE: UsablePlace = { ...HANOVER, town: HANOVER.town, name: 'Lou’s Restaurant', kind: 'business' };
const ADDRESS_PLACE: UsablePlace = { ...HANOVER, placeId: 'ChIJTestPlace0006', town: HANOVER.town, name: '12 South Main Street', kind: 'address' };

describe('checkPlaceSearch', () => {
  test('GET /api/places/status: placeSearch says on or off, and any failure is off', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    await expect(checkPlaceSearch(api)).resolves.toBe(true);
    places.on = false;
    await expect(checkPlaceSearch(api)).resolves.toBe(false);
    api.answers['GET /api/places/status'] = () => offline();
    await expect(checkPlaceSearch(api)).resolves.toBe(false);
    api.answers['GET /api/places/status'] = () => refusal(403, 'view_as_read_only');
    await expect(checkPlaceSearch(api)).resolves.toBe(false);
    // The check is a read: no autocomplete, so nothing the API refuses and nothing Google would see.
    expect(writes(api)).toEqual([]);
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual(Array(4).fill('GET /api/places/status'));
    expect(places.checks).toBe(2);
  });
});

describe('the writes that carry a place', () => {
  test('the access request, a new location and a location’s place send the place id with the place’s town', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const location = locationOf('l9', 'Lou’s', PLACE.town, { placeId: PLACE.placeId });
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    api.answers['/api/org/locations'] = () => ({ location });
    api.answers['/api/org/locations/l9'] = () => ({ location });
    const request = { orgName: 'Lou’s', contactName: 'Pat', contactRole: 'Owner', town: townInputOf(PLACE.town), locationCount: 1 };
    await sendAccessRequestAt(api, request, [PLACE, ADDRESS_PLACE]);
    await createLocationAt(api, { name: 'Lou’s', town: townInputOf(PLACE.town) }, PLACE.placeId, null);
    // D25: in open as admin it also names the organization the page shows.
    await createLocationAt(api, { name: 'Lou’s', town: townInputOf(PLACE.town) }, PLACE.placeId, 'o1');
    expect(await setLocationPlace(api, 'l9', PLACE)).toMatchObject({ placeId: 'ChIJTestPlace0001' });
    expect(writes(api)).toEqual([
      {
        method: 'POST', path: '/api/access-requests', body: {
          ...request,
          places: [
            { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', kind: 'business', town: { townId: 'hanover-nh' } },
            { placeId: 'ChIJTestPlace0006', name: '12 South Main Street', kind: 'address', town: { townId: 'hanover-nh' } },
          ],
        },
      },
      { method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } },
      {
        method: 'POST', path: '/api/org/locations', body: { name: 'Lou’s', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001', orgId: 'o1' },
      },
      { method: 'PATCH', path: '/api/org/locations/l9', body: { town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } },
    ]);
  });

  test('placesMapFor asks for the map of the ids given, and answers null while the map is off', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const places = installPlaces(api);
    await expect(placesMapFor(api, ['ChIJTestPlace0001', 'ChIJTestPlace0002'])).resolves.toEqual(mapOf(['ChIJTestPlace0001', 'ChIJTestPlace0002']));
    places.mapOn = false;
    await expect(placesMapFor(api, ['ChIJTestPlace0001'])).resolves.toBeNull();
    expect(writes(api)).toEqual([
      { method: 'POST', path: '/api/places/map', body: { placeIds: ['ChIJTestPlace0001', 'ChIJTestPlace0002'] } },
      { method: 'POST', path: '/api/places/map', body: { placeIds: ['ChIJTestPlace0001'] } },
    ]);
  });

  test('placeName trims and keeps the first 80 characters', () => {
    expect(placeName({ name: '  Lou’s  ' })).toBe('Lou’s');
    expect(placeName({ name: 'x'.repeat(100) })).toHaveLength(80);
  });

  test('townInputOf: one of the twelve by id, another town by name and state', () => {
    expect(townInputOf({ townId: 'stowe-vt', name: 'Stowe', state: 'VT' })).toEqual({ townId: 'stowe-vt' });
    expect(townInputOf({ townId: null, name: 'Norwich', state: 'VT' })).toEqual({ townId: null, name: 'Norwich', state: 'VT' });
    expect(townLabel({ townId: null, name: 'Norwich', state: 'VT' })).toBe('Norwich, VT');
  });

  test('which refusals mean “search again” and which mean the search is off', () => {
    for (const code of ['place_town_mismatch', 'unknown_place', 'place_not_supported']) expect(placeChanged(refusal(400, code))).toBe(true);
    expect(placeChanged(refusal(400, 'unknown_town'))).toBe(false);
    expect(placesUnavailable(refusal(503, 'places_unavailable'))).toBe(true);
    expect(placesUnavailable(refusal(503, 'unavailable'))).toBe(false);
  });
});

describe('a place’s kind', () => {
  test('a suggestion, and a request’s place, read a missing kind as a business', () => {
    expect(placeSuggestionSchema.parse({ placeId: 'p1', name: 'Lou’s', detail: 'Hanover, NH, USA' }).kind).toBe('business');
    expect(placeSuggestionSchema.parse({ placeId: 'p1', name: '12 South Main Street', detail: '', kind: 'address' }).kind).toBe('address');
    expect(placeSuggestionSchema.safeParse({ placeId: 'p1', name: 'Hanover', detail: '', kind: 'locality' }).success).toBe(false);
    const request = {
      id: 'r1', orgName: 'Lou’s', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
      locationCount: 2, note: null, status: 'pending', createdAt: '2026-11-11T00:00:00.000Z', decidedAt: null, decisionMessage: null,
      places: [
        { placeId: 'p1', name: null, town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } },
        { placeId: 'p2', name: '12 South Main Street', kind: 'address', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } },
      ],
    };
    expect(accessRequestSchema.parse(request).places?.map((place) => place.kind)).toEqual(['business', 'address']);
  });

  test('suggestionLine marks an address and leaves a business’s line as Google’s', () => {
    expect(suggestionLine({ detail: 'South Main Street, Hanover, NH, USA', kind: 'business' })).toBe('South Main Street, Hanover, NH, USA');
    expect(suggestionLine({ detail: '', kind: 'business' })).toBe('');
    expect(suggestionLine({ detail: 'Hanover, NH, USA', kind: 'address' })).toBe('Street address · Hanover, NH, USA');
    expect(suggestionLine({ detail: '', kind: 'address' })).toBe('Street address');
    // The box, the option, the row and its Remove are named “{name}, {line}”, or by the name alone with no line.
    expect(suggestionLabel({ name: '12 South Main Street', detail: 'Hanover, NH, USA', kind: 'address' }))
      .toBe('12 South Main Street, Street address · Hanover, NH, USA');
    expect(suggestionLabel({ name: 'Lou’s', detail: 'Hanover, NH, USA', kind: 'business' })).toBe('Lou’s, Hanover, NH, USA');
    expect(suggestionLabel({ name: 'Lou’s', detail: '', kind: 'business' })).toBe('Lou’s');
  });
});

describe('the words', () => {
  test('the town line names one of the twelve, another town, or why there is none', () => {
    expect(townLine({ townId: 'hanover-nh', name: 'Hanover', state: 'NH' })).toBe('Hanover, NH, one of the twelve towns Townwise has researched.');
    expect(townLine({ townId: null, name: 'Norwich', state: 'VT' }))
      .toBe('Norwich, VT. Townwise hasn’t researched this town yet, so you’ll see your own data without a town profile.');
    expect(townLine(null)).toBe('Townwise works with businesses in a US town, and Google Maps puts this place in none.');
    expect(GOOGLE_SOURCE).toBe('From Google Maps. Townwise keeps Google’s id for the place and its town, not the address or the map.');
  });

  test('the checked list’s source line names what a request keeps of each place', () => {
    expect(PLACES_SOURCE).toBe('From Google Maps. Townwise keeps Google’s id for each place, its name and its town, not the address or the map.');
    expect(GOOGLE_SOURCE).toBe('From Google Maps. Townwise keeps Google’s id for the place and its town, not the address or the map.');
  });

  test('the status line counts the answer, says when nothing matches, and nothing before an answer', () => {
    const one = [{ placeId: 'ChIJTestPlace0001', name: 'Lou’s', detail: '', kind: 'business' as const }];
    expect(searchStatus({ searched: null, suggestions: [], gone: false })).toBeNull();
    expect(searchStatus({ searched: 'Lou', suggestions: one, gone: false })).toBe('1 place matches “Lou”. Pick one to see what Google Maps has for it.');
    expect(searchStatus({ searched: 'Lou', suggestions: [...one, ...one], gone: false })).toBe('2 places match “Lou”. Pick one to see what Google Maps has for it.');
    expect(searchStatus({ searched: 'Zzz', suggestions: [], gone: false })).toBe('No places match “Zzz”. Check the spelling, or enter it yourself.');
    expect(searchStatus({ searched: null, suggestions: [], gone: true })).toBe('Google Maps can’t find that place any more. Search again, or enter it yourself.');
  });
});
