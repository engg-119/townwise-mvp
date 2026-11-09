// GET /api/org/locations/:locationId/calendar?from=&to= (spec 10.10, 13.1): the public calendar of the location's
// town, honest about what is researched, strict about the range, and 404 across organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { utcDay } from '../src/dates.ts';
import type { TownEvent } from '../src/town-calendar.ts';
import type { Town } from '../src/towns.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

interface CalendarResponse {
  town: Town;
  researched: boolean;
  covers: { from: string; to: string } | null;
  events: TownEvent[];
}

let server: TownwiseTestServer;
let orgId: string;
let member: TestSession;
/** The fixtures' locations are all in Hanover. */
let hanover: string;

beforeAll(async () => {
  server = await startTownwiseServer();
  orgId = await createOrg(server, { name: 'Calendar Kitchen' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email });
  hanover = await addLocation(server, { orgId, name: 'Hanover Room' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

/** A location in `town`, written straight to tw_locations. */
async function locationIn(town: Town, owner = orgId): Promise<string> {
  const _id = new Types.ObjectId();
  const name = `${town.name} Room ${randomUUID().slice(0, 6)}`;
  await server.connection.collection('tw_locations').insertOne({
    _id, orgId: new Types.ObjectId(owner), name, nameKey: name.toLowerCase(), town, createdAt: server.clock.now(), createdBy: 'fixture',
  });
  return _id.toHexString();
}

function calendar(locationId: string, query: string, session = member): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/calendar${query}`, { session });
}

async function ok(locationId: string, from: string, to: string): Promise<CalendarResponse> {
  const res = await calendar(locationId, `?from=${from}&to=${to}`);
  expect(res.status).toBe(200);
  return await res.json() as CalendarResponse;
}

describe('GET /api/org/locations/:locationId/calendar', () => {
  it('gives a Hanover location its term dates, events, key dates and holidays, each with sources, and says it is researched', async () => {
    const body = await ok(hanover, '2026-11-15', '2026-11-30');
    expect(Object.keys(body).sort()).toEqual(['covers', 'events', 'researched', 'town']);
    expect(body.town).toEqual({ townId: 'hanover-nh', name: 'Hanover', state: 'NH' });
    expect(body.researched).toBe(true);
    expect(body.covers).toEqual({ from: '2025-01-06', to: '2027-11-24' });
    expect(body.events.map((event) => event.id)).toEqual([
      'hanover-nh:2026-09-14:fall-term-classes',
      'hanover-nh:2026-11-17:fall-term-classes-end',
      'hanover-nh:2026-11-20:fall-term-finals',
      'hanover-nh:2026-11-21:home-football-vs-brown',
      'us:thanksgiving:2026',
    ]);
    expect(body.events[2]).toEqual({
      id: 'hanover-nh:2026-11-20:fall-term-finals', title: 'Fall term finals', start: '2026-11-20', end: '2026-11-25',
      kind: 'term', scope: 'town', group: 'hanover-nh:finals:fall', groupLabel: 'Fall term finals', confidence: 'high',
      sources: [{
        label: 'Dartmouth Registrar, 2026-27 key dates',
        url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates',
      }],
    });
    for (const event of body.events) expect(event.sources.length).toBeGreaterThan(0);
  });

  it('gives a town outside the twelve, and a listed town with nothing researched, holidays only and researched false', async () => {
    for (const town of [
      { townId: null, name: 'Woodstock', state: 'VT' },
      { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' },
    ] as const) {
      const body = await ok(await locationIn(town), '2026-01-01', '2026-12-31');
      expect(body.town).toEqual(town);
      expect(body.researched).toBe(false);
      expect(body.covers).toBeNull();
      expect(body.events).toHaveLength(11);
      expect(body.events.every((event) => event.kind === 'holiday' && event.scope === 'national')).toBe(true);
    }
  });

  it('accepts a range from 2010-01-01 up to 400 days ahead', async () => {
    const latest = utcDay(server.clock.now(), 400);
    expect((await calendar(hanover, `?from=2010-01-01&to=2010-01-01`)).status).toBe(200);
    const body = await ok(hanover, '2026-06-01', latest);
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) expect(event.start <= latest && event.end >= '2026-06-01').toBe(true);
  });

  it('answers 400 invalid_request, with no field details, for a missing, malformed, reversed, too early, too late or padded range', async () => {
    const tooLate = utcDay(server.clock.now(), 401);
    for (const query of [
      '', '?from=2026-01-01', '?to=2026-01-01', '?from=2026-02-30&to=2026-03-01', '?from=20260101&to=20260102',
      '?from=2026-03-02&to=2026-03-01', '?from=2009-12-31&to=2010-01-05', `?from=2026-01-01&to=${tooLate}`,
      '?from=2010-01-01&to=2030-01-01', '?from=2026-01-01&to=2026-01-02&extra=1', '?from=2026-01-01&from=2026-01-02&to=2026-01-03',
    ]) {
      const res = await calendar(hanover, query);
      const body = await res.json() as Record<string, unknown>;
      expect({ query, status: res.status, error: body.error }).toEqual({ query, status: 400, error: 'invalid_request' });
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    }
  });

  it('answers 404 for another organization’s location and an unknown id, and 400 for a malformed id', async () => {
    const otherOrg = await createOrg(server, { name: 'Other Calendar Kitchen' });
    const theirs = await locationIn({ townId: null, name: 'Secretville', state: 'ME' }, otherOrg);
    for (const id of [theirs, new Types.ObjectId().toHexString()]) {
      const res = await calendar(id, '?from=2026-01-01&to=2026-01-31');
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
      expect(text).not.toContain('Secretville');
    }
    expect((await calendar('not-an-id', '?from=2026-01-01&to=2026-01-31')).status).toBe(400);
  });

  it('logs nothing of its own', async () => {
    server.logs.length = 0;
    await ok(hanover, '2026-01-01', '2026-01-31');
    expect(server.logs.filter((line) => line.includes('townwise.'))).toEqual([]);
  });
});
