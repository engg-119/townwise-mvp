// The confirm card's map on POST /api/places/details, and (D29) the map of every checked place on POST /api/places/map,
// with Google Places over a fake fetch and the map signer on: the answer carries a signed Maps Static URL for the
// browser to load, dark or light as the body's `theme` says (dark without one), the API itself never contacts the Maps
// Static API, and the URL (which holds the static key and a signature) is never stored or logged. Tests never call Google.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_LOCATIONS } from '../src/handlers/locations.ts';
import { createGooglePlacesClient } from '../src/places/google.ts';
import { createStaticMapSigner, staticMapPath } from '../src/places/static-map.ts';
import { fakePlaces, placeDetails, usAddress } from './helpers/places-fetch.ts';
import {
  call, limiterKey, signIn, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SIGNING_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const PLACES_KEY = 'test-places-key';
const STATIC_KEY = 'test-static-key';
// Sentinels: none of them may reach a log.
const PLACE_ID = 'ChIJSentinelPlaceId001';
const NEWER_ID = 'ChIJSentinelPlaceId002';
const ADDRESS = '8 Sentinel Street, Hanover, NH 03755, USA';

const fake = fakePlaces();
const signer = createStaticMapSigner(STATIC_KEY, SIGNING_SECRET);
let server: TownwiseTestServer;
let session: TestSession;
/** Places search on, map off. */
let mapOff: TownwiseTestServer;
/** Map on, Places search off. */
let searchOff: TownwiseTestServer;

beforeAll(async () => {
  // Each start drops the database, so all three start before anyone signs in.
  mapOff = await startTownwiseServer({ places: createGooglePlacesClient(PLACES_KEY, { fetch: fake.fetch, timeoutMs: 200 }) });
  searchOff = await startTownwiseServer({ placesMap: signer });
  server = await startTownwiseServer({
    places: createGooglePlacesClient(PLACES_KEY, { fetch: fake.fetch, timeoutMs: 200 }),
    placesMap: signer,
  });
  session = await signIn(server, `no-org-${randomUUID().slice(0, 8)}@example.test`);
});
afterAll(async () => {
  await server.close();
  await searchOff.close();
  await mapOff.close();
});
beforeEach(async () => {
  fake.reset();
  await server.redis.flushdb();
});

function details(json: unknown): Promise<Response> {
  return call(server, '/api/places/details', { json, session });
}

const hanover = (id: string): unknown => placeDetails(id, ADDRESS, usAddress({ locality: 'Hanover', state: 'NH' }));

describe('details with the map on', () => {
  it('answers a signed Maps Static URL at 640 by 320 beside the place, and Google is called for the details only', async () => {
    fake.script({ kind: 'json', body: hanover(PLACE_ID) });
    const res = await details({ placeId: PLACE_ID, sessionToken: randomUUID() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      place: {
        placeId: PLACE_ID,
        address: ADDRESS,
        town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
        map: { url: signer.mapOf(PLACE_ID, 'dark').url, width: 640, height: 320 },
      },
    });
    expect(fake.calls.map((sent) => new URL(sent.url).origin)).toEqual(['https://places.googleapis.com']);
  });

  it('theme light answers the light map and theme dark the dark one; Google gets the same call either way', async () => {
    fake.script({ kind: 'json', body: hanover(PLACE_ID) }, { kind: 'json', body: hanover(PLACE_ID) });
    for (const theme of ['light', 'dark'] as const) {
      const res = await details({ placeId: PLACE_ID, sessionToken: randomUUID(), theme });
      expect(res.status).toBe(200);
      const body = await res.json() as { place: { map: unknown } };
      expect({ theme, map: body.place.map }).toEqual({ theme, map: signer.mapOf(PLACE_ID, theme) });
    }
    expect(signer.mapOf(PLACE_ID, 'light').url).toContain('markers=color%3A0x136a53%7C');
    expect(fake.calls).toHaveLength(2);
    // The mode never reaches Google: only the place id and the session token do.
    for (const sent of fake.calls) expect(JSON.stringify(sent)).not.toMatch(/light|dark|theme/);
  });

  it('any other theme is 400 invalid_request, and Google is not called', async () => {
    for (const theme of ['Light', 'sepia', '', null, 1]) {
      const res = await details({ placeId: PLACE_ID, sessionToken: randomUUID(), theme });
      expect({ theme, status: res.status, error: (await res.json() as { error?: unknown }).error })
        .toEqual({ theme, status: 400, error: 'invalid_request' });
    }
    expect(fake.calls).toEqual([]);
  });

  it('the map is of Google’s current id for the place, signed with the static key, never the Places key', async () => {
    fake.script({ kind: 'json', body: hanover(NEWER_ID) });
    const body = await (await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).json() as { place: { map: { url: string } } };
    const url = new URL(body.place.map.url);
    expect(url.pathname + url.search).toBe(`${staticMapPath(NEWER_ID, STATIC_KEY, 'dark')}&signature=${String(url.searchParams.get('signature'))}`);
    expect(url.searchParams.get('key')).toBe(STATIC_KEY);
    expect(body.place.map.url).not.toContain(PLACES_KEY);
    expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{27}=$/);
  });

  it('a 404 or a 503 carries no map', async () => {
    fake.script({ kind: 'json', status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } }, { kind: 'network' });
    const missing = await details({ placeId: PLACE_ID, sessionToken: randomUUID() });
    expect({ status: missing.status, body: await missing.json() as unknown }).toMatchObject({ status: 404, body: { error: 'place_not_found' } });
    const failed = await details({ placeId: PLACE_ID, sessionToken: randomUUID() });
    const failedBody = await failed.json() as Record<string, unknown>;
    expect({ status: failed.status, error: failedBody.error }).toEqual({ status: 503, error: 'places_unavailable' });
    expect(JSON.stringify(failedBody)).not.toContain('staticmap');
  });

  it('a details call with a map is still one count on the places limiter', async () => {
    fake.script({ kind: 'json', body: hanover(PLACE_ID) });
    expect((await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).status).toBe(200);
    expect(await server.redis.get(limiterKey('townwise:places', session.userId))).toBe('1');
  });
});

describe('the map is neither stored nor logged', () => {
  it('a details answer with a map writes nothing', async () => {
    fake.script({ kind: 'json', body: hanover(PLACE_ID) });
    const writes = await writesDuring(server, async () => {
      expect((await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).status).toBe(200);
    });
    expect(writes).toEqual([]);
  });

  it('no log line holds the map URL, its key or signature, the place id or the address', async () => {
    server.logs.length = 0;
    fake.script({ kind: 'json', body: hanover(PLACE_ID) }, { kind: 'json', body: hanover(NEWER_ID) }, { kind: 'network' });
    const signatures: string[] = [];
    for (const expected of [200, 200, 503]) {
      const res = await details({ placeId: PLACE_ID, sessionToken: randomUUID() });
      expect(res.status).toBe(expected);
      const body = await res.json() as { place?: { map: { url: string } } };
      if (body.place !== undefined) signatures.push(String(new URL(body.place.map.url).searchParams.get('signature')));
    }
    expect(signatures).toHaveLength(2);
    const logs = server.logs.join('\n');
    expect(logs).toContain('/api/places/details');
    for (const secret of [STATIC_KEY, PLACES_KEY, ...signatures, 'signature', 'staticmap', 'maps.googleapis.com', PLACE_ID, NEWER_ID, 'Sentinel', ADDRESS]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('POST /api/places/map', () => {
  const THIRD_ID = 'ChIJSentinelPlaceId003';

  function map(json: unknown, on: TownwiseTestServer = server, as: TestSession = session): Promise<Response> {
    return call(on, '/api/places/map', { json, session: as });
  }

  async function errorOf(res: Response): Promise<{ status: number; error: unknown }> {
    return { status: res.status, error: (await res.json() as { error?: unknown }).error };
  }

  it('answers a signed map of every id and never calls Google', async () => {
    const ids = [NEWER_ID, PLACE_ID, THIRD_ID];
    const res = await map({ placeIds: ids });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ map: { url: signer.mapOfPlaces(ids, 'dark').url, width: 640, height: 320 } });
    const one = await map({ placeIds: [PLACE_ID] });
    expect(await one.json()).toEqual({ map: signer.mapOf(PLACE_ID, 'dark') });
    // As many ids as an organization may have locations, at the 512-character maximum, fit the 32 KB body and
    // Google's URL cap, in either mode.
    const longest = Array.from({ length: MAX_LOCATIONS }, (_, i) => `${String.fromCharCode(65 + i)}${'a'.repeat(511)}`);
    for (const theme of ['dark', 'light'] as const) {
      const most = await map({ placeIds: longest, theme });
      expect(most.status).toBe(200);
      expect((await most.json() as { map: { url: string } }).map.url).toBe(signer.mapOfPlaces(longest, theme).url);
    }
    expect(fake.calls).toEqual([]);
  });

  it('theme light answers the light map and theme dark the dark one, for one id and for several', async () => {
    const ids = [NEWER_ID, PLACE_ID, THIRD_ID];
    for (const theme of ['light', 'dark'] as const) {
      expect(await (await map({ placeIds: ids, theme })).json()).toEqual({ map: signer.mapOfPlaces(ids, theme) });
      expect(await (await map({ placeIds: [PLACE_ID], theme })).json()).toEqual({ map: signer.mapOf(PLACE_ID, theme) });
    }
    expect(signer.mapOfPlaces(ids, 'light').url).not.toBe(signer.mapOfPlaces(ids, 'dark').url);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an empty list, 26 ids, a duplicate or a malformed id, or another theme, with 400 invalid_request', async () => {
    const many = Array.from({ length: MAX_LOCATIONS + 1 }, (_, i) => `ChIJSentinel${String(i).padStart(4, '0')}`);
    const bad: unknown[] = [
      {}, { placeIds: [] }, { placeIds: many }, { placeIds: [PLACE_ID, NEWER_ID, PLACE_ID] }, { placeIds: ['ChIJshort'] },
      { placeIds: [PLACE_ID, '../../staticmap?x'] }, { placeIds: ['x'.repeat(513)] }, { placeIds: PLACE_ID }, { placeIds: [42] },
      { placeIds: [PLACE_ID], theme: 'Light' }, { placeIds: [PLACE_ID], theme: 'sepia' }, { placeIds: [PLACE_ID], theme: '' },
      { placeIds: [PLACE_ID], theme: null }, { placeIds: [PLACE_ID], theme: ['light'] },
    ];
    for (const json of bad) expect({ json, ...(await errorOf(await map(json))) }).toEqual({ json, status: 400, error: 'invalid_request' });
    expect(await errorOf(await call(server, '/api/places/map', { session, method: 'POST' })))
      .toEqual({ status: 400, error: 'invalid_request' });
    expect(fake.calls).toEqual([]);
  });

  it('answers map null while the map is off', async () => {
    const person = await signIn(mapOff, `no-org-${randomUUID().slice(0, 8)}@example.test`);
    const res = await map({ placeIds: [PLACE_ID, NEWER_ID] }, mapOff, person);
    expect({ status: res.status, body: await res.json() as unknown }).toEqual({ status: 200, body: { map: null } });
    expect(await (await map({ placeIds: [PLACE_ID], theme: 'light' }, mapOff, person)).json()).toEqual({ map: null });
    expect(await errorOf(await map({ placeIds: [] }, mapOff, person))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await map({ placeIds: [PLACE_ID], theme: 'sepia' }, mapOff, person))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('answers while the Places search is off', async () => {
    const person = await signIn(searchOff, `no-org-${randomUUID().slice(0, 8)}@example.test`);
    const res = await map({ placeIds: [PLACE_ID, NEWER_ID] }, searchOff, person);
    expect({ status: res.status, body: await res.json() as unknown })
      .toEqual({ status: 200, body: { map: { url: signer.mapOfPlaces([PLACE_ID, NEWER_ID], 'dark').url, width: 640, height: 320 } } });
    expect(await errorOf(await call(searchOff, '/api/places/autocomplete', { json: { input: 'Lou' }, session: person })))
      .toEqual({ status: 503, error: 'places_unavailable' });
  });

  it('each call counts once on the places limiter, and the 301st in an hour is 429', async () => {
    expect((await map({ placeIds: [PLACE_ID] })).status).toBe(200);
    expect((await map({ placeIds: [PLACE_ID, NEWER_ID] })).status).toBe(200);
    expect(await server.redis.get(limiterKey('townwise:places', session.userId))).toBe('2');
    await server.redis.set(limiterKey('townwise:places', session.userId), '300', 'EX', 3600);
    const res = await map({ placeIds: [PLACE_ID] });
    expect(await errorOf(res)).toEqual({ status: 429, error: 'rate_limited' });
    expect(res.headers.get('retry-after')).not.toBeNull();
  });

  it('writes nothing, and no log line holds an id, the URL, the key or the signature', async () => {
    server.logs.length = 0;
    const signatures: string[] = [];
    const writes = await writesDuring(server, async () => {
      for (const sent of [{ placeIds: [PLACE_ID] }, { placeIds: [PLACE_ID, NEWER_ID, THIRD_ID], theme: 'light' }]) {
        const res = await map(sent);
        expect(res.status).toBe(200);
        const body = await res.json() as { map: { url: string } };
        signatures.push(String(new URL(body.map.url).searchParams.get('signature')));
      }
      expect((await map({ placeIds: [PLACE_ID, PLACE_ID] })).status).toBe(400);
    });
    expect(writes).toEqual([]);
    expect(signatures).toHaveLength(2);
    const logs = server.logs.join('\n');
    expect(logs).toContain('/api/places/map');
    for (const secret of [STATIC_KEY, PLACES_KEY, ...signatures, 'signature', 'staticmap', 'maps.googleapis.com', PLACE_ID, NEWER_ID, THIRD_ID, 'Sentinel']) {
      expect(logs).not.toContain(secret);
    }
  });
});
