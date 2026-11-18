// GET /api/org/locations/map (D47, Settings' map hover): the lettered map of the caller's own locations with where
// each pin sits. Google Places over a fake fetch; the map signer on. Pins come only from the caller's organization, each
// place's point is asked of Google once and then kept in Valkey under 30 days, and without every point the answer is
// Google's own fit with no pins. Nothing here calls Google, and no point, place id or URL reaches a log.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PLACE_POINT_TTL_SECONDS, placePointKey } from '../src/handlers/locations-map.ts';
import { createGooglePlacesClient } from '../src/places/google.ts';
import { createStaticMapSigner, STATIC_MAP_HEIGHT, STATIC_MAP_WIDTH } from '../src/places/static-map.ts';
import { fitView } from '../src/places/view.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { fakePlaces } from './helpers/places-fetch.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const SIGNING_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const STATIC_KEY = 'test-static-key';
const ID_A = 'ChIJSentinelPointPlace01';
const ID_B = 'ChIJSentinelPointPlace02';
const ID_OTHER = 'ChIJSentinelPointPlace09';
const A = { lat: 43.7022, lng: -72.2896 };
const B = { lat: 43.6426, lng: -72.2517 };

const fake = fakePlaces();
const signer = createStaticMapSigner(STATIC_KEY, SIGNING_SECRET);
let server: TownwiseTestServer;
let mapOff: TownwiseTestServer;
let member: TestSession;
let orgId: string;

async function placeAt(locationId: string, placeId: string): Promise<void> {
  await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(locationId) }, { $set: { placeId } });
}

function located(id: string, at: { lat: number; lng: number }): { kind: 'json'; body: unknown } {
  return { kind: 'json', body: { id, location: { latitude: at.lat, longitude: at.lng } } };
}

function get(path = '/api/org/locations/map', as: TestSession = member, on: TownwiseTestServer = server): Promise<Response> {
  return call(on, path, { session: as });
}

beforeAll(async () => {
  mapOff = await startTownwiseServer({ places: createGooglePlacesClient('test-places-key', { fetch: fake.fetch, timeoutMs: 200 }) });
  server = await startTownwiseServer({
    places: createGooglePlacesClient('test-places-key', { fetch: fake.fetch, timeoutMs: 200 }),
    placesMap: signer,
  });
});
afterAll(async () => {
  await server.close();
  await mapOff.close();
});
beforeEach(async () => {
  fake.reset();
  await server.redis.flushdb();
  const email = `map-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  orgId = await createOrg(server, { name: 'Pin Group' });
  await addSeat(server, { orgId, userId: member.userId, email, role: 'member' });
});

describe('GET /api/org/locations/map', () => {
  it('answers the map Townwise centered and each pin’s position, lettered in the organization’s order', async () => {
    await placeAt(await addLocation(server, { orgId, name: 'First' }), ID_A);
    await addLocation(server, { orgId, name: 'No place' });
    await placeAt(await addLocation(server, { orgId, name: 'Second' }), ID_B);
    fake.script(located(ID_A, A), located(ID_B, B));
    const res = await get();
    expect(res.status).toBe(200);
    const view = fitView([A, B], STATIC_MAP_WIDTH, STATIC_MAP_HEIGHT);
    expect(await res.json()).toEqual({
      map: signer.mapOfView(view, [{ at: A, letter: 'A' }, { at: B, letter: 'B' }], 'dark'),
      pins: [
        { placeId: ID_A, letter: 'A', x: view.positions[0]?.x, y: view.positions[0]?.y },
        { placeId: ID_B, letter: 'B', x: view.positions[1]?.x, y: view.positions[1]?.y },
      ],
    });
    // Place Details with the point only, and no session token.
    expect(fake.calls.map((c) => [c.url.split('?')[0]?.split('/').pop(), c.headers['x-goog-fieldmask']])).toEqual([[ID_A, 'id,location'], [ID_B, 'id,location']]);
  });

  it('keeps each point in Valkey under 30 days, so the next view asks Google nothing', async () => {
    await placeAt(await addLocation(server, { orgId, name: 'First' }), ID_A);
    fake.script(located(ID_A, A));
    expect((await get()).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    const ttl = await server.redis.ttl(placePointKey(ID_A));
    expect(ttl).toBeGreaterThan(PLACE_POINT_TTL_SECONDS - 60);
    expect(ttl).toBeLessThan(30 * 24 * 60 * 60);
    const again = await get('/api/org/locations/map?theme=light');
    expect(fake.calls).toHaveLength(1);
    expect(((await again.json()) as { pins: unknown[] }).pins).toHaveLength(1);
  });

  it('never pins another organization’s places', async () => {
    const other = await createOrg(server, { name: 'Other Group' });
    await placeAt(await addLocation(server, { orgId: other, name: 'Elsewhere' }), ID_OTHER);
    await placeAt(await addLocation(server, { orgId, name: 'Mine' }), ID_A);
    fake.script(located(ID_A, A));
    const body = await (await get()).json() as { pins: { placeId: string }[] };
    expect(body.pins.map((p) => p.placeId)).toEqual([ID_A]);
    expect(JSON.stringify(fake.calls)).not.toContain(ID_OTHER);
  });

  it('without every point (Google failing) answers Google’s own lettered fit and no pins, and logs only the code', async () => {
    await placeAt(await addLocation(server, { orgId, name: 'First' }), ID_A);
    await placeAt(await addLocation(server, { orgId, name: 'Second' }), ID_B);
    fake.script(located(ID_A, A), { kind: 'json', status: 500, body: {} });
    const res = await get();
    expect(await res.json()).toEqual({ map: signer.mapOfLabeledPlaces([ID_A, ID_B], 'dark'), pins: [] });
    const logs = server.logs.join('\n');
    expect(logs).toContain('townwise.places_failed');
    for (const secret of [ID_A, ID_B, String(A.lat), STATIC_KEY]) expect(logs).not.toContain(secret);
  });

  it('answers no map and no pins with the map off or no place; a bad theme is 400; a person with no seat is refused', async () => {
    expect(await (await get()).json()).toEqual({ map: null, pins: [] });
    expect((await get('/api/org/locations/map?theme=sepia')).status).toBe(400);
    const stranger = await signIn(server, `stranger-${randomUUID().slice(0, 8)}@example.test`);
    expect((await get('/api/org/locations/map', stranger)).status).toBe(403);
    const offEmail = `off-${randomUUID().slice(0, 8)}@example.test`;
    const offMember = await signIn(mapOff, offEmail);
    const offOrg = await createOrg(mapOff, { name: 'Off Group' });
    await addSeat(mapOff, { orgId: offOrg, userId: offMember.userId, email: offEmail, role: 'member' });
    expect(await (await get('/api/org/locations/map', offMember, mapOff)).json()).toEqual({ map: null, pins: [] });
  });
});
