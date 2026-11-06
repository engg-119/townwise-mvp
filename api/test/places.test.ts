// The Google Places client (src/places/google.ts) over a fake fetch, and the town an address maps to
// (townOfAddress in src/handlers/places.ts). Tests never call Google.
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
  it('declares both Places routes for any signed-in person, with 2 KB bodies and the shared places limiter', () => {
    const places = TOWNWISE_ROUTES.filter((route) => route.id.startsWith('places.'))
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(places).toEqual([
      { id: 'places.autocomplete', method: 'POST', path: '/places/autocomplete', policy: 'signed_in', bodyLimit: '2kb', limiter: 'places' },
      { id: 'places.details', method: 'POST', path: '/places/details', policy: 'signed_in', bodyLimit: '2kb', limiter: 'places' },
    ]);
  });
});

describe('autocomplete', () => {
  it('posts the input and session token to places:autocomplete for US results in English, with no type filter', async () => {
    fake.script({ kind: 'json', body: {} });
    await client.autocomplete('Lou’s Rest', TOKEN);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': KEY });
    // toEqual on the whole body: nothing else is sent, includedPrimaryTypes included.
    expect(call?.body).toEqual({ input: 'Lou’s Rest', sessionToken: TOKEN, includedRegionCodes: ['us'], languageCode: 'en' });
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps place predictions only, at most five in Google’s order, as name and detail', async () => {
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
      { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', detail: 'South Main Street, Hanover, NH, USA' },
      { placeId: 'ChIJTestPlace0002', name: 'Molly’s', detail: 'Hanover, NH, USA' },
      { placeId: 'ChIJTestPlace0003', name: 'No Secondary Text', detail: '' },
      { placeId: 'ChIJTestPlace0004', name: 'Four', detail: 'Ithaca, NY, USA' },
      { placeId: 'ChIJTestPlace0005', name: 'Five', detail: 'Stowe, VT, USA' },
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

describe('failures', () => {
  const both: [string, () => Promise<unknown>][] = [
    ['autocomplete', () => client.autocomplete('lou', TOKEN)],
    ['details', () => client.details(PLACE_ID, TOKEN)],
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
