// The Places proxy routes with Google Places on, over a fake fetch (helpers/places-fetch.ts): who may call them, the
// shared limiter, validation, the answers and Google's failure modes, and that nothing is stored or logged. Tests never
// call Google.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createGooglePlacesClient } from '../src/places/google.ts';
import { addSeat, createOrg } from './helpers/fixtures.ts';
import { fakePlaces, placeDetails, placePrediction, queryPrediction, usAddress } from './helpers/places-fetch.ts';
import {
  call, limiterKey, logLines, signIn, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const KEY = 'test-places-key';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Sentinels: none of them may reach a log.
const INPUT = 'Sentinel Typed Diner';
const PLACE_ID = 'ChIJSentinelPlaceId001';
const ADDRESS = '8 Sentinel Street, Hanover, NH 03755, USA';
const NAME = 'Sentinel Diner';

const fake = fakePlaces();
let server: TownwiseTestServer;
let session: TestSession;

beforeAll(async () => {
  server = await startTownwiseServer({ places: createGooglePlacesClient(KEY, { fetch: fake.fetch, timeoutMs: 200 }) });
  session = await signIn(server, `no-org-${randomUUID().slice(0, 8)}@example.test`);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  fake.reset();
  await server.redis.flushdb();
});

/** `as` null sends no session. */
function autocomplete(json: unknown, as: TestSession | null = session): Promise<Response> {
  return call(server, '/api/places/autocomplete', { json, ...(as === null ? {} : { session: as }) });
}

function details(json: unknown, as: TestSession | null = session): Promise<Response> {
  return call(server, '/api/places/details', { json, ...(as === null ? {} : { session: as }) });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

describe('autocomplete', () => {
  it('a signed-in person with no organization gets place suggestions, and the session token is echoed', async () => {
    const sessionToken = randomUUID();
    fake.script({ kind: 'json', body: { suggestions: [queryPrediction('diners'), placePrediction(PLACE_ID, NAME, 'Hanover, NH, USA')] } });
    const res = await autocomplete({ input: `  ${INPUT}  `, sessionToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [{ placeId: PLACE_ID, name: NAME, detail: 'Hanover, NH, USA' }], sessionToken });
    expect(fake.calls.map((sent) => sent.body)).toEqual([{ input: INPUT, sessionToken, includedRegionCodes: ['us'], languageCode: 'en' }]);
  });

  it('without a session token the server makes a version 4 UUID, sends it to Google and returns it', async () => {
    fake.script({ kind: 'json', body: {} });
    const res = await autocomplete({ input: 'Lou' });
    const body = await res.json() as { suggestions: unknown[]; sessionToken: string };
    expect(res.status).toBe(200);
    expect(body.suggestions).toEqual([]);
    expect(body.sessionToken).toMatch(UUID_V4);
    expect(fake.calls[0]?.body).toMatchObject({ sessionToken: body.sessionToken });
  });

  it('a member may call it too', async () => {
    const email = `member-${randomUUID().slice(0, 8)}@example.test`;
    const member = await signIn(server, email);
    await addSeat(server, { orgId: await createOrg(server, { name: 'Member Diner' }), userId: member.userId, email });
    fake.script({ kind: 'json', body: {} });
    expect((await autocomplete({ input: 'Lou' }, member)).status).toBe(200);
  });
});

describe('details', () => {
  it('answers the place with its address and its researched town, as a TownInput', async () => {
    const sessionToken = randomUUID();
    fake.script({ kind: 'json', body: placeDetails(PLACE_ID, ADDRESS, usAddress({ locality: 'Hanover', state: 'NH' })) });
    const res = await details({ placeId: PLACE_ID, sessionToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      place: { placeId: PLACE_ID, address: ADDRESS, town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } },
    });
    expect(fake.calls[0]?.url).toBe(`https://places.googleapis.com/v1/places/${PLACE_ID}?sessionToken=${sessionToken}`);
  });

  it('another US town has townId null; no usable town is town: null', async () => {
    fake.script(
      { kind: 'json', body: placeDetails(PLACE_ID, 'Norwich, VT, USA', usAddress({ locality: 'Norwich', state: 'VT' })) },
      { kind: 'json', body: placeDetails(PLACE_ID, 'San Juan, Puerto Rico', usAddress({ locality: 'San Juan', state: 'San Juan', country: 'PR' })) },
    );
    expect(await (await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).json())
      .toEqual({ place: { placeId: PLACE_ID, address: 'Norwich, VT, USA', town: { townId: null, name: 'Norwich', state: 'VT' } } });
    expect(await (await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).json())
      .toEqual({ place: { placeId: PLACE_ID, address: 'San Juan, Puerto Rico', town: null } });
  });

  it('Google’s 404, or 400 INVALID_ARGUMENT on the id, is 404 place_not_found', async () => {
    fake.script(
      { kind: 'json', status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } },
      { kind: 'json', status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } },
    );
    for (let i = 0; i < 2; i += 1) {
      expect(await errorOf(await details({ placeId: PLACE_ID, sessionToken: randomUUID() }))).toEqual({ status: 404, error: 'place_not_found' });
    }
  });
});

describe('who may call them', () => {
  it('both need a session: 401 unauthenticated, and Google is not called', async () => {
    expect(await errorOf(await autocomplete({ input: 'Lou' }, null))).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await errorOf(await details({ placeId: PLACE_ID, sessionToken: randomUUID() }, null))).toEqual({ status: 401, error: 'unauthenticated' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('validation: 400 invalid_request, and Google is not called', () => {
  it('autocomplete: input 2 to 120 characters after trimming, and an optional version 4 UUID', async () => {
    const bad: unknown[] = [
      {}, { input: '' }, { input: ' a ' }, { input: 'x'.repeat(121) }, { input: 42 }, { input: ['Lou'] },
      { input: 'Lou', sessionToken: 'not-a-uuid' }, { input: 'Lou', sessionToken: '00000000-0000-1000-8000-000000000000' },
      { input: 'Lou', sessionToken: null },
    ];
    for (const json of bad) expect({ json, ...(await errorOf(await autocomplete(json))) }).toEqual({ json, status: 400, error: 'invalid_request' });
    fake.script({ kind: 'json', body: {} }, { kind: 'json', body: {} });
    expect((await autocomplete({ input: `  ${'x'.repeat(120)}  ` })).status).toBe(200);
    expect((await autocomplete({ input: 'Lo', sessionToken: randomUUID().toUpperCase() })).status).toBe(200);
    expect(fake.calls).toHaveLength(2);
  });

  it('details: a place id of 10 to 300 letters, digits, _ or -, and a required version 4 UUID', async () => {
    const sessionToken = randomUUID();
    const bad: unknown[] = [
      {}, { placeId: PLACE_ID }, { sessionToken }, { placeId: 'ChIJshort', sessionToken }, { placeId: 'x'.repeat(301), sessionToken },
      { placeId: '../../places/ChIJabc', sessionToken }, { placeId: 'ChIJ abcdefgh', sessionToken }, { placeId: 'ChIJabcdefgh?x=1', sessionToken },
      { placeId: PLACE_ID, sessionToken: 'not-a-uuid' },
    ];
    for (const json of bad) expect({ json, ...(await errorOf(await details(json))) }).toEqual({ json, status: 400, error: 'invalid_request' });
    expect(fake.calls).toHaveLength(0);
  });

  it('a body over 2 KB is 413', async () => {
    const res = await call(server, '/api/places/autocomplete', { session, rawBody: JSON.stringify({ input: 'Lou', pad: 'x'.repeat(3000) }) });
    expect(await errorOf(res)).toEqual({ status: 413, error: 'payload_too_large' });
  });
});

describe('Google’s failures answer 503 places_unavailable', () => {
  it('a non-2xx answer, a refused connection, or no answer within the time limit', async () => {
    fake.script({ kind: 'json', status: 500, body: {} }, { kind: 'network' }, { kind: 'hang' });
    for (let i = 0; i < 3; i += 1) expect(await errorOf(await autocomplete({ input: 'Lou' }))).toEqual({ status: 503, error: 'places_unavailable' });
    fake.script({ kind: 'json', status: 403, body: {} }, { kind: 'network' }, { kind: 'hang' });
    for (let i = 0; i < 3; i += 1) {
      expect(await errorOf(await details({ placeId: PLACE_ID, sessionToken: randomUUID() }))).toEqual({ status: 503, error: 'places_unavailable' });
    }
    expect(fake.calls).toHaveLength(6);
    const failed = logLines(server).filter((line) => line.msg === 'townwise.places_failed').slice(-6)
      .map(({ routeId, code, status, errType }) => ({ routeId, code, status, errType }));
    expect(failed).toEqual([
      { routeId: 'places.autocomplete', code: 'upstream_status', status: 500, errType: null },
      { routeId: 'places.autocomplete', code: 'network', status: null, errType: 'TypeError' },
      { routeId: 'places.autocomplete', code: 'timeout', status: null, errType: null },
      { routeId: 'places.details', code: 'upstream_status', status: 403, errType: null },
      { routeId: 'places.details', code: 'network', status: null, errType: 'TypeError' },
      { routeId: 'places.details', code: 'timeout', status: null, errType: null },
    ]);
  });
});

describe('the places limiter', () => {
  it('both routes share one per-account count', async () => {
    fake.script({ kind: 'json', body: {} }, { kind: 'json', status: 404, body: {} });
    await autocomplete({ input: 'Lou' });
    await details({ placeId: PLACE_ID, sessionToken: randomUUID() });
    expect(await server.redis.get(limiterKey('townwise:places', session.userId))).toBe('2');
  });

  it('the 301st call in an hour is 429 rate_limited on either route, and Google is not called', async () => {
    await server.redis.set(limiterKey('townwise:places', session.userId), '300', 'EX', 3600);
    for (const res of [await autocomplete({ input: 'Lou' }), await details({ placeId: PLACE_ID, sessionToken: randomUUID() })]) {
      expect(await errorOf(res)).toEqual({ status: 429, error: 'rate_limited' });
      expect(res.headers.get('retry-after')).not.toBeNull();
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('nothing is stored or logged', () => {
  it('neither route writes to the database', async () => {
    fake.script(
      { kind: 'json', body: { suggestions: [placePrediction(PLACE_ID, NAME, 'Hanover, NH, USA')] } },
      { kind: 'json', body: placeDetails(PLACE_ID, ADDRESS, usAddress({ locality: 'Hanover', state: 'NH' })) },
    );
    const writes = await writesDuring(server, async () => {
      expect((await autocomplete({ input: INPUT })).status).toBe(200);
      expect((await details({ placeId: PLACE_ID, sessionToken: randomUUID() })).status).toBe(200);
    });
    expect(writes).toEqual([]);
  });

  it('no log line holds the typed text, a place id, an address, a name, the session token or the key, whatever Google answers', async () => {
    server.logs.length = 0;
    const sessionToken = randomUUID();
    const answer = placeDetails(PLACE_ID, ADDRESS, usAddress({ locality: 'Hanover', state: 'NH' }));
    fake.script(
      { kind: 'json', body: { suggestions: [placePrediction(PLACE_ID, NAME, ADDRESS)] } },
      { kind: 'json', body: answer },
      { kind: 'json', status: 500, body: { error: { message: `${INPUT} ${PLACE_ID}` } } },
      { kind: 'text', status: 200, body: `{"broken": "${ADDRESS}` },
      { kind: 'network' },
      { kind: 'hang' },
    );
    expect((await autocomplete({ input: INPUT, sessionToken })).status).toBe(200);
    expect((await details({ placeId: PLACE_ID, sessionToken })).status).toBe(200);
    expect((await autocomplete({ input: INPUT, sessionToken })).status).toBe(503);
    expect((await details({ placeId: PLACE_ID, sessionToken })).status).toBe(503);
    expect((await autocomplete({ input: INPUT, sessionToken })).status).toBe(503);
    expect((await details({ placeId: PLACE_ID, sessionToken })).status).toBe(503);
    expect(await errorOf(await autocomplete({ input: INPUT, sessionToken: 'bad' }))).toEqual({ status: 400, error: 'invalid_request' });

    const logs = server.logs.join('\n');
    expect(logs).toContain('townwise.places_failed');
    for (const secret of [INPUT, 'Sentinel', PLACE_ID, ADDRESS, NAME, sessionToken, KEY]) expect(logs).not.toContain(secret);
  });
});
