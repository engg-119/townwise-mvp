// D66's Competition card, GET /api/org/locations/:locationId/competition (openspec change town-research-agent, task 5.4,
// design decisions 10 and 13): the location's competitors live from Nearby Search (food and drink only, its own place
// left out, its own type family first), lettered on a map fitted around it, each with its upcoming researched events
// matched by the stored place id or by the business's name key against the live display name, and the other competitor
// events in the web list by the business's name. With Google's names kept from Anthropic (the shipped config) the name
// match still letters them; with Places off or failing, or no place picked, the web list carries every one. Nothing is
// written to Mongo, and the log holds counts only. Google is a fake fetch; places and businesses are made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { placePointKey } from '../src/handlers/locations-map.ts';
import { createGooglePlacesClient } from '../src/places/google.ts';
import { createStaticMapSigner } from '../src/places/static-map.ts';
import { nameKey } from '../src/research/dedupe.ts';
import type { LocationEventInsert } from '../src/stores/research-locations.ts';
import { addSeat, createOrg } from './helpers/fixtures.ts';
import { fakePlaces } from './helpers/places-fetch.ts';
import { call, signIn, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const OWN_PLACE = 'ChIJTestCompetitionOwn01';
const TAVERN = 'ChIJTestCompetitionTav01';
const COFFEE = 'ChIJTestCompetitionCof01';
const BOOKS = 'ChIJTestCompetitionBok01';
const CENTER = { lat: 43.7022, lng: -72.2896 };

const fake = fakePlaces();
let server: TownwiseTestServer;
/** Places search off. */
let placesOff: TownwiseTestServer;

beforeAll(async () => {
  // Each start drops the database, so both start before anything is written.
  placesOff = await startTownwiseServer();
  server = await startTownwiseServer({
    env: { TOWNWISE_RESEARCH_PLACES_TO_AI: 'false' },
    places: createGooglePlacesClient('test-places-key', { fetch: fake.fetch, timeoutMs: 200 }),
    placesMap: createStaticMapSigner('test-static-key', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='),
  });
});
afterAll(async () => {
  await server.close();
  await placesOff.close();
});
beforeEach(async () => {
  fake.reset();
  await server.redis.flushdb();
});

interface Tenant { orgId: string; scope: OrgScope; locationId: string; session: TestSession; offSession: TestSession }

async function tenant(placeId: string | null): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Competition Cafe ${randomUUID().slice(0, 6)}` });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email });
  const offEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const offSession = await signIn(placesOff, offEmail);
  await addSeat(server, { orgId, userId: offSession.userId, email: offEmail });
  const locationId = new Types.ObjectId();
  await server.connection.collection('tw_locations').insertOne({
    _id: locationId, orgId: new Types.ObjectId(orgId), name: 'Main Room', nameKey: 'main room',
    town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, placeId, createdAt: server.clock.now(), createdBy: 'fixture',
  });
  return { orgId, scope: scopeForNewOrg(STAFF, orgId), locationId: locationId.toHexString(), session, offSession };
}

/** A competitor's business entity and one event of it, `days` after today (2026-06-01). */
async function competitorEvent(t: Tenant, business: string, title: string, opts: { day?: string; placeId?: string | null; stampPlace?: string | null } = {}) {
  const stores = server.ctx.stores.researchLocations;
  const now = server.clock.now();
  const stamp = { placeId: opts.stampPlace === undefined ? OWN_PLACE : opts.stampPlace, town: 'hanover-nh' };
  const entityId = await stores.upsertEntity(t.scope, t.locationId, {
    ...stamp, type: 'business', name: business, nameKey: nameKey(business), townEntityId: null,
    sources: [{ label: 'example.test', url: 'https://example.test/biz' }], now,
  });
  const runId = new Types.ObjectId().toHexString();
  const day = opts.day ?? '2026-06-12';
  const input: LocationEventInsert = {
    ...stamp, title, titleKey: title.toLowerCase(), kind: 'event', category: 'dining', start: day, end: day, weekdays: null,
    startTime: '19:00', status: 'scheduled', venueId: null, hostId: entityId, confidence: 'medium',
    sources: [{ label: 'example.test', url: 'https://example.test/event' }], firstRunId: runId, lastRunId: runId, firstSeenAt: now,
    lastSeenAt: now, seenCount: 1, origin: 'competitor', competitorEntityId: entityId, competitorPlaceId: opts.placeId ?? null,
  };
  return stores.insertEvent(t.scope, t.locationId, input);
}

const nearbyPlace = (id: string, name: string, primaryType: string, lat: number, lng: number): unknown => ({
  id, displayName: { text: name, languageCode: 'en' }, primaryType, location: { latitude: lat, longitude: lng },
});

function scriptNearby(): void {
  fake.script({
    kind: 'json',
    body: {
      places: [
        nearbyPlace(OWN_PLACE, 'Own Fixture Grill', 'american_restaurant', CENTER.lat, CENTER.lng),
        nearbyPlace(COFFEE, 'Mill Street Coffee', 'coffee_shop', 43.7024, -72.2899),
        nearbyPlace(BOOKS, 'Corner Books', 'book_store', 43.7023, -72.2897),
        nearbyPlace(TAVERN, 'The Riverbank Tavern', 'american_restaurant', 43.7030, -72.2905),
      ],
    },
  });
}

interface CompetitionBody {
  gap: string | null;
  map: { url: string } | null;
  competitors: { letter: string; placeId: string; name: string; type: string; distanceM: number; x: number | null; y: number | null; events: { id: string; title: string }[] }[];
  web: { name: string; events: { id: string; title: string }[] }[];
}

async function competition(session: TestSession, locationId: string, on = server): Promise<CompetitionBody> {
  const res = await call(on, `/api/org/locations/${locationId}/competition?theme=light`, { session });
  expect(res.status).toBe(200);
  return await res.json() as CompetitionBody;
}

describe('GET /api/org/locations/:locationId/competition', () => {
  it('letters the nearby competitors, own type first, and puts events under a letter by the business’s name or the stored place id', async () => {
    const t = await tenant(OWN_PLACE);
    await server.redis.set(placePointKey(OWN_PLACE), `${String(CENTER.lat)},${String(CENTER.lng)}`);
    const trivia = await competitorEvent(t, 'Riverbank Tavern, Inc.', 'Tavern Trivia Night');
    const latte = await competitorEvent(t, 'Mill St Roasters', 'Latte Art Throwdown', { placeId: COFFEE });
    const web = await competitorEvent(t, 'Far Field Bistro', 'Bistro Wine Dinner');
    await competitorEvent(t, 'Far Field Bistro', 'Too Far Ahead', { day: '2026-09-01' });
    const hidden = await competitorEvent(t, 'The Riverbank Tavern', 'Hidden Tavern Night');
    await server.ctx.stores.researchRevisions.append(t.scope, {
      locationId: t.locationId, eventId: `l-${hidden.id}`, op: 'hide', fields: null, reverts: null, basedOn: 'base',
      by: { kind: 'person', userId: t.session.userId }, now: server.clock.now(),
    });
    scriptNearby();
    server.logs.length = 0;
    let body: CompetitionBody | undefined;
    const writes = await writesDuring(server, async () => { body = await competition(t.session, t.locationId); });
    expect(writes).toEqual([]);
    expect(body?.gap).toBeNull();
    expect(body?.map?.url).toMatch(/^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/);
    expect(body?.competitors.map(({ letter, placeId, name, type, events }) => ({ letter, placeId, name, type, events: events.map((e) => e.id) }))).toEqual([
      { letter: 'A', placeId: TAVERN, name: 'The Riverbank Tavern', type: 'american_restaurant', events: [`l-${trivia.id}`] },
      { letter: 'B', placeId: COFFEE, name: 'Mill Street Coffee', type: 'coffee_shop', events: [`l-${latte.id}`] },
    ]);
    for (const competitor of body?.competitors ?? []) {
      expect(competitor.x).toBeGreaterThan(0);
      expect(competitor.y).toBeGreaterThan(0);
    }
    // Competitors within a block: the zoom fits them (not the single-place map's 15), and the pins stand apart.
    expect(Number(new URL(body?.map?.url ?? 'https://x.test').searchParams.get('zoom'))).toBeGreaterThan(15);
    const [first, second] = body?.competitors ?? [];
    expect(Math.hypot(((first?.x ?? 0) - (second?.x ?? 0)) * 640, ((first?.y ?? 0) - (second?.y ?? 0)) * 320)).toBeGreaterThanOrEqual(26);
    expect(body?.web.map(({ name, events }) => ({ name, events: events.map((e) => e.id) }))).toEqual([{ name: 'Far Field Bistro', events: [`l-${web.id}`] }]);
    // One Nearby call, no website asked for.
    expect(fake.calls.map((each) => each.headers['x-goog-fieldmask'])).toEqual(['places.id,places.displayName,places.primaryType,places.location']);
    const lines = server.logs.join('\n');
    expect(lines).toContain('townwise.competition_read');
    for (const secret of ['Riverbank', 'Mill Street', 'Far Field', 'Trivia', OWN_PLACE, TAVERN]) expect(lines).not.toContain(secret);
  });

  it('with no place picked, asks Google nothing and lists every competitor event on the web list', async () => {
    const t = await tenant(null);
    const event = await competitorEvent(t, 'Riverbank Tavern', 'Tavern Trivia Night', { stampPlace: null });
    const body = await competition(t.session, t.locationId);
    expect(body).toMatchObject({ gap: 'no_place', map: null, competitors: [] });
    expect(body.web.map(({ name, events }) => ({ name, events: events.map((e) => e.id) }))).toEqual([{ name: 'Riverbank Tavern', events: [`l-${event.id}`] }]);
    expect(fake.calls).toEqual([]);
  });

  it('with Places off, or Google failing, shows the web list and no map', async () => {
    const t = await tenant(OWN_PLACE);
    const event = await competitorEvent(t, 'Riverbank Tavern', 'Tavern Trivia Night');
    const off = await competition(t.offSession, t.locationId, placesOff);
    expect(off).toMatchObject({ gap: 'places_off', map: null, competitors: [] });
    expect(off.web.map((each) => each.events.map((e) => e.id))).toEqual([[`l-${event.id}`]]);
    await server.redis.set(placePointKey(OWN_PLACE), `${String(CENTER.lat)},${String(CENTER.lng)}`);
    fake.script({ kind: 'network' });
    const failing = await competition(t.session, t.locationId);
    expect(failing).toMatchObject({ gap: 'places_off', map: null, competitors: [] });
    expect(failing.web).toHaveLength(1);
  });

  it('shows no researched event while the organization’s research is off, and still the live competitors', async () => {
    const t = await tenant(OWN_PLACE);
    await competitorEvent(t, 'Riverbank Tavern', 'Tavern Trivia Night');
    await server.ctx.stores.orgs.setResearch(t.scope, { on: false, at: server.clock.now(), by: t.session.userId });
    await server.redis.set(placePointKey(OWN_PLACE), `${String(CENTER.lat)},${String(CENTER.lng)}`);
    scriptNearby();
    const body = await competition(t.session, t.locationId);
    expect(body.competitors.map((each) => [each.letter, each.events.length])).toEqual([['A', 0], ['B', 0]]);
    expect(body.web).toEqual([]);
  });

  it('answers 404 for another organization’s location', async () => {
    const a = await tenant(OWN_PLACE);
    const b = await tenant(OWN_PLACE);
    expect((await call(server, `/api/org/locations/${b.locationId}/competition`, { session: a.session })).status).toBe(404);
  });
});
