// GET .../people-in-town and GET .../estimates/about (spec 10.13, 13.2): Hanover's term state and calendar with no
// headcount until its inputs are researched, a synthetic researched entry giving a range, a seasonal town and a town
// outside the twelve, the model card with no forecast, strict ranges, 404 across organizations, view-as reads, and
// no log line of their own. U13B: the published forecast (drafts and withdrawn runs invisible, the newest eligible
// run per date, actuals and live accuracy) and the model card's run state. Spec 14.5: saved notes adjusting the read
// from today on, past days, accuracy and weeks kept honest, and no other tenant's notes. Every figure is synthetic.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { utcDay } from '../src/dates.ts';
import { MODEL_CARD, MODEL_CARD_VERSION, type EstimatesAbout } from '../src/estimates/about.ts';
import type { ForecastWindow } from '../src/forecasts/reader.ts';
import type { PeopleInTownWindow } from '../src/people-in-town/estimate.ts';
import type { PeopleData } from '../src/people-in-town/sources.ts';
import type { Town } from '../src/towns.ts';
import { addGrant, addLocation, addNote, addSalesDay, addSeat, createOrg } from './helpers/fixtures.ts';
import {
  call, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

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
  // Forecasts switched on (G1), so staff can publish the U13B runs below.
  orgId = await createOrg(server, { name: 'Estimates Kitchen', forecastsOn: true });
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
      calendar: { researched: true, covers: { from: '2025-01-06', to: '2027-11-24' } },
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

// U13B.
describe('GET /api/org/locations/:locationId/forecast, and the model card’s run state', () => {
  const RUN = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as {
    days: { date: string; low: number | null; mid: number | null; high: number | null }[];
    weeks: { from: string }[];
  } & Record<string, unknown>;
  /** The same model a week later: trained through May 7, forecasting May 8 to 14 a little higher. */
  const LATER = {
    ...structuredClone(RUN), dataThrough: '2026-05-07', madeAt: '2026-05-08',
    days: structuredClone(RUN.days).filter((day) => day.date > '2026-05-07').map((day) => (day.mid === null ? day : { ...day, low: 90, mid: 110, high: 130 })),
    weeks: structuredClone(RUN.weeks).filter((week) => week.from > '2026-05-07'),
  };
  let staff: TestSession;
  let forecasted: string;

  beforeAll(async () => {
    staff = await signInStaff(server);
    forecasted = await addLocation(server, { orgId, name: 'Forecast Room' });
    for (const [date, guests] of [['2026-05-01', 100], ['2026-05-02', 100], ['2026-05-03', 100], ['2026-05-05', 100], ['2026-05-06', 130], ['2026-05-07', 100]] as const) {
      await addSalesDay(server, { orgId, locationId: forecasted, date, guests, netSalesCents: guests * 1000 });
    }
  });
  afterAll(async () => { await removeStaffFactor(server); });

  async function staffImport(body: unknown): Promise<string> {
    const res = await call(server, `/api/admin/orgs/${orgId}/locations/${forecasted}/forecast-runs`, { session: staff, json: body });
    expect(res.status).toBe(201);
    return (await res.json() as { run: { id: string } }).run.id;
  }
  async function staffChange(runId: string, verb: 'publish' | 'withdraw'): Promise<void> {
    expect((await call(server, `/api/admin/orgs/${orgId}/forecast-runs/${runId}/${verb}`, { session: staff, json: {} })).status).toBe(200);
  }
  async function forecast(query = '?from=2026-05-01&to=2026-05-14', session = member): Promise<ForecastWindow> {
    const res = await call(server, `/api/org/locations/${forecasted}/forecast${query}`, { session });
    expect(res.status).toBe(200);
    return await res.json() as ForecastWindow;
  }
  async function about(): Promise<EstimatesAbout> {
    return await (await call(server, `/api/org/locations/${forecasted}/estimates/about`, { session: member })).json() as EstimatesAbout;
  }

  let first: string;

  it('says no forecast while none is published, and a draft stays invisible', async () => {
    const none = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], notCovered: [{ from: '2026-05-01', to: '2026-05-14' }] };
    expect(await forecast()).toEqual(none);
    first = await staffImport(RUN);
    expect(await forecast()).toEqual(none);
    expect((await about()).forecast).toEqual({ run: null, live: null });
  });

  it('once published: every day with its range, reasons in words, actuals, and the run’s own week rows', async () => {
    await staffChange(first, 'publish');
    const body = await forecast();
    expect(body).toMatchObject({ available: true, reason: null, notCovered: [] });
    expect(body.runs).toEqual([expect.objectContaining({ id: first, model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' } })]);
    expect(body.days).toHaveLength(14);
    expect(body.days[0]).toEqual({
      date: '2026-05-01', weekday: 'Fri', status: 'open', low: 80, mid: 100, high: 120, baseline: null,
      reasons: [
        { kind: 'weekday', label: 'Friday', effectPct: null, sources: [], note: null },
        { kind: 'term', label: 'Spring term classes', effectPct: null, sources: expect.any(Array) as unknown, note: null },
      ],
      runId: first, madeAt: '2026-05-01', madeAfterDay: true, actual: 100, inRange: true,
      model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 0, moreNotes: 0,
    });
    expect(body.days.find((day) => day.date === '2026-05-06')).toMatchObject({ actual: 130, inRange: false, madeAfterDay: false });
    expect(body.days.find((day) => day.date === '2026-05-04')).toMatchObject({ status: 'closed', low: null, inRange: null });
    expect(body.days.find((day) => day.date === '2026-05-13')).toMatchObject({ status: 'booked', low: null, inRange: null });
    expect(body.days.find((day) => day.date === '2026-05-09')?.reasons.map((reason) => reason.label)).toEqual(['Saturday', 'Spring term classes', 'Town event']);
    // Weeks are the run's own rows; the first week's three open days all have actuals.
    expect(body.weeks.map((week) => [week.from, week.to, week.mid, week.actual, week.inRange])).toEqual([
      ['2026-05-01', '2026-05-03', 300, 300, true], ['2026-05-04', '2026-05-10', 600, null, null], ['2026-05-11', '2026-05-14', 300, null, null],
    ]);
    // Six scored days, one missed: |30| over 630 guests.
    expect(body.runs[0]?.live).toEqual({ days: 6, inRange: 5, typicalErrorPct: 4.8, from: '2026-05-01', to: '2026-05-07' });
    expect((await about()).forecast.live).toEqual(body.runs[0]?.live);
  });

  it('uses the newest published run whose data ends before each day, and weeks only wholly from one run', async () => {
    const later = await staffImport(LATER);
    await staffChange(later, 'publish');
    const body = await forecast();
    expect(body.runs.map((run) => run.id)).toEqual([later, first]);
    // Each run is scored over its own days: every scored day (May 1 to 7) came from the first run, so the later one
    // has no live accuracy yet and is never credited with the first one's hits and misses.
    expect(body.runs.map((run) => run.live?.days ?? null)).toEqual([null, 6]);
    expect(body.days.filter((day) => day.runId === later).map((day) => day.date)).toEqual([
      '2026-05-08', '2026-05-09', '2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14',
    ]);
    expect(body.days.find((day) => day.date === '2026-05-08')).toMatchObject({ low: 90, mid: 110, high: 130 });
    expect(body.days.find((day) => day.date === '2026-05-07')).toMatchObject({ runId: first, mid: 100 });
    // May 4 to 10 mixes two runs, so no week row covers it.
    expect(body.weeks.map((week) => [week.from, week.runId])).toEqual([['2026-05-01', first], ['2026-05-11', later]]);
    const card = await about();
    expect(card.forecast.run).toMatchObject({ id: later, dataThrough: '2026-05-07', madeAt: '2026-05-08', interval: { level: 0.8, widened: true } });
    expect(card.forecast.live).toBeNull();
    await staffChange(later, 'withdraw');
    expect((await forecast()).runs.map((run) => run.id)).toEqual([first]);
    expect((await about()).forecast).toMatchObject({ run: { id: first }, live: { days: 6, inRange: 5 } });
  });

  it('a range the forecast doesn’t reach says which days it doesn’t cover', async () => {
    const body = await forecast('?from=2026-05-12&to=2026-05-20');
    expect(body).toMatchObject({ available: true, notCovered: [{ from: '2026-05-15', to: '2026-05-20' }] });
    expect(await forecast('?from=2026-05-20&to=2026-05-25')).toMatchObject({ available: false, reason: 'not_covered', days: [] });
  });

  it('answers 400 for more than 31 days, a start more than 400 days back, or an extra key', async () => {
    for (const query of ['?from=2026-05-01&to=2026-06-01', '?from=2025-04-26&to=2025-05-01', '?from=2026-05-01&to=2026-05-02&x=1', '']) {
      const res = await call(server, `/api/org/locations/${forecasted}/forecast${query}`, { session: member });
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
    }
    expect((await call(server, `/api/org/locations/${forecasted}/forecast?from=2026-05-01&to=2026-05-31`, { session: member })).status).toBe(200);
  });

  it('is readable under view-as, showing only what the person sees, and logs no figure', async () => {
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.userId, orgId });
    server.logs.length = 0;
    const seen = await forecast('?from=2026-05-01&to=2026-05-14', staff);
    expect(seen.runs.map((run) => run.id)).toEqual([first]);
    expect(server.logs.filter((line) => line.includes('townwise.')).every((line) => line.includes('townwise.view_as_read'))).toBe(true);
    expect(server.logs.join('\n')).not.toMatch(/"(low|mid|high|actual|guests)"/);
    await server.connection.collection('tw_view_as_grants').deleteMany({ actorUserId: staff.userId });
  });

  // Spec 14.5: the location's notes adjust each day on read from the town's today (June 1 in Hanover) on.
  describe('notes in the forecast', () => {
    const SECRET = 'Rehearsal dinner for the sentinel-family';
    const WEEKS = [['2026-05-25', '2026-05-31'], ['2026-06-01', '2026-06-07'], ['2026-06-08', '2026-06-14']] as const;
    /** Trained through May 24: May 25 to June 14 at 80 to 120 a day, in three whole weeks of 560 to 840. */
    const NOTED_RUN = {
      ...structuredClone(RUN), dataThrough: '2026-05-24', madeAt: '2026-05-25',
      days: WEEKS.flatMap(([from]) => [0, 1, 2, 3, 4, 5, 6].map((plus) => utcDay(new Date(`${from}T00:00:00.000Z`), plus))).map((date) => ({
        date, status: 'open', low: 80, mid: 100, high: 120, baseline: null, reasons: [{ kind: 'weekday', ref: null, effectPct: null }],
      })),
      weeks: WEEKS.map(([from, to]) => ({ from, to, openDays: 7, low: 560, mid: 700, high: 840 })),
    };
    const ALL = '?from=2026-05-25&to=2026-06-14';
    let noted: string;

    beforeAll(async () => {
      noted = await addLocation(server, { orgId, name: 'Noted Room' });
      for (const date of ['2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31']) {
        const guests = date === '2026-05-30' ? 150 : 100;
        await addSalesDay(server, { orgId, locationId: noted, date, guests, netSalesCents: guests * 1000 });
      }
      const imported = await call(server, `/api/admin/orgs/${orgId}/locations/${noted}/forecast-runs`, { session: staff, json: NOTED_RUN });
      expect(imported.status).toBe(201);
      await staffChange((await imported.json() as { run: { id: string } }).run.id, 'publish');
    });
    beforeEach(async () => { await server.connection.collection('tw_notes').deleteMany({ locationId: new Types.ObjectId(noted) }); });

    async function read(query = ALL, location = noted): Promise<ForecastWindow> {
      const res = await call(server, `/api/org/locations/${location}/forecast${query}`, { session: member });
      expect(res.status).toBe(200);
      return await res.json() as ForecastWindow;
    }
    const dayOf = (body: ForecastWindow, date: string) => body.days.find((day) => day.date === date);
    const event = (fields: Record<string, unknown>) => ({
      kind: 'private_event', startDate: '2026-06-06', endDate: '2026-06-06', effect: 'more_guests', expectedGuests: 70, detail: SECRET,
      ...fields,
    });
    async function save(body: Record<string, unknown>, location = noted): Promise<string> {
      const res = await call(server, `/api/org/locations/${location}/notes`, { session: member, json: body });
      expect(res.status).toBe(201);
      return (await res.json() as { note: { id: string } }).note.id;
    }
    const notePath = (noteId: string) => `/api/org/locations/${noted}/notes/${noteId}`;
    const UNCHANGED = { status: 'open', low: 80, mid: 100, high: 120, model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 0, moreNotes: 0 };

    it('a saved private event of 70 guests raises that day’s range by 70 and names it; deleting the note restores the model’s range', async () => {
      const noteId = await save(event({ startTime: '18:00', endTime: '21:00' }));
      const body = await read();
      expect(dayOf(body, '2026-06-06')).toMatchObject({
        status: 'open', low: 150, mid: 170, high: 190, model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 70, moreNotes: 0,
      });
      expect(dayOf(body, '2026-06-06')?.reasons).toEqual([
        { kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, sources: [], note: { id: noteId, guests: 70, outcome: 'added' } },
        { kind: 'weekday', label: 'Saturday', effectPct: null, sources: [], note: null },
      ]);
      expect(dayOf(body, '2026-06-05')).toMatchObject(UNCHANGED);
      expect(JSON.stringify(body)).not.toContain('sentinel');
      expect((await call(server, notePath(noteId), { method: 'DELETE', session: member })).status).toBe(204);
      const after = dayOf(await read(), '2026-06-06');
      expect(after).toMatchObject(UNCHANGED);
      expect(after?.reasons.map((reason) => reason.kind)).toEqual(['weekday']);
    });

    it('editing the note’s guests changes the day on the next read', async () => {
      const noteId = await save(event({}));
      expect(dayOf(await read(), '2026-06-06')).toMatchObject({ mid: 170, noteGuests: 70 });
      expect((await call(server, notePath(noteId), { method: 'PATCH', session: member, json: event({ expectedGuests: 40 }) })).status).toBe(200);
      const day = dayOf(await read(), '2026-06-06');
      expect(day).toMatchObject({ low: 120, mid: 140, high: 160, noteGuests: 40 });
      expect(day?.reasons[0]).toMatchObject({ label: 'Your private event, 40 guests', note: { guests: 40, outcome: 'added' } });
    });

    it('a buyout note books the day; a closure note closes it; the week holding either is left out', async () => {
      await save(event({ startDate: '2026-06-09', endDate: '2026-06-09', effect: 'closed', expectedGuests: 50 }));
      await save({ kind: 'closure', startDate: '2026-06-03', endDate: '2026-06-03', effect: 'closed', detail: SECRET });
      const body = await read();
      expect(dayOf(body, '2026-06-09')).toMatchObject({
        status: 'booked', low: null, mid: null, high: null, model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 50,
      });
      expect(dayOf(body, '2026-06-09')?.reasons[0]).toMatchObject({ kind: 'note', label: 'Your private buyout, 50 guests', note: { guests: 50, outcome: 'booked' } });
      expect(dayOf(body, '2026-06-03')).toMatchObject({ status: 'closed', low: null, mid: null, high: null, noteGuests: 0 });
      expect(dayOf(body, '2026-06-03')?.reasons[0]).toMatchObject({ kind: 'note', label: 'Your closure', note: { guests: null, outcome: 'closed' } });
      expect(body.weeks.map((week) => week.from)).toEqual(['2026-05-25']);
      expect(JSON.stringify(body)).not.toContain('sentinel');
    });

    it('a week’s range shifts by the guests notes add on its open days', async () => {
      await save(event({ startDate: '2026-06-02', endDate: '2026-06-02' }));
      await save(event({ startDate: '2026-06-04', endDate: '2026-06-04', expectedGuests: 30 }));
      expect((await read()).weeks.map((week) => [week.from, week.low, week.mid, week.high, week.noteGuests])).toEqual([
        ['2026-05-25', 560, 700, 840, 0], ['2026-06-01', 660, 800, 940, 100], ['2026-06-08', 560, 700, 840, 0],
      ]);
      // A week reaching past the range still counts its notes outside it.
      expect((await read('?from=2026-06-03&to=2026-06-04')).weeks).toEqual([expect.objectContaining({ from: '2026-06-01', mid: 800, noteGuests: 100 })]);
    });

    it('inRange and live accuracy stay the model’s own', async () => {
      const before = await read();
      // Seven scored days, May 30 missed: |50| over 750 guests.
      expect(before.runs[0]?.live).toEqual({ days: 7, inRange: 6, typicalErrorPct: 6.7, from: '2026-05-25', to: '2026-05-31' });
      const noteId = await save(event({ startDate: '2026-05-30', endDate: '2026-05-31' }));
      const body = await read();
      expect(body.runs[0]?.live).toEqual(before.runs[0]?.live);
      expect(dayOf(body, '2026-05-30')).toMatchObject({ ...UNCHANGED, actual: 150, inRange: false });
      expect(dayOf(body, '2026-05-30')?.reasons.map((reason) => reason.note)).toEqual([null, { id: noteId, guests: 70, outcome: 'past_day' }]);
      expect(body.weeks[0]).toMatchObject({ from: '2026-05-25', mid: 700, actual: 750, inRange: true, noteGuests: 0 });
    });

    it('another location’s or organization’s notes never change this location’s forecast', async () => {
      const otherOrg = await createOrg(server, { name: 'Other Noted Kitchen' });
      const raw = (org: string, location: string) => ({
        _id: new Types.ObjectId(), orgId: new Types.ObjectId(org), locationId: new Types.ObjectId(location), kind: 'private_event',
        startDate: '2026-06-06', endDate: '2026-06-06', weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
        startTime: null, endTime: null, createdBy: 'fixture', createdAt: server.clock.now(), updatedAt: server.clock.now(),
      });
      const notes = server.connection.collection('tw_notes');
      const elsewhere = raw(orgId, hanover);
      await notes.insertMany([elsewhere, raw(otherOrg, noted)]);
      const day = dayOf(await read(), '2026-06-06');
      expect(day).toMatchObject(UNCHANGED);
      expect(day?.reasons.map((reason) => reason.kind)).toEqual(['weekday']);
      await notes.deleteOne({ _id: elsewhere._id });
    });

    it('with no published run, notes change nothing and the read says no_published_forecast', async () => {
      const bare = await addLocation(server, { orgId, name: 'Unforecast Room' });
      await save(event({}), bare);
      expect(await read('?from=2026-06-01&to=2026-06-14', bare)).toEqual({
        available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], notCovered: [{ from: '2026-06-01', to: '2026-06-14' }],
      });
    });
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

// U13B. Last in the file: it moves the clock into the evening of June 1 in Hanover (June 2 in UTC).
describe('the forecast read’s today', () => {
  it('is the town’s local day, so a day still under way there is not yet past', async () => {
    await removeStaffFactor(server);
    const staff = await signInStaff(server);
    const evening = await addLocation(server, { orgId, name: 'Evening Room' });
    await addSalesDay(server, { orgId, locationId: evening, date: '2026-06-01', guests: 100, netSalesCents: 100_000 });
    const file = {
      ...(JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as Record<string, unknown>),
      dataThrough: '2026-05-31', madeAt: '2026-06-01',
      days: [{ date: '2026-06-01', status: 'open', low: 80, mid: 100, high: 120, baseline: null, reasons: [] }], weeks: [],
    };
    const imported = await call(server, `/api/admin/orgs/${orgId}/locations/${evening}/forecast-runs`, { session: staff, json: file });
    expect(imported.status).toBe(201);
    const runId = (await imported.json() as { run: { id: string } }).run.id;
    expect((await call(server, `/api/admin/orgs/${orgId}/forecast-runs/${runId}/publish`, { session: staff, json: {} })).status).toBe(200);
    await removeStaffFactor(server);
    // 02:00 UTC on June 2 is 22:00 on June 1 in Hanover.
    server.clock.advance(14 * 60 * MINUTE);
    // A fresh session: the first one's token has expired by now.
    const email = `evening-${randomUUID().slice(0, 8)}@example.test`;
    const later = await signIn(server, email);
    await addSeat(server, { orgId, userId: later.userId, email });
    const res = await call(server, `/api/org/locations/${evening}/forecast?from=2026-06-01&to=2026-06-01`, { session: later });
    expect(res.status).toBe(200);
    expect((await res.json() as ForecastWindow).days).toEqual([expect.objectContaining({ date: '2026-06-01', actual: null, inRange: null })]);
    const about = await (await call(server, `/api/org/locations/${evening}/estimates/about`, { session: later })).json() as EstimatesAbout;
    expect(about.today.date).toBe('2026-06-01');
  });
});
