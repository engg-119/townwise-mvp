// GET .../people-in-town and GET .../estimates/about (spec 10.13, 13.2): Hanover's term state and calendar with no
// headcount until its inputs are researched, a synthetic researched entry giving a range, a seasonal town and a town
// outside the twelve, the model card with no forecast, strict ranges, 404 across organizations, view-as reads, and
// no log line of their own. Every figure is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { utcDay } from '../src/dates.ts';
import { MODEL_CARD, MODEL_CARD_VERSION, type EstimatesAbout } from '../src/estimates/about.ts';
import type { PeopleInTownWindow } from '../src/people-in-town/estimate.ts';
import type { PeopleData } from '../src/people-in-town/sources.ts';
import type { Town } from '../src/towns.ts';
import { addGrant, addLocation, addNote, addSalesDay, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const RESEARCHED: PeopleData = {
  sources: [{ id: 'census-test', label: 'Synthetic census table', url: 'https://census.example.test/p1', retrieved: '2026-11-01', confidence: 'high' }],
  towns: [{
    townId: 'amherst-ma', residents: { value: 10_000, moe90: 500, vintage: '2020', sourceId: 'census-test' }, studentHousing: null,
    enrollment: null, housingClosesBetweenTerms: null, eventAttendance: [], visitors: null,
  }],
};

let server: TownwiseTestServer;
let orgId: string;
let member: TestSession;
/** The fixtures' locations are all in Hanover. */
let hanover: string;

beforeAll(async () => {
  server = await startTownwiseServer({ peopleData: RESEARCHED });
  orgId = await createOrg(server, { name: 'Estimates Kitchen' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email });
  hanover = await addLocation(server, { orgId, name: 'Hanover Room' });
  // Saturdays in spring classes; May 16 would be Green Key, an event day.
  for (const date of ['2026-05-02', '2026-05-09', '2026-05-30']) {
    await addSalesDay(server, { orgId, locationId: hanover, date, guests: 150, netSalesCents: 300_000 });
  }
  await addSalesDay(server, { orgId, locationId: hanover, date: '2026-05-23', guests: 999, netSalesCents: 999_900 });
  await addNote(server, { orgId, locationId: hanover, detail: 'Closed for a staff party', startDate: '2026-05-23' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

async function locationIn(town: Town, owner = orgId): Promise<string> {
  const _id = new Types.ObjectId();
  const name = `${town.name} Room ${randomUUID().slice(0, 6)}`;
  await server.connection.collection('tw_locations').insertOne({
    _id, orgId: new Types.ObjectId(owner), name, nameKey: name.toLowerCase(), town, createdAt: server.clock.now(), createdBy: 'fixture',
  });
  return _id.toHexString();
}

function people(locationId: string, query: string, session = member): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/people-in-town${query}`, { session });
}

async function window(locationId: string, from: string, to: string): Promise<PeopleInTownWindow> {
  const res = await people(locationId, `?from=${from}&to=${to}`);
  expect(res.status).toBe(200);
  return await res.json() as PeopleInTownWindow;
}

describe('GET /api/org/locations/:locationId/people-in-town', () => {
  it('Hanover: term states from the seeded calendar, events with sources, the season, and no headcount, saying why', async () => {
    const body = await window(hanover, '2026-05-01', '2026-06-30');
    expect(body).toMatchObject({
      available: true, reason: null, from: '2026-05-01', to: '2026-06-30', town: { name: 'Hanover', state: 'NH', kind: 'college' },
      timeZone: 'America/New_York', visitors: [],
    });
    expect(body.periods.every((period) => period.headcount === null && period.headcountWhy === 'no_population')).toBe(true);
    const states = body.periods.map((period) => period.termState);
    expect(states).toEqual(expect.arrayContaining(['in_session', 'finals', 'between_terms', 'summer_session']));
    const greenKey = body.periods.find((period) => period.events.some((event) => event.title === 'Green Key weekend'));
    expect(greenKey).toMatchObject({ from: '2026-05-15', fromWeekday: 'Fri', to: '2026-05-16', toWeekday: 'Sat' });
    expect(body.season.map((month) => month.month)).toEqual(['2026-05', '2026-06']);
    const ids = new Set(body.sources.map((source) => source.id));
    for (const period of body.periods) {
      for (const id of [...period.termSourceIds, ...period.events.flatMap((event) => event.sourceIds)]) expect(ids.has(id)).toBe(true);
    }
    expect(body.caveats).toEqual(expect.arrayContaining(['County, not town: the jobs index covers the whole county.']));
  });

  it('counts only open regular days with a known term state in your history, never the closed day', async () => {
    const body = await window(hanover, '2026-05-01', '2026-05-31');
    expect(body.yourHistory).toEqual({
      metric: 'guests', cells: [{ state: 'in_session', weekday: 'Sat', days: 3, mean: 150 }], first: '2026-05-02', last: '2026-05-30',
    });
  });

  it('gives no range from a researched population alone where the town has no term dates (a synthetic entry)', async () => {
    const amherst = await locationIn({ townId: 'amherst-ma', name: 'Amherst', state: 'MA' });
    const body = await window(amherst, '2026-05-01', '2026-05-03');
    // Amherst has no term entries, so its term state is unknown and the population alone is not enough.
    expect(body.periods.map((period) => period.headcountWhy)).toEqual(['no_term_dates']);
  });

  it('a seasonal town: visitors_unknown; a town outside the twelve: available false with holidays only', async () => {
    const nantucket = await window(await locationIn({ townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }), '2026-07-01', '2026-07-07');
    expect(nantucket.periods.every((period) => period.headcountWhy === 'visitors_unknown')).toBe(true);
    const outside = await window(await locationIn({ townId: null, name: 'Woodstock', state: 'VT' }), '2026-07-01', '2026-07-07');
    expect(outside).toMatchObject({ available: false, reason: 'town_not_researched', town: { kind: null }, season: [] });
    expect(outside.periods.flatMap((period) => period.events.map((event) => event.kind))).toEqual(['holiday']);
  });

  it('answers 400 invalid_request, with no field details, for a missing, reversed, too long, too late or padded range', async () => {
    const tooLate = utcDay(server.clock.now(), 401);
    for (const query of [
      '', '?from=2026-01-01', '?from=2026-03-02&to=2026-03-01', '?from=2026-01-01&to=2026-04-03', '?from=2009-12-31&to=2010-01-05',
      `?from=${utcDay(server.clock.now(), 380)}&to=${tooLate}`, '?from=2026-01-01&to=2026-01-02&extra=1',
    ]) {
      const res = await people(hanover, query);
      const body = await res.json() as Record<string, unknown>;
      expect({ query, status: res.status, error: body.error }).toEqual({ query, status: 400, error: 'invalid_request' });
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    }
    // 92 days, both ends included.
    expect((await people(hanover, '?from=2026-01-01&to=2026-04-02')).status).toBe(200);
  });
});

describe('GET /api/org/locations/:locationId/estimates/about', () => {
  it('gives the model card, today in the town, its calendar coverage, no headcount inputs and no forecast', async () => {
    const res = await call(server, `/api/org/locations/${hanover}/estimates/about`, { session: member });
    expect(res.status).toBe(200);
    const body = await res.json() as EstimatesAbout;
    expect(body).toEqual({
      version: MODEL_CARD_VERSION,
      card: JSON.parse(JSON.stringify(MODEL_CARD)) as unknown,
      location: { name: 'Hanover Room', town: { name: 'Hanover', state: 'NH' } },
      today: { date: '2026-06-01', weekday: 'Mon', timeZone: 'America/New_York', approximate: false },
      forecast: { run: null, live: null },
      calendar: { researched: true, covers: { from: '2025-01-06', to: '2027-01-05' } },
      people: { headcountInputs: [], sources: [] },
    });
  });

  it('lists the researched inputs and their sources for a town that has them', async () => {
    const amherst = await locationIn({ townId: 'amherst-ma', name: 'Amherst', state: 'MA' });
    const body = await (await call(server, `/api/org/locations/${amherst}/estimates/about`, { session: member })).json() as EstimatesAbout;
    expect(body.people).toEqual({ headcountInputs: ['residents'], sources: RESEARCHED.sources });
    expect(body.calendar).toEqual({ researched: true, covers: expect.any(Object) as unknown });
  });
});

describe('both routes', () => {
  it('answer 404 for another organization’s location and an unknown id, without its name', async () => {
    const otherOrg = await createOrg(server, { name: 'Other Estimates Kitchen' });
    const theirs = await locationIn({ townId: null, name: 'Secretville', state: 'ME' }, otherOrg);
    for (const id of [theirs, new Types.ObjectId().toHexString()]) {
      for (const path of [`people-in-town?from=2026-01-01&to=2026-01-31`, 'estimates/about']) {
        const res = await call(server, `/api/org/locations/${id}/${path}`, { session: member });
        const text = await res.text();
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
        expect(text).not.toContain('Secretville');
      }
    }
  });

  it('are readable under view-as, logged only as the chain’s view_as_read', async () => {
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.userId, orgId });
    server.logs.length = 0;
    expect((await people(hanover, '?from=2026-05-01&to=2026-05-31', staff)).status).toBe(200);
    expect((await call(server, `/api/org/locations/${hanover}/estimates/about`, { session: staff })).status).toBe(200);
    const own = server.logs.filter((line) => line.includes('townwise.'));
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const line of own) expect(line).toContain('townwise.view_as_read');
  });

  it('log nothing of their own, and no log line carries a figure', async () => {
    server.logs.length = 0;
    await window(hanover, '2026-05-01', '2026-05-31');
    await call(server, `/api/org/locations/${hanover}/estimates/about`, { session: member });
    expect(server.logs.filter((line) => line.includes('townwise.'))).toEqual([]);
    expect(server.logs.join('\n')).not.toMatch(/"(guests|mean|headcount|netSales)"/);
  });
});
