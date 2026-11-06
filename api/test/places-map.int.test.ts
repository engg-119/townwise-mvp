// The confirm card's map on POST /api/places/details, with Google Places over a fake fetch and the map signer on:
// the answer carries a signed Maps Static URL for the browser to load, the API itself never contacts the Maps Static
// API, and the URL (which holds the static key and a signature) is never stored or logged. Tests never call Google.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createGooglePlacesClient } from '../src/places/google.ts';
import { createStaticMapSigner, staticMapPath } from '../src/places/static-map.ts';
import { fakePlaces, placeDetails, usAddress } from './helpers/places-fetch.ts';
import {
  call, limiterKey, signIn, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const PLACES_KEY = 'test-places-key';
const STATIC_KEY = 'test-static-key';
// Sentinels: none of them may reach a log.
const PLACE_ID = 'ChIJSentinelPlaceId001';
const NEWER_ID = 'ChIJSentinelPlaceId002';
const ADDRESS = '8 Sentinel Street, Hanover, NH 03755, USA';

const fake = fakePlaces();
const signer = createStaticMapSigner(STATIC_KEY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
let server: TownwiseTestServer;
let session: TestSession;

beforeAll(async () => {
  server = await startTownwiseServer({
    places: createGooglePlacesClient(PLACES_KEY, { fetch: fake.fetch, timeoutMs: 200 }),
    placesMap: signer,
  });
  session = await signIn(server, `no-org-${randomUUID().slice(0, 8)}@example.test`);
});
afterAll(async () => { await server.close(); });
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
        map: { url: signer.mapOf(PLACE_ID).url, width: 640, height: 320 },
      },
    });
    expect(fake.calls.map((sent) => new URL(sent.url).origin)).toEqual(['https://places.googleapis.com']);
  });

  it('the map is of Google’s current id for the place, signed with the static key, never the Places key', async () => {
    fake.script({ kind: 'json', body: hanover(NEWER_ID) });
    const body = await (await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).json() as { place: { map: { url: string } } };
    const url = new URL(body.place.map.url);
    expect(url.pathname + url.search).toBe(`${staticMapPath(NEWER_ID, STATIC_KEY)}&signature=${String(url.searchParams.get('signature'))}`);
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
