// The Google Places client (src/places/google.ts) over a fake fetch, and the town an address maps to
// (townOfAddress in src/handlers/places.ts), with D66's nearby and profile. Tests never call Google.
import { beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import { townOfAddress } from '../src/handlers/places.ts';
import { createGooglePlacesClient, PlacesUnavailableError, type PlacesClient } from '../src/places/google.ts';
import { resolveTown, townInputSchema } from '../src/towns.ts';
import { component, fakePlaces, placeDetails, placePrediction, queryPrediction, usAddress } from './helpers/places-fetch.ts';

const KEY = 'test-places-key';
const TOKEN = '00000000-0000-4000-8000-000000000000';
const PLACE_ID = 'ChIJTestPlace0001';

const fake = fakePlaces();
let client: PlacesClient;

beforeEach(() => {
  fake.reset();
  client = createGooglePlacesClient(KEY, { fetch: fake.fetch, timeoutMs: 50 });
});

async function failureOf(run: () => Promise<unknown>): Promise<PlacesUnavailableError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PlacesUnavailableError) return err;
    throw err;
  }
  throw new Error('expected a PlacesUnavailableError');
}

describe('the route table', () => {
  it('declares the Places routes for any signed-in person, with the shared places limiter: 2 KB bodies, and 32 KB for the map (D29)', () => {
    const places = TOWNWISE_ROUTES.filter((route) => route.id.startsWith('places.'))
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(places).toEqual([
      { id: 'places.autocomplete', method: 'POST', path: '/places/autocomplete', policy: 'signed_in', bodyLimit: '2kb', limiter: 'places' },
      { id: 'places.details', method: 'POST', path: '/places/details', policy: 'signed_in', bodyLimit: '2kb', limiter: 'places' },
      { id: 'places.map', method: 'POST', path: '/places/map', policy: 'signed_in', bodyLimit: '32kb', limiter: 'places' },
    ]);
  });
});

describe('autocomplete', () => {
  it('autocomplete asks Google with US results, English and a location bias over the Northeast', async () => {
    fake.script({ kind: 'json', body: {} });
    await client.autocomplete('Lou’s Rest', TOKEN);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': KEY });
    // toEqual on the whole body: nothing else is sent, includedPrimaryTypes and locationRestriction included. The
    // rectangle replaces Google's IP biasing toward the API's data center (D29).
    expect(call?.body).toEqual({
      input: 'Lou’s Rest', sessionToken: TOKEN, includedRegionCodes: ['us'], languageCode: 'en',
      locationBias: { rectangle: { low: { latitude: 40.4, longitude: -80.6 }, high: { latitude: 47.5, longitude: -66.9 } } },
    });
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps place predictions only, at most five in Google’s order, as name, detail and kind', async () => {
    fake.script({
      kind: 'json',
      body: {
        suggestions: [
          queryPrediction('restaurants near Hanover'),
          placePrediction('ChIJTestPlace0001', 'Lou’s Restaurant', 'South Main Street, Hanover, NH, USA'),
          placePrediction('ChIJTestPlace0002', 'Molly’s', 'Hanover, NH, USA'),
          placePrediction('ChIJTestPlace0003', 'No Secondary Text'),
          queryPrediction('lou’s menu'),
          placePrediction('short', 'Bad Id'),
          placePrediction('ChIJTestPlace0004', 'Four', 'Ithaca, NY, USA'),
          placePrediction('ChIJTestPlace0005', 'Five', 'Stowe, VT, USA'),
          placePrediction('ChIJTestPlace0006', 'Six', 'Amherst, MA, USA'),
        ],
      },
    });
    expect(await client.autocomplete('lou', TOKEN)).toEqual([
      { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', detail: 'South Main Street, Hanover, NH, USA', kind: 'business' },
      { placeId: 'ChIJTestPlace0002', name: 'Molly’s', detail: 'Hanover, NH, USA', kind: 'business' },
      { placeId: 'ChIJTestPlace0003', name: 'No Secondary Text', detail: '', kind: 'business' },
      { placeId: 'ChIJTestPlace0004', name: 'Four', detail: 'Ithaca, NY, USA', kind: 'business' },
      { placeId: 'ChIJTestPlace0005', name: 'Five', detail: 'Stowe, VT, USA', kind: 'business' },
    ]);
  });

  it('a prediction with establishment is a business, with street_address or premise an address', async () => {
    fake.script({
      kind: 'json',
      body: {
        suggestions: [
          placePrediction('ChIJTestPlace0001', 'Lou’s Restaurant', 'South Main Street, Hanover, NH, USA', ['establishment']),
          placePrediction('ChIJTestPlace0002', 'Town Hall', 'Hanover, NH, USA', ['point_of_interest']),
          placePrediction('ChIJTestPlace0003', '12 South Main Street', 'Hanover, NH, USA', ['street_address', 'geocode']),
          placePrediction('ChIJTestPlace0004', 'The Nugget Building', 'Hanover, NH, USA', ['premise', 'geocode']),
          placePrediction('ChIJTestPlace0005', '12 South Main Street Unit 2', 'Hanover, NH, USA', ['subpremise', 'geocode']),
        ],
      },
    });
    expect((await client.autocomplete('12 south main', TOKEN)).map(({ placeId, kind }) => ({ placeId, kind }))).toEqual([
      { placeId: 'ChIJTestPlace0001', kind: 'business' },
      { placeId: 'ChIJTestPlace0002', kind: 'business' },
      { placeId: 'ChIJTestPlace0003', kind: 'address' },
      { placeId: 'ChIJTestPlace0004', kind: 'address' },
      { placeId: 'ChIJTestPlace0005', kind: 'address' },
    ]);
  });

  it('a locality, route or postal code prediction is skipped', async () => {
    fake.script({
      kind: 'json',
      body: {
        suggestions: [
          placePrediction('ChIJTestPlace0001', 'Hanover', 'NH, USA', ['locality', 'political', 'geocode']),
          placePrediction('ChIJTestPlace0002', 'South Main Street', 'Hanover, NH, USA', ['route', 'geocode']),
          placePrediction('ChIJTestPlace0003', '03755', 'Hanover, NH, USA', ['postal_code', 'geocode']),
          placePrediction('ChIJTestPlace0004', 'Grafton County', 'NH, USA', ['administrative_area_level_2', 'political', 'geocode']),
          placePrediction('ChIJTestPlace0005', 'Lou’s Restaurant', 'South Main Street, Hanover, NH, USA'),
        ],
      },
    });
    expect(await client.autocomplete('hanover', TOKEN)).toEqual([
      { placeId: 'ChIJTestPlace0005', name: 'Lou’s Restaurant', detail: 'South Main Street, Hanover, NH, USA', kind: 'business' },
    ]);
  });

  it('a prediction without types is a business', async () => {
    fake.script({
      kind: 'json',
      body: {
        suggestions: [
          placePrediction('ChIJTestPlace0001', 'Lou’s Restaurant', 'Hanover, NH, USA', null),
          placePrediction('ChIJTestPlace0002', 'Molly’s', 'Hanover, NH, USA', []),
        ],
      },
    });
    expect((await client.autocomplete('lou', TOKEN)).map(({ placeId, kind }) => ({ placeId, kind }))).toEqual([
      { placeId: 'ChIJTestPlace0001', kind: 'business' },
      { placeId: 'ChIJTestPlace0002', kind: 'business' },
    ]);
  });

  it('answers no suggestions for Google’s empty object', async () => {
    fake.script({ kind: 'json', body: {} });
    expect(await client.autocomplete('zzzz', TOKEN)).toEqual([]);
  });
});

describe('details', () => {
  it('gets the place with the session token and the Essentials field mask', async () => {
    fake.script({ kind: 'json', body: placeDetails(PLACE_ID, '8 S Main St, Hanover, NH 03755, USA', usAddress({ locality: 'Hanover', state: 'NH' })) });
    const place = await client.details(PLACE_ID, TOKEN);
    const call = fake.calls[0];
    expect(call?.url).toBe(`https://places.googleapis.com/v1/places/${PLACE_ID}?sessionToken=${TOKEN}`);
    expect(call?.method).toBe('GET');
    expect(call?.headers).toEqual({ 'x-goog-api-key': KEY, 'x-goog-fieldmask': 'id,formattedAddress,addressComponents' });
    expect(call?.body).toBeUndefined();
    expect(place).toMatchObject({ placeId: PLACE_ID, formattedAddress: '8 S Main St, Hanover, NH 03755, USA' });
    expect(place?.addressComponents).toContainEqual(component('Hanover', 'Hanover', 'locality', 'political'));
  });

  it('takes Google’s id when it answers with a newer one, and keeps the requested id when Google’s is missing', async () => {
    fake.script(
      { kind: 'json', body: placeDetails('ChIJNewerPlaceId01', '', []) },
      { kind: 'json', body: { formattedAddress: 'Somewhere' } },
    );
    expect((await client.details(PLACE_ID, TOKEN))?.placeId).toBe('ChIJNewerPlaceId01');
    expect(await client.details(PLACE_ID, TOKEN)).toEqual({ placeId: PLACE_ID, formattedAddress: 'Somewhere', addressComponents: [] });
  });

  it('answers null for Google’s 404 and for 400 INVALID_ARGUMENT on the id', async () => {
    fake.script(
      { kind: 'json', status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } },
      { kind: 'json', status: 400, body: { error: { code: 400, message: 'Not a valid Place ID: x', status: 'INVALID_ARGUMENT' } } },
    );
    expect(await client.details(PLACE_ID, TOKEN)).toBeNull();
    expect(await client.details(PLACE_ID, TOKEN)).toBeNull();
  });

  it('treats a 400 for a bad API key, or any other 400, as unavailable rather than an unknown place', async () => {
    fake.script(
      {
        kind: 'json', status: 400,
        body: { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } },
      },
      { kind: 'json', status: 400, body: { error: { code: 400, message: 'Precondition', status: 'FAILED_PRECONDITION' } } },
    );
    expect(await failureOf(() => client.details(PLACE_ID, TOKEN))).toMatchObject({ code: 'upstream_status', status: 400 });
    expect(await failureOf(() => client.details(PLACE_ID, TOKEN))).toMatchObject({ code: 'upstream_status', status: 400 });
  });
});

describe('nearby (D66)', () => {
  const CENTER = { lat: 43.7, lng: -72.29 };
  const place = (id: string, name: string, extra: Record<string, unknown> = {}): unknown => ({
    id, displayName: { text: name, languageCode: 'en' }, primaryType: 'american_restaurant', location: { latitude: 43.701, longitude: -72.289 }, ...extra,
  });

  it('asks for food and drink places by distance around the point, at most 20, with the field mask and no website', async () => {
    fake.script({ kind: 'json', body: {} });
    expect(await client.nearby(CENTER, { radiusM: 1500, withWebsite: false })).toEqual([]);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://places.googleapis.com/v1/places:searchNearby');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({
      'content-type': 'application/json', 'x-goog-api-key': KEY, 'x-goog-fieldmask': 'places.id,places.displayName,places.primaryType,places.location',
    });
    expect(call?.body).toEqual({
      includedTypes: ['restaurant', 'bar', 'cafe', 'coffee_shop', 'pub', 'bakery', 'fast_food_restaurant'], maxResultCount: 20,
      rankPreference: 'DISTANCE', languageCode: 'en', locationRestriction: { circle: { center: { latitude: 43.7, longitude: -72.29 }, radius: 1500 } },
    });
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('adds the website to the field mask only for a research run, and keeps an http(s) website only then', async () => {
    const body = { places: [place('ChIJTestPlace0001', 'Fixture Diner', { websiteUri: 'https://diner.example.com/' }), place('ChIJTestPlace0002', 'Fixture Pub', { websiteUri: 'javascript:alert(1)' })] };
    fake.script({ kind: 'json', body }, { kind: 'json', body });
    const withSite = await client.nearby(CENTER, { radiusM: 1500, withWebsite: true });
    expect(fake.calls[0]?.headers['x-goog-fieldmask']).toBe('places.id,places.displayName,places.primaryType,places.location,places.websiteUri');
    expect(withSite.map((each) => each.website)).toEqual(['https://diner.example.com/', null]);
    const without = await client.nearby(CENTER, { radiusM: 1500, withWebsite: false });
    expect(without.map((each) => each.website)).toEqual([null, null]);
  });

  it('answers each place as id, name, primary type and point, skipping one without an id, a name or a point', async () => {
    fake.script({
      kind: 'json',
      body: {
        places: [
          place('ChIJTestPlace0001', 'Fixture Diner'),
          place('ChIJTestPlace0002', 'No Type', { primaryType: undefined }),
          place('short', 'Bad Id'),
          place('ChIJTestPlace0003', ''),
          { id: 'ChIJTestPlace0004', displayName: { text: 'No Point' } },
          'not a place',
        ],
      },
    });
    expect(await client.nearby(CENTER, { radiusM: 1500, withWebsite: false })).toEqual([
      { placeId: 'ChIJTestPlace0001', name: 'Fixture Diner', primaryType: 'american_restaurant', lat: 43.701, lng: -72.289, website: null },
      { placeId: 'ChIJTestPlace0002', name: 'No Type', primaryType: null, lat: 43.701, lng: -72.289, website: null },
    ]);
  });

  it('a 2xx answer with the wrong shape is bad_response', async () => {
    fake.script({ kind: 'json', body: { places: 'not a list' } });
    expect(await failureOf(() => client.nearby(CENTER, { radiusM: 1500, withWebsite: false }))).toMatchObject({ code: 'bad_response' });
  });
});

describe('profile (D66)', () => {
  it('gets the place’s id, name and address with no session', async () => {
    fake.script({ kind: 'json', body: { id: PLACE_ID, displayName: { text: 'Fixture Google Bistro', languageCode: 'en' }, formattedAddress: '1 Fixture Lane, Hanover, NH' } });
    expect(await client.profile(PLACE_ID)).toEqual({ placeId: PLACE_ID, name: 'Fixture Google Bistro', address: '1 Fixture Lane, Hanover, NH' });
    const call = fake.calls[0];
    expect(call?.url).toBe(`https://places.googleapis.com/v1/places/${PLACE_ID}`);
    expect(call?.method).toBe('GET');
    expect(call?.headers).toEqual({ 'x-goog-api-key': KEY, 'x-goog-fieldmask': 'id,displayName,formattedAddress' });
    expect(call?.body).toBeUndefined();
  });

  it('answers null for Google’s 404, a 400 on the id, and a place with no name', async () => {
    fake.script(
      { kind: 'json', status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } },
      { kind: 'json', status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } },
      { kind: 'json', body: { id: PLACE_ID, formattedAddress: 'Somewhere' } },
    );
    expect(await client.profile(PLACE_ID)).toBeNull();
    expect(await client.profile(PLACE_ID)).toBeNull();
    expect(await client.profile(PLACE_ID)).toBeNull();
  });

  it('treats a 400 for a bad API key as unavailable', async () => {
    fake.script({ kind: 'json', status: 400, body: { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } });
    expect(await failureOf(() => client.profile(PLACE_ID))).toMatchObject({ code: 'upstream_status', status: 400 });
  });
});

describe('failures', () => {
  const both: [string, () => Promise<unknown>][] = [
    ['autocomplete', () => client.autocomplete('lou', TOKEN)],
    ['details', () => client.details(PLACE_ID, TOKEN)],
    ['nearby', () => client.nearby({ lat: 43.7, lng: -72.29 }, { radiusM: 1500, withWebsite: true })],
    ['profile', () => client.profile(PLACE_ID)],
  ];

  it.each(both)('%s: a non-2xx answer is upstream_status with Google’s status, and the error carries none of its body', async (_name, run) => {
    for (const status of [403, 429, 500, 503]) {
      fake.script({ kind: 'json', status, body: { error: { message: 'Sentinel Google Body' } } });
      const err = await failureOf(run);
      expect(err).toMatchObject({ code: 'upstream_status', status, errType: null });
      expect(`${err.message} ${String(err.stack)}`).not.toContain('Sentinel');
    }
  });

  it.each(both)('%s: a refused connection is network, with the error class only', async (_name, run) => {
    fake.script({ kind: 'network' });
    expect(await failureOf(run)).toMatchObject({ code: 'network', status: null, errType: 'TypeError' });
  });

  it.each(both)('%s: no answer within the time limit is timeout, and the request was aborted', async (_name, run) => {
    fake.script({ kind: 'hang' });
    expect(await failureOf(run)).toMatchObject({ code: 'timeout' });
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
  });

  it.each(both)('%s: a 2xx answer that is not JSON is bad_response, without the body', async (_name, run) => {
    fake.script({ kind: 'text', status: 200, body: '<html>Sentinel Proxy Page</html>' });
    const err = await failureOf(run);
    expect(err).toMatchObject({ code: 'bad_response' });
    expect(`${err.message} ${String(err.stack)}`).not.toContain('Sentinel');
  });

  it('autocomplete: a 2xx answer with the wrong shape is bad_response', async () => {
    fake.script({ kind: 'json', body: { suggestions: 'not a list' } });
    expect(await failureOf(() => client.autocomplete('lou', TOKEN))).toMatchObject({ code: 'bad_response' });
  });
});

describe('townOfAddress', () => {
  it('matches a researched town by locality and state, ignoring case, with the town’s own name', () => {
    expect(townOfAddress(usAddress({ locality: 'Hanover', state: 'NH' }))).toEqual({ townId: 'hanover-nh', name: 'Hanover', state: 'NH' });
    expect(townOfAddress(usAddress({ locality: 'STATE COLLEGE', state: 'pa' }))).toEqual({ townId: 'state-college-pa', name: 'State College', state: 'PA' });
  });

  it('matches a researched town by administrative_area_level_3, preferred over a plain locality', () => {
    // Etna is a village in the town of Hanover.
    expect(townOfAddress(usAddress({ locality: 'Etna', adminLevel3: 'Hanover', state: 'NH' }))).toEqual({ townId: 'hanover-nh', name: 'Hanover', state: 'NH' });
  });

  it('maps the aliases: Lake Placid, NY to North Elba and North Conway, NH to Conway', () => {
    expect(townOfAddress(usAddress({ locality: 'Lake Placid', state: 'NY' }))).toEqual({ townId: 'north-elba-ny', name: 'North Elba', state: 'NY' });
    expect(townOfAddress(usAddress({ locality: 'north conway', state: 'NH' }))).toEqual({ townId: 'conway-nh', name: 'Conway', state: 'NH' });
  });

  it('a researched name or alias in another state is another town', () => {
    expect(townOfAddress(usAddress({ locality: 'Amherst', state: 'NY' }))).toEqual({ townId: null, name: 'Amherst', state: 'NY' });
    expect(townOfAddress(usAddress({ locality: 'Lake Placid', state: 'FL' }))).toEqual({ townId: null, name: 'Lake Placid', state: 'FL' });
  });

  it('another town takes the locality, else postal_town, else sublocality, else administrative_area_level_3', () => {
    expect(townOfAddress(usAddress({ sublocality: 'Brooklyn', locality: 'Norwich', adminLevel3: 'Norwich Town', state: 'VT' })))
      .toEqual({ townId: null, name: 'Norwich', state: 'VT' });
    expect(townOfAddress(usAddress({ postalTown: 'Lebanon', sublocality: 'West Lebanon', state: 'NH' }))).toEqual({ townId: null, name: 'Lebanon', state: 'NH' });
    expect(townOfAddress(usAddress({ sublocality: 'Brooklyn', adminLevel3: 'Kings', state: 'NY' }))).toEqual({ townId: null, name: 'Brooklyn', state: 'NY' });
    expect(townOfAddress(usAddress({ adminLevel3: 'Hartford', state: 'VT' }))).toEqual({ townId: null, name: 'Hartford', state: 'VT' });
  });

  it('is null without a usable town name', () => {
    expect(townOfAddress(usAddress({ state: 'NH' }))).toBeNull();
    expect(townOfAddress(usAddress({ locality: '   ', state: 'NH' }))).toBeNull();
    expect(townOfAddress(usAddress({ locality: 'x'.repeat(81), state: 'NH' }))).toBeNull();
    expect(townOfAddress([])).toBeNull();
  });

  it('is null without a state in US_STATE_CODES, or outside the US (territories have their own country code)', () => {
    expect(townOfAddress(usAddress({ locality: 'Hanover' }))).toBeNull();
    expect(townOfAddress(usAddress({ locality: 'Hanover', state: 'XX' }))).toBeNull();
    expect(townOfAddress(usAddress({ locality: 'San Juan', state: 'San Juan', country: 'PR' }))).toBeNull();
    expect(townOfAddress(usAddress({ locality: 'San Juan', state: 'PR', country: 'US' }))).toBeNull();
    // Western Australia's code is also Washington's.
    expect(townOfAddress(usAddress({ locality: 'Perth', state: 'WA', country: 'AU' }))).toBeNull();
    expect(townOfAddress(usAddress({ locality: 'Washington', state: 'DC' }))).toEqual({ townId: null, name: 'Washington', state: 'DC' });
  });

  it('every town it answers is a TownInput an access request accepts unchanged, resolving to itself', () => {
    const addresses = [
      usAddress({ locality: 'Hanover', state: 'NH' }), usAddress({ locality: 'Lake Placid', state: 'NY' }),
      usAddress({ locality: 'Norwich', state: 'VT' }), usAddress({ locality: 'x'.repeat(80), state: 'WY' }),
    ];
    for (const address of addresses) {
      const town = townOfAddress(address);
      const parsed = townInputSchema.safeParse(town);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(resolveTown(parsed.data)).toEqual(town);
    }
  });
});
