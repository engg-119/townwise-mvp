// GET .../people-in-town and GET .../estimates/about (spec 10.13, 13.2): Hanover's term state and calendar with no
// headcount until its inputs are researched, a synthetic researched entry giving a range, a seasonal town and a town
// outside the twelve, the model card with no forecast, strict ranges, 404 across organizations, view-as reads, and
// no log line of their own. U13B: the published forecast (drafts and withdrawn runs invisible, the newest eligible
// run per date, actuals and live accuracy) and the model card's run state. Spec 14.5: saved notes adjusting the read
// from today on, past days, accuracy and weeks kept honest, and no other tenant's notes. A stored owner calendar event
// changes neither the forecast nor people in town (openspec change connect-owner-calendar). Every figure is synthetic.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { daysBetween, utcDay } from '../src/dates.ts';
import { MODEL_CARD, MODEL_CARD_VERSION, type EstimatesAbout } from '../src/estimates/about.ts';
import { eachDay, runFileSha256, type ForecastRunFile } from '../src/forecasts/file.ts';
import { createForecastReader, type ForecastWindow } from '../src/forecasts/reader.ts';
import { rowsOf } from '../src/handlers/forecast-runs.ts';
import type { PeopleInTownWindow } from '../src/people-in-town/estimate.ts';
import type { PeopleData } from '../src/people-in-town/sources.ts';
import type { Town } from '../src/towns.ts';
import { addGrant, addLocation, addNote, addOwnerCalendar, addSalesDay, addSeat, createOrg } from './helpers/fixtures.ts';
import { runDays } from './helpers/lab.ts';
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

  async function staffImport(body: unknown, locationId = forecasted): Promise<string> {
    const res = await call(server, `/api/admin/orgs/${orgId}/locations/${locationId}/forecast-runs`, { session: staff, json: body });
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
    const none = {
      available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], accuracy: null, notCovered: [{ from: '2026-05-01', to: '2026-05-14' }],
    };
    expect(await forecast()).toEqual(none);
    first = await staffImport(RUN);
    expect(await forecast()).toEqual(none);
    expect((await about()).forecast).toEqual({ run: null, live: null });
  });

  it('once published: every day with its range, reasons in words, actuals, and the run’s own week rows', async () => {
    await staffChange(first, 'publish');
    const body = await forecast();
    expect(body).toMatchObject({ available: true, reason: null, notCovered: [] });
    expect(body.runs).toEqual([expect.objectContaining({
      id: first, engine: 'model', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
    })]);
    expect(body.days).toHaveLength(14);
    expect(body.days[0]).toEqual({
      date: '2026-05-01', weekday: 'Fri', status: 'open', low: 80, mid: 100, high: 120, baseline: null,
      reasons: [
        { kind: 'weekday', label: 'Friday', effectPct: null, effect: null, sources: [], note: null, rule: null },
        { kind: 'term', label: 'Spring term classes', effectPct: null, effect: null, sources: expect.any(Array) as unknown, note: null, rule: null },
      ],
      runId: first, madeAt: '2026-05-01', madeAfterDay: false, actual: 100, inRange: true, scored: true,
      model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 0, moreNotes: 0, moreRules: 0,
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
    // The window's own accuracy (D42): the same six days, the closed May 4 and the days with no guests yet not scored.
    expect(body.accuracy).toEqual(body.runs[0]?.live);
    expect(body.days.filter((day) => day.scored).map((day) => day.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-05', '2026-05-06', '2026-05-07']);
    // Under 5 scored days a window has no accuracy, and its days are still scored.
    const three = await forecast('?from=2026-05-01&to=2026-05-04');
    expect([three.accuracy, three.days.map((day) => day.scored)]).toEqual([null, [true, true, true, false]]);
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
    expect(body.runs.map((run) => run.engine)).toEqual(['model', 'model']);
    // The window scores each day against the run the reader chose for it: here the first run's six days.
    expect(body.accuracy).toEqual({ days: 6, inRange: 5, typicalErrorPct: 4.8, from: '2026-05-01', to: '2026-05-07' });
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

  it('compares a past day only with a run made by that day (D49): a later run fills a day, never scores it', async () => {
    async function room(name: string): Promise<{ id: string; read: () => Promise<ForecastWindow> }> {
      const id = await addLocation(server, { orgId, name });
      for (const [date, guests] of [['2026-05-01', 100], ['2026-05-02', 100], ['2026-05-03', 100], ['2026-05-05', 100], ['2026-05-06', 130], ['2026-05-07', 100]] as const) {
        await addSalesDay(server, { orgId, locationId: id, date, guests, netSalesCents: guests * 1000 });
      }
      const read = async (): Promise<ForecastWindow> => await (await call(server, `/api/org/locations/${id}/forecast?from=2026-05-01&to=2026-05-14`, { session: member })).json() as ForecastWindow;
      return { id, read };
    }
    // Made May 10 on the same data (through April 30), so it never saw May 1 to 9 but came after them.
    const late = { ...structuredClone(RUN), madeAt: '2026-05-10', days: structuredClone(RUN.days).map((day) => (day.mid === null ? day : { ...day, low: 90, mid: 110, high: 130 })) };
    // Alone, the later run fills every day, but no day before May 10 is scored or said to be in its range.
    const only = await room('Late Room');
    const lateOnly = await staffImport(late, only.id);
    await staffChange(lateOnly, 'publish');
    const alone = await only.read();
    expect(alone.days.find((day) => day.date === '2026-05-06')).toMatchObject({ runId: lateOnly, mid: 110, actual: 130, inRange: null, scored: false, madeAfterDay: true });
    // A run made on the day counts as made by it, as the Calendar reads madeAt (TownwiseAI and the Calendar agree).
    expect(alone.days.find((day) => day.date === '2026-05-10')).toMatchObject({ madeAfterDay: false });
    expect(alone.days.filter((day) => day.scored)).toEqual([]);
    expect([alone.accuracy, alone.runs[0]?.live]).toEqual([null, null]);
    expect(alone.weeks.find((week) => week.from === '2026-05-01')).toMatchObject({ runId: lateOnly, actual: 300, inRange: null });
    // With a run made by each day published first, the later one, though newer, leaves it the days before May 10.
    const two = await room('Two Runs Room');
    const early = await staffImport(RUN, two.id);
    await staffChange(early, 'publish');
    const lateId = await staffImport(late, two.id);
    await staffChange(lateId, 'publish');
    const both = await two.read();
    expect(both.days.filter((day) => day.runId === early).map((day) => day.date)).toEqual([
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09',
    ]);
    expect(both.days.find((day) => day.date === '2026-05-06')).toMatchObject({ runId: early, mid: 100, actual: 130, inRange: false, scored: true });
    expect(both.days.find((day) => day.date === '2026-05-10')).toMatchObject({ runId: lateId, mid: 110 });
    expect(both.accuracy).toEqual({ days: 6, inRange: 5, typicalErrorPct: 4.8, from: '2026-05-01', to: '2026-05-07' });
  });

  it('a range the forecast doesn’t reach says which days it doesn’t cover', async () => {
    const body = await forecast('?from=2026-05-12&to=2026-05-20');
    expect(body).toMatchObject({ available: true, notCovered: [{ from: '2026-05-15', to: '2026-05-20' }] });
    expect(await forecast('?from=2026-05-20&to=2026-05-25')).toMatchObject({ available: false, reason: 'not_covered', days: [] });
  });

  it('answers 400 for more than 92 days, a start more than 400 days back, or an extra key', async () => {
    for (const query of ['?from=2026-05-01&to=2026-08-01', '?from=2025-04-26&to=2025-05-01', '?from=2026-05-01&to=2026-05-02&x=1', '']) {
      const res = await call(server, `/api/org/locations/${forecasted}/forecast${query}`, { session: member });
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
    }
    // 92 days, today and the next 91 (D42), is one read, and so is a six-week calendar grid.
    expect((await call(server, `/api/org/locations/${forecasted}/forecast?from=2026-05-01&to=2026-07-31`, { session: member })).status).toBe(200);
    expect((await call(server, `/api/org/locations/${forecasted}/forecast?from=2026-05-01&to=2026-06-11`, { session: member })).status).toBe(200);
  });

  it('names a seasonal_baseline run the baseline, in the read and on the model card (D42)', async () => {
    const room = await addLocation(server, { orgId, name: 'Baseline Room' });
    const runId = await staffImport({ ...structuredClone(RUN), model: { ...(RUN.model as Record<string, unknown>), family: 'seasonal_baseline' } }, room);
    await staffChange(runId, 'publish');
    const res = await call(server, `/api/org/locations/${room}/forecast?from=2026-05-01&to=2026-05-14`, { session: member });
    const body = await res.json() as ForecastWindow;
    const label = 'Townwise\'s baseline from your recent weeks and the town calendar';
    expect(body.runs).toEqual([expect.objectContaining({ id: runId, engine: 'baseline', model: { family: 'seasonal_baseline', version: 'v9', label } })]);
    const card = await (await call(server, `/api/org/locations/${room}/estimates/about`, { session: member })).json() as EstimatesAbout;
    expect(card.forecast.run).toMatchObject({ id: runId, engine: 'baseline', model: { label } });
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

  // Spec 14.4: from the town's today (June 1 in Hanover) on, each run reason says whether it usually brings more or
  // fewer guests: the model's effect where the run recorded one, otherwise the location's own last 52 weeks.
  describe('reason effects', () => {
    /** May 25 to June 14, each day a weekday reason; June 6 also an unnamed event the run gave a 30% effect. */
    const EFFECT_RUN = {
      ...structuredClone(RUN), dataThrough: '2026-05-24', madeAt: '2026-05-25', weeks: [],
      days: Array.from({ length: 21 }, (_, plus) => utcDay(new Date('2026-05-25T00:00:00.000Z'), plus)).map((date) => ({
        date, status: 'open', low: 80, mid: 100, high: 120, baseline: null,
        reasons: [{ kind: 'weekday', ref: null, effectPct: null }, ...(date === '2026-06-06' ? [{ kind: 'event', ref: null, effectPct: 30 }] : [])],
      })),
    };
    let effects: string;

    beforeAll(async () => {
      effects = await addLocation(server, { orgId, name: 'Effects Room' });
      // From April 6, 2025 (the 8 weeks before the history) to May 31, 2026: Saturdays 170 guests, other days 100. The
      // Saturday a closure note covers had 999, and is left out, as a likely-closed one would be.
      const rows = [];
      for (let date = '2025-04-06'; date <= '2026-05-31'; date = utcDay(new Date(`${date}T00:00:00.000Z`), 1)) {
        const guests = date === '2026-05-02' ? 999 : new Date(`${date}T00:00:00.000Z`).getUTCDay() === 6 ? 170 : 100;
        rows.push({
          orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(effects), date, guests, netSalesCents: guests * 1000,
          uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
        });
      }
      await server.connection.collection('tw_sales_days').insertMany(rows);
      await addNote(server, { orgId, locationId: effects, detail: 'Closed for a sentinel party', startDate: '2026-05-02' });
      const imported = await call(server, `/api/admin/orgs/${orgId}/locations/${effects}/forecast-runs`, { session: staff, json: EFFECT_RUN });
      expect(imported.status).toBe(201);
      await staffChange((await imported.json() as { run: { id: string } }).run.id, 'publish');
    });

    it('from today on, a weekday usually beats or trails the average day, from history; the run’s own effect is the model’s', async () => {
      const res = await call(server, `/api/org/locations/${effects}/forecast?from=2026-05-25&to=2026-06-14`, { session: member });
      expect(res.status).toBe(200);
      const body = await res.json() as ForecastWindow;
      const reasonsOn = (date: string) => body.days.find((day) => day.date === date)?.reasons.map((reason) => [reason.label, reason.effect]);
      // 51 Saturdays of 170 against about 110 a day: 55% more. Fridays of 100: 10% fewer. The average open day, which a
      // weekday's effect carries, is (51 × 170 + 312 × 100) / 363 open days, 109.8, so 110; the model's carries none.
      expect(reasonsOn('2026-06-06')).toEqual([
        ['Saturday', { direction: 'more', pct: 55, basis: 'history', days: 51, averageGuests: 110 }],
        ['Town event', { direction: 'more', pct: 30, basis: 'model', days: null, averageGuests: null }],
      ]);
      expect(reasonsOn('2026-06-05')).toEqual([['Friday', { direction: 'fewer', pct: 10, basis: 'history', days: 52, averageGuests: 110 }]]);
      // A day before today keeps its reasons without an effect.
      expect(reasonsOn('2026-05-30')).toEqual([['Saturday', null]]);
      expect(JSON.stringify(body)).not.toContain('sentinel');
    });
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
        { kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, effect: null, sources: [], note: { id: noteId, guests: 70, outcome: 'added' }, rule: null },
        // One Saturday of history is too little to say how Saturdays usually run.
        { kind: 'weekday', label: 'Saturday', effectPct: null, effect: null, sources: [], note: null, rule: null },
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

    it('a buyout note books the day; a closure note closes it; the week holding either loses that day’s model middle', async () => {
      await save(event({ startDate: '2026-06-09', endDate: '2026-06-09', effect: 'closed', expectedGuests: 50 }));
      await save({ kind: 'closure', startDate: '2026-06-03', endDate: '2026-06-03', effect: 'closed', detail: SECRET });
      const body = await read();
      expect(dayOf(body, '2026-06-09')).toMatchObject({
        status: 'booked', low: null, mid: null, high: null, model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 50,
      });
      expect(dayOf(body, '2026-06-09')?.reasons[0]).toMatchObject({ kind: 'note', label: 'Your private buyout, 50 guests', note: { guests: 50, outcome: 'booked' } });
      expect(dayOf(body, '2026-06-03')).toMatchObject({ status: 'closed', low: null, mid: null, high: null, noteGuests: 0 });
      expect(dayOf(body, '2026-06-03')?.reasons[0]).toMatchObject({ kind: 'note', label: 'Your closure', note: { guests: null, outcome: 'closed' } });
      // Each week shifts by the closed or booked day's 100, the buyout's party no walk-in.
      expect(body.weeks.map((week) => [week.from, week.openDays, week.low, week.mid, week.high, week.noteGuests])).toEqual([
        ['2026-05-25', 7, 560, 700, 840, 0], ['2026-06-01', 6, 460, 600, 740, 0], ['2026-06-08', 6, 460, 600, 740, 0],
      ]);
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

    describe('business rules with a schedule (D31)', () => {
      const RULE_TEXT = 'Sentinel rule for the sentinel-family dinners';
      const rulesPath = (location = noted) => `/api/org/locations/${location}/rules`;
      const schedule = (fields: Record<string, unknown>) => ({
        kind: 'closure', startDate: '2026-05-01', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
        ...fields,
      });
      async function addRule(text: string, ruleSchedule: unknown, location = noted): Promise<string> {
        const res = await call(server, rulesPath(location), { session: member, json: { text, schedule: ruleSchedule } });
        expect(res.status).toBe(201);
        return (await res.json() as { rule: { id: string } }).rule.id;
      }
      beforeEach(async () => { await server.connection.collection('tw_business_rules').deleteMany({ locationId: new Types.ObjectId(noted) }); });

      it('closed Mondays closes every Monday from today on with a rule reason worded from the schedule; taking the schedule off restores them', async () => {
        const ruleId = await addRule(RULE_TEXT, schedule({}));
        const body = await read();
        for (const monday of ['2026-06-01', '2026-06-08']) {
          expect(dayOf(body, monday)).toMatchObject({ status: 'closed', low: null, mid: null, high: null, model: { status: 'open', low: 80, mid: 100, high: 120 } });
          expect(dayOf(body, monday)?.reasons[0]).toEqual({
            kind: 'rule', label: 'Your rule: closed on Mondays', effectPct: null, effect: null, sources: [], note: null, rule: { id: ruleId, guests: null, outcome: 'closed' },
          });
        }
        // A past Monday keeps the model's figures, and a week a rule closed a day in loses that day's model middle.
        expect(dayOf(body, '2026-05-25')).toMatchObject({ ...UNCHANGED, reasons: [expect.objectContaining({ kind: 'weekday' }), expect.objectContaining({ rule: { id: ruleId, guests: null, outcome: 'past_day' } })] });
        expect(dayOf(body, '2026-06-02')).toMatchObject(UNCHANGED);
        expect(body.weeks.map((week) => [week.from, week.openDays, week.mid])).toEqual([['2026-05-25', 7, 700], ['2026-06-01', 6, 600], ['2026-06-08', 6, 600]]);
        // A one-day opening note beats the standing rule: that Monday is open again, with the model's figures.
        await save({ kind: 'opening', startDate: '2026-06-08', endDate: '2026-06-08', effect: 'unknown', detail: SECRET });
        const opened = await read();
        expect(dayOf(opened, '2026-06-08')).toMatchObject(UNCHANGED);
        expect(dayOf(opened, '2026-06-08')?.reasons.find((reason) => reason.kind === 'rule')).toMatchObject({ rule: { id: ruleId, outcome: 'overridden' } });
        expect(opened.weeks.map((week) => week.mid)).toEqual([700, 600, 700]);
        expect(JSON.stringify(body)).not.toContain('entinel');
        const res = await call(server, `${rulesPath()}/${ruleId}`, { method: 'PATCH', session: member, json: { schedule: null } });
        expect(res.status).toBe(200);
        const after = await read();
        expect(dayOf(after, '2026-06-08')).toMatchObject(UNCHANGED);
        expect(after.weeks).toHaveLength(3);
      });

      it('a rule’s party and a note’s on the same day add up; a closure from either wins; a rule without a schedule changes nothing', async () => {
        await addRule('Rehearsal dinners on Saturdays', schedule({ kind: 'private_event', effect: 'more_guests', expectedGuests: 40, weekdays: [6] }));
        await addRule('We are a cozy place', null);
        await save(event({}));
        await save({ kind: 'closure', startDate: '2026-06-13', endDate: '2026-06-13', effect: 'closed', detail: SECRET });
        const body = await read();
        expect(dayOf(body, '2026-06-06')).toMatchObject({ status: 'open', low: 190, mid: 210, high: 230, noteGuests: 110 });
        expect(dayOf(body, '2026-06-06')?.reasons.map((reason) => [reason.kind, reason.rule?.outcome ?? reason.note?.outcome ?? null])).toEqual([
          ['rule', 'added'], ['note', 'added'], ['weekday', null],
        ]);
        expect(dayOf(body, '2026-06-13')).toMatchObject({ status: 'closed', noteGuests: 0 });
        expect(dayOf(body, '2026-06-13')?.reasons.map((reason) => reason.rule?.outcome ?? reason.note?.outcome ?? null)).toEqual(['closed', null, 'day_closed']);
        // The week of June 1 shifts by the rule's 40 on June 6 and the note's 70; the week of June 8 loses closed June 13's 100.
        expect(body.weeks.map((week) => [week.from, week.mid, week.noteGuests])).toEqual([['2026-05-25', 700, 0], ['2026-06-01', 810, 110], ['2026-06-08', 600, 0]]);
        expect(dayOf(body, '2026-06-05')).toMatchObject(UNCHANGED);
      });

      it('another location’s or organization’s scheduled rule never changes this location’s forecast', async () => {
        const otherOrg = await createOrg(server, { name: 'Other Ruled Kitchen' });
        const raw = (org: string, location: string) => ({
          _id: new Types.ObjectId(), orgId: new Types.ObjectId(org), locationId: new Types.ObjectId(location), text: 'Closed every day',
          key: `closed every day ${new Types.ObjectId().toHexString()}`, addedVia: 'page', createdBy: 'fixture',
          schedule: schedule({ weekdays: null }), createdAt: server.clock.now(), updatedAt: server.clock.now(),
        });
        const rules = server.connection.collection('tw_business_rules');
        const elsewhere = raw(orgId, hanover);
        const foreign = raw(otherOrg, noted);
        await rules.insertMany([elsewhere, foreign]);
        const body = await read();
        expect(body.days.every((day) => day.status === 'open' && day.reasons.every((reason) => reason.kind === 'weekday'))).toBe(true);
        await rules.deleteMany({ _id: { $in: [elsewhere._id, foreign._id] } });
      });
    });

    it('with no published run, notes change nothing and the read says no_published_forecast', async () => {
      const bare = await addLocation(server, { orgId, name: 'Unforecast Room' });
      await save(event({}), bare);
      expect(await read('?from=2026-06-01&to=2026-06-14', bare)).toEqual({
        available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], accuracy: null, notCovered: [{ from: '2026-06-01', to: '2026-06-14' }],
      });
    });
  });

  it('a stored calendar event on a future day that no note covers leaves that day’s forecast and people in town as they were', async () => {
    // The owner-calendar spec's "Event without a note". The fixture calendar's events fall on November 2 and 3.
    const booked = await addLocation(server, { orgId, name: 'Booked Room' });
    const open = { status: 'open', low: 80, mid: 100, high: 120, baseline: null, reasons: [] };
    const days = [{ date: '2026-11-02', ...open }, { date: '2026-11-03', ...open }];
    await staffChange(await staffImport({ ...structuredClone(RUN), dataThrough: '2026-05-31', madeAt: '2026-06-01', days, weeks: [] }, booked), 'publish');
    const range = '?from=2026-11-02&to=2026-11-03';
    const reads = async (): Promise<unknown[]> => [
      await (await call(server, `/api/org/locations/${booked}/forecast${range}`, { session: member })).json() as ForecastWindow,
      await window(booked, '2026-11-02', '2026-11-03'),
    ];
    const before = await reads();
    expect(before[0]).toMatchObject({ available: true, days: [{ date: '2026-11-02', mid: 100 }, { date: '2026-11-03', mid: 100 }] });
    await addOwnerCalendar(server, { orgId, locationId: booked });
    const stored = await (await call(server, `/api/org/locations/${booked}/owner-calendars/events${range}`, { session: member })).json() as { events: unknown[] };
    expect(stored.events).toHaveLength(2);
    expect(await reads()).toEqual(before);
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
describe('the forecast reader with a year of weekly runs (D42)', () => {
  it('reads rows by a bounded range, and answers exactly as a reader that reads every row', async () => {
    const locationId = await addLocation(server, { orgId, name: `Weekly Room ${randomUUID().slice(0, 6)}` });
    const scope = { orgId } as OrgScope;
    const today = '2026-06-01';
    // Synthetic guests on every day for a year and a quarter, a closure note on one of them
    await server.connection.collection('tw_sales_days').insertMany(eachDay('2025-03-01', '2026-05-31').map((date, index) => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date, guests: 60 + (index % 7) * 9 + (index % 5),
      netSalesCents: null, uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
    })));
    await addNote(server, { orgId, locationId, detail: 'Closed for a staff party', startDate: '2026-04-18' });
    // 52 published weekly runs, each reaching 91 days past its last day of data, each a little different
    for (let week = 0; week < 52; week += 1) {
      const dataThrough = utcDay(new Date('2025-06-01T00:00:00.000Z'), 7 * week);
      const { days, weeks } = runDays(dataThrough, 91);
      const mid = 60 + (week % 9);
      const file: ForecastRunFile = {
        schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'seasonal_baseline', version: 'v7', notebookCommit: 'abcdef0' },
        trainingSource: 'files_from_owner', trainedFrom: '2025-03-01', dataThrough, madeAt: utcDay(new Date(`${dataThrough}T00:00:00.000Z`), 1),
        frozen: null, interval: { level: 0.8, widened: true }, backtest: null,
        days: days.map((day) => ({ ...day, low: mid - 12, mid, high: mid + 15, baseline: mid })),
        weeks: weeks.map((each) => ({ ...each, low: (mid - 12) * each.openDays, mid: mid * each.openDays, high: (mid + 15) * each.openDays })),
      };
      const { run } = await server.ctx.stores.forecasts.upsertRun(scope, locationId, {
        id: new Types.ObjectId().toHexString(), file, fileSha256: runFileSha256(file), importedBy: 'staff-0000', lab: null, now: server.clock.now(),
      });
      await server.ctx.stores.forecasts.writeRows(scope, locationId, run.id, rowsOf(file, 'hanover-nh'));
      await server.ctx.stores.forecasts.setStatus(scope, run.id, { from: ['importing'], to: 'published', at: server.clock.now(), by: 'staff-0000' });
    }
    const location = await server.ctx.stores.locations.find(scope, locationId);
    if (location === null) throw new Error('no location');
    const stores = server.ctx.stores;
    const asked: ({ from: string; to: string } | undefined)[] = [];
    const counted: number[] = [];
    const ranged = createForecastReader({
      stores: {
        ...stores,
        forecasts: {
          ...stores.forecasts,
          rows: async (...args: Parameters<typeof stores.forecasts.rows>) => {
            asked.push(args[3]);
            const rows = await stores.forecasts.rows(...args);
            counted.push(rows.length);
            return rows;
          },
        },
      },
    });
    // Today's reader, which reads every row of every run
    const unranged = createForecastReader({
      stores: { ...stores, forecasts: { ...stores.forecasts, rows: (s, id, runIds) => stores.forecasts.rows(s, id, runIds) } },
    });
    const all = await stores.forecasts.rows(scope, locationId, (await stores.forecasts.published(scope, locationId)).map((run) => run.id));
    for (const range of [
      { from: '2026-05-11', to: '2026-06-21' }, // last weeks and the next three: 42 days
      { from: '2025-12-01', to: '2026-01-11' }, // in the past, every day scored
      { from: '2026-06-01', to: '2026-08-31' }, // the next 92 days
    ]) {
      asked.length = 0;
      counted.length = 0;
      const answer = await ranged.window(scope, location, range, today);
      expect(answer.available).toBe(true);
      expect(answer).toEqual(await unranged.window(scope, location, range, today));
      // Bounded: the window, a week either side, and the days of the runs it uses
      expect(asked.length).toBeGreaterThan(0);
      for (const bound of asked) {
        if (bound === undefined) return expect.unreachable('every read is ranged');
        expect(daysBetween(bound.from, bound.to)).toBeLessThanOrEqual(daysBetween(range.from, range.to) + 2 * 91 + 12);
      }
      // Every day is in about 13 weekly runs, so a span's rows grow with its days, never with the number of runs
      expect(Math.max(...counted)).toBeLessThan(all.length);
    }
    asked.length = 0;
    expect(await ranged.latest(scope, locationId, today)).toEqual(await unranged.latest(scope, locationId, today));
    expect(asked.every((bound) => bound !== undefined && daysBetween(bound.from, bound.to) <= 91)).toBe(true);
  });
});

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
