// TownwiseAI's estimate tools (spec 13.2, docs/portal/estimates.md), without Docker: get_town_calendar and
// get_people_in_town validate their ranges, give every dated row its weekday, say honestly what is missing, show
// only dates, counts and source links on their cards, and never put an email, a person's id, a note author or a file
// name in front of the model. Synthetic data only.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { inputViewOf, resultViewOf, toolNamed, type ToolContext } from '../src/chat/tools/registry.ts';
import { createForecastReader, MAX_FORECAST_RANGE_DAYS, type ForecastReader } from '../src/forecasts/reader.ts';
import { createPeopleInTownReader } from '../src/people-in-town/reader.ts';
import type { PeopleData } from '../src/people-in-town/sources.ts';
import type { BusinessRuleRecord, BusinessRuleStore } from '../src/stores/business-rules.ts';
import type { ForecastRow, ForecastRunRecord, ForecastStore } from '../src/stores/forecasts.ts';
import type { LocationRecord } from '../src/stores/locations.ts';
import type { NoteRecord, NoteStore } from '../src/stores/notes.ts';
import type { SalesDay, SalesDayStore, SalesDayWithUpload } from '../src/stores/sales-days.ts';
import type { Town } from '../src/towns.ts';

const TODAY = '2026-11-05';
const SENTINEL_EMAIL = 'sentinel-owner@example.test';
const SENTINEL_USER = 'sentinel-user-id-0001';
const SENTINEL_FILE = 'sentinel-export.csv';
const SENTINEL_UPLOAD = 'sentinel-upload-id-0001';

const HANOVER: Town = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };

function location(town: Town = HANOVER): LocationRecord {
  return { id: '000000000000000000000001', name: 'Test Taproom', town, placeId: null, createdAt: new Date('2026-01-01T00:00:00Z') };
}

function saturdays(from: string, count: number, guests: number): SalesDayWithUpload[] {
  const out: SalesDayWithUpload[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10);
    out.push({ date, guests, netSalesCents: guests * 2000, uploadId: SENTINEL_UPLOAD });
  }
  return out;
}

/** U13B: a published run with synthetic numbers, and its rows; staff ids and the run file never leave the store. */
function publishedRun(fields: Partial<ForecastRunRecord> = {}): ForecastRunRecord {
  return {
    id: '000000000000000000000010', locationId: '000000000000000000000001', metric: 'guests',
    model: { family: 'hybrid_linear_xgboost', version: 'v9', notebookCommit: '0000000' }, trainingSource: 'files_from_owner',
    trainedFrom: '2025-01-01', dataThrough: '2026-10-31', madeAt: '2026-11-01', frozen: true, interval: { level: 0.8, widened: true },
    backtest: { from: '2026-01-05', to: '2026-03-15', weeks: 10, weeklyTypicalErrorPct: 10, weeksOver20Pct: 1, weeklyRangePct: null },
    range: { from: '2026-11-01', to: '2026-11-30' }, dayCount: 30, weekCount: 0, status: 'published', importedBy: SENTINEL_USER,
    importedAt: new Date('2026-11-01T00:00:00Z'), publishedAt: new Date('2026-11-01T00:00:00Z'), withdrawnAt: null, lab: null, ...fields,
  };
}

function dayRow(date: string, fields: Partial<ForecastRow> = {}): ForecastRow {
  return {
    runId: '000000000000000000000010', span: 'day', from: date, to: date, status: 'open', low: 80.6, mid: 100.4, high: 119.2,
    baseline: null, openDays: null, reasons: [{ kind: 'weekday', ref: null, effectPct: null }], ...fields,
  };
}

const NO_NOTES = { overlapping: () => Promise.resolve([]) };
const NO_RULES = { scheduled: () => Promise.resolve([]) };

function forecastStores(
  rows: readonly ForecastRow[], runs: readonly ForecastRunRecord[] = rows.length === 0 ? [] : [publishedRun()], saved: readonly NoteRecord[] = [],
  rules: readonly BusinessRuleRecord[] = [],
) {
  const forecasts = {
    published: () => Promise.resolve([...runs]),
    rows: () => Promise.resolve([...rows]),
  } as unknown as ForecastStore;
  const salesDays = { days: () => Promise.resolve([{ date: '2026-11-02', guests: 140, netSalesCents: 1 }]) } as unknown as SalesDayStore;
  return {
    forecasts, salesDays, notes: saved.length === 0 ? NO_NOTES : { overlapping: () => Promise.resolve([...saved]) },
    businessRules: { scheduled: () => Promise.resolve([...rules]) },
  };
}

const NOTE_DETAIL = 'Sentinel rehearsal dinner for the Smith party';
const NOTE_ID = '0000000000000000000000aa';

/** A saved note with synthetic content; its detail and id must never reach the model through get_forecast. */
function savedNote(fields: Partial<NoteRecord> & Pick<NoteRecord, 'startDate'>): NoteRecord {
  return {
    id: NOTE_ID, kind: 'private_event', endDate: fields.startDate, weekdays: null, effect: 'more_guests', expectedGuests: 70,
    detail: NOTE_DETAIL, title: null, startTime: '18:00', endTime: '21:00', createdBy: SENTINEL_USER, byStaff: false, source: null, fromEvent: null, agent: null,
    createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z'), ...fields,
  };
}

function context(opts: {
  data?: PeopleData; town?: Town; forecasts?: ForecastReader; days?: SalesDayWithUpload[]; rules?: readonly BusinessRuleRecord[];
} = {}): ToolContext {
  const notes: NoteRecord[] = [{
    id: '000000000000000000000002', kind: 'private_event', startDate: '2026-10-10', endDate: '2026-10-10', weekdays: null,
    effect: 'more_guests', expectedGuests: null, detail: `Party booked by ${SENTINEL_EMAIL} from ${SENTINEL_FILE}`,
    title: null, startTime: null, endTime: null, createdBy: SENTINEL_USER, byStaff: false, source: null, fromEvent: null, agent: null, createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  }];
  const days = opts.days ?? [...saturdays('2026-09-19', 8, 200), ...saturdays('2025-12-06', 3, 90)];
  const stores = {
    salesDays: { history: () => Promise.resolve(days.sort((a, b) => (a.date < b.date ? -1 : 1))) } as unknown as SalesDayStore,
    notes: { list: () => Promise.resolve(notes) } as unknown as NoteStore,
    businessRules: { scheduled: () => Promise.resolve([...(opts.rules ?? [])]) } as unknown as BusinessRuleStore,
  };
  const reader = createPeopleInTownReader({ stores, data: opts.data ?? { sources: [], towns: [] } });
  const ctx = { ports: { peopleInTown: reader, forecasts: opts.forecasts ?? createForecastReader({ stores: forecastStores([]) }) } } as unknown as TownwiseContext;
  const scope = { orgId: '000000000000000000000003' } as unknown as OrgScope;
  return { ctx, scope, location: location(opts.town), today: TODAY, timeZone: 'America/New_York', role: 'member',
    actor: { actorUserId: SENTINEL_USER, actorEmail: 'member@example.test', actorRole: 'member', viewAsGrantId: null }, turn: { readUntrusted: false, readWeb: false, pictureBytes: 0 },
    files: { attached: new Set(), by: 0, bytes: { reserve: () => false, release: () => undefined }, sent: new Map() } };
}

async function run(name: string, input: unknown, tc: ToolContext = context()): Promise<{ content: string; parsed: Record<string, unknown> }> {
  const tool = toolNamed(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  const parsed = tool.parse(input, TODAY);
  if (parsed === null) throw new Error('invalid input');
  const { content } = await tool.run(tc, parsed);
  return { content, parsed: JSON.parse(content) as Record<string, unknown> };
}

const ok = (content: string) => ({ type: 'tool_result' as const, tool_use_id: 't1', content });

describe('input rules', () => {
  const parse = (name: string, input: unknown) => toolNamed(name)?.parse(input, TODAY) ?? null;

  it('both take { from, to } of at most 92 days, from on or before to, extra keys dropped', () => {
    for (const name of ['get_town_calendar', 'get_people_in_town']) {
      expect(parse(name, { from: '2026-11-01', to: '2027-01-31' })).toEqual({ from: '2026-11-01', to: '2027-01-31' });
      expect(parse(name, { from: '2026-11-01', to: '2027-02-01' })).toBeNull();
      expect(parse(name, { from: '2026-11-02', to: '2026-11-01' })).toBeNull();
      expect(parse(name, { from: '2026-02-30', to: '2026-03-01' })).toBeNull();
      expect(parse(name, { from: '2026-11-01' })).toBeNull();
      expect(parse(name, { from: '2026-11-01', to: '2026-11-02', extra: 1 })).toEqual({ from: '2026-11-01', to: '2026-11-02' });
      expect(parse(name, { from: '2027-12-01', to: '2027-12-10' })).toEqual({ from: '2027-12-01', to: '2027-12-10' });
      expect(parse(name, { from: '2027-12-01', to: '2027-12-11' })).toBeNull();
    }
  });

  it('people in town starts at most 730 days back; the calendar goes back to 2010', () => {
    expect(parse('get_people_in_town', { from: '2024-11-05', to: '2024-11-30' })).not.toBeNull();
    expect(parse('get_people_in_town', { from: '2024-11-04', to: '2024-11-30' })).toBeNull();
    expect(parse('get_town_calendar', { from: '2010-01-01', to: '2010-01-31' })).not.toBeNull();
    expect(parse('get_town_calendar', { from: '2009-12-31', to: '2010-01-31' })).toBeNull();
  });
});

describe('get_town_calendar', () => {
  it('gives Hanover’s term dates, events and holidays, each row with its weekdays, confidence and sources', async () => {
    const { parsed } = await run('get_town_calendar', { from: '2026-11-15', to: '2026-11-30' });
    expect(parsed).toMatchObject({
      from: '2026-11-15', to: '2026-11-30', town: { name: 'Hanover', state: 'NH' }, researched: true,
      covers: { from: '2025-01-06', to: '2028-06-11' },
    });
    const events = parsed.events as Record<string, unknown>[];
    expect(events.find((event) => event.id === 'hanover-nh:2026-11-20:fall-term-finals')).toEqual({
      id: 'hanover-nh:2026-11-20:fall-term-finals', title: 'Fall term finals', start: '2026-11-20', startWeekday: 'Fri',
      end: '2026-11-25', endWeekday: 'Wed', kind: 'term', scope: 'town', groupLabel: 'Fall term finals', confidence: 'high',
      sources: [{ label: 'Dartmouth Registrar, 2026-27 key dates', url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates' }],
    });
    expect(events.find((event) => event.id === 'us:thanksgiving:2026')).toMatchObject({ startWeekday: 'Thu', kind: 'holiday' });
  });

  it('says researched false, holidays only, for a town Townwise has not researched', async () => {
    const { parsed } = await run('get_town_calendar', { from: '2026-11-01', to: '2026-11-30' }, context({ town: { townId: null, name: 'Woodstock', state: 'VT' } }));
    expect(parsed).toMatchObject({ researched: false, covers: null });
    expect((parsed.events as { kind: string }[]).every((event) => event.kind === 'holiday')).toBe(true);
  });

  it('cards show the range, the town, the event count and at most 5 https source links', async () => {
    expect(inputViewOf('get_town_calendar', { from: '2026-11-15', to: '2026-11-30' }, TODAY)).toEqual({ from: '2026-11-15', to: '2026-11-30' });
    const { content, parsed } = await run('get_town_calendar', { from: '2026-09-01', to: '2026-11-30' });
    const view = resultViewOf('get_town_calendar', ok(content));
    expect(view).toMatchObject({
      from: '2026-09-01', to: '2026-11-30', town: { name: 'Hanover', state: 'NH' }, researched: true,
      eventCount: (parsed.events as unknown[]).length,
    });
    const sources = view?.sources as { host: string; url: string }[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBeLessThanOrEqual(5);
    for (const source of sources) expect(source.url.startsWith('https://')).toBe(true);
  });
});

describe('get_people_in_town', () => {
  it('with no headcount input researched: term states with weekdays, a null headcount with its reason, and the season', async () => {
    const { parsed } = await run('get_people_in_town', { from: '2026-11-15', to: '2026-11-30' });
    expect(parsed).toMatchObject({ available: true, reason: null, town: { name: 'Hanover', state: 'NH', kind: 'college' }, timeZone: 'America/New_York' });
    const periods = parsed.periods as Record<string, unknown>[];
    expect(periods[0]).toMatchObject({ from: '2026-11-15', fromWeekday: 'Sun', termState: 'in_session', termLabel: 'Fall term classes' });
    expect(periods.every((period) => period.headcount === null)).toBe(true);
    expect(new Set(periods.map((period) => period.headcountWhy))).toEqual(new Set(['no_population']));
    expect(periods.map((period) => period.termState)).toEqual(expect.arrayContaining(['in_session', 'unknown', 'finals']));
    expect((parsed.season as { month: string }[]).map((month) => month.month)).toEqual(['2026-11']);
  });

  it('gives the location’s own history by term state and weekday, from its open regular days', async () => {
    const { parsed } = await run('get_people_in_town', { from: '2026-11-01', to: '2026-11-30' });
    const history = parsed.yourHistory as { metric: string; cells: { state: string; weekday: string; days: number; mean: number | null }[] };
    expect(history.metric).toBe('guests');
    // Of eight Saturdays in fall 2026 classes, Sep 26 (Family Weekend), Oct 3 (Homecoming) and Oct 17 (home football)
    // are event days and Oct 10 carries a note. December 2025's three Saturdays fall between terms.
    expect(history.cells).toEqual([
      { state: 'in_session', weekday: 'Sat', days: 4, mean: 200 },
      { state: 'between_terms', weekday: 'Sat', days: 3, mean: 90 },
    ]);
  });

  const inSession = async (days: SalesDayWithUpload[], rules: readonly BusinessRuleRecord[] = []) => {
    const { parsed } = await run('get_people_in_town', { from: '2026-11-01', to: '2026-11-30' }, context({ days, rules }));
    return (parsed.yourHistory as { cells: { state: string; weekday: string }[] }).cells.find((cell) => cell.state === 'in_session');
  };
  /** The fixture's Saturdays with one of them at 1 guest, against Saturdays of 200. */
  const nearEmptyOn = (date: string): SalesDayWithUpload[] => [
    ...saturdays('2026-09-19', 8, 200).map((day) => (day.date === date ? { ...day, guests: 1, netSalesCents: 2000 } : day)),
    ...saturdays('2025-12-06', 3, 90),
  ];

  it('counts a near-empty day in that history only when a business rule’s schedule says it had fewer guests (D32, D31)', async () => {
    // Oct 31 (before today, Nov 5) is likely closed, and left out, until a rule says the day was open.
    const rule: BusinessRuleRecord = {
      id: '0000000000000000000000bb', text: 'Sentinel rule text', addedVia: 'page', createdBy: SENTINEL_USER, byStaff: false,
      createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z'),
      schedule: {
        kind: 'other', effect: 'fewer_guests', startDate: '2026-10-31', endDate: null, weekdays: null,
        expectedGuests: null, startTime: null, endTime: null,
      },
    };
    expect(await inSession(nearEmptyOn('2026-10-31'))).toEqual({ state: 'in_session', weekday: 'Sat', days: 3, mean: 200 });
    expect(await inSession(nearEmptyOn('2026-10-31'), [rule])).toEqual({ state: 'in_session', weekday: 'Sat', days: 4, mean: 150 });
  });

  it('never calls a day on or after the town’s today likely closed in that history, since its upload may be partial (D32)', async () => {
    // Nov 7 is after today (Nov 5): its 1 guest counts as recorded, not as a likely closure.
    expect(await inSession(nearEmptyOn('2026-11-07'))).toEqual({ state: 'in_session', weekday: 'Sat', days: 4, mean: 150 });
  });

  it('answers available false for a town outside the twelve, and visitors_unknown for a seasonal town', async () => {
    const outside = await run('get_people_in_town', { from: '2026-11-01', to: '2026-11-07' }, context({ town: { townId: null, name: 'Woodstock', state: 'VT' } }));
    expect(outside.parsed).toMatchObject({ available: false, reason: 'town_not_researched', season: [] });
    const seasonal = await run('get_people_in_town', { from: '2026-07-01', to: '2026-07-07' }, context({ town: { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' } }));
    expect((seasonal.parsed.periods as { headcountWhy: string }[]).every((period) => period.headcountWhy === 'visitors_unknown')).toBe(true);
  });

  it('gives a headcount range with its sources when the inputs are researched', async () => {
    const data: PeopleData = {
      sources: [{ id: 'census-test', label: 'Synthetic census', url: 'https://census.example.test/p1', retrieved: '2026-11-01', confidence: 'high' }],
      towns: [{
        townId: 'hanover-nh', residents: { value: 10_000, moe90: 500, vintage: '2020', sourceId: 'census-test' }, studentHousing: null,
        enrollment: null, housingClosesBetweenTerms: null, eventAttendance: [], visitors: null,
      }],
    };
    const { content, parsed } = await run('get_people_in_town', { from: '2026-11-02', to: '2026-11-06' }, context({ data }));
    expect((parsed.periods as { headcount: unknown }[])[0]?.headcount).toEqual({ low: 9500, high: 10_500, sourceIds: ['census-test'], excludes: [] });
    expect(resultViewOf('get_people_in_town', ok(content))).toEqual({
      available: true, town: { name: 'Hanover', state: 'NH' }, periods: 1, headcount: 'range',
      sources: [
        { host: 'census.example.test', url: 'https://census.example.test/p1' },
        { host: 'registrar.dartmouth.edu', url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates' },
        { host: 'bls.gov', url: 'https://www.bls.gov/cew/additional-resources/open-data/' },
      ],
    });
  });

  it('cards show the range and counts, never a figure; with no headcount the card says none', async () => {
    expect(inputViewOf('get_people_in_town', { from: '2026-11-01', to: '2026-11-30' }, TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    const { content } = await run('get_people_in_town', { from: '2026-11-01', to: '2026-11-30' });
    const view = resultViewOf('get_people_in_town', ok(content));
    expect(view).toMatchObject({ available: true, town: { name: 'Hanover', state: 'NH' }, headcount: 'none' });
    expect(JSON.stringify(view)).not.toMatch(/"(low|high|mean|countyFoodServiceJobsIndex|guests|netSales)"/);
  });
});

describe('get_forecast (U13B)', () => {
  const parse = (input: unknown) => toolNamed('get_forecast')?.parse(input, TODAY) ?? null;
  const withRows = (
    rows: readonly ForecastRow[], runs?: readonly ForecastRunRecord[], notes: readonly NoteRecord[] = [], rules: readonly BusinessRuleRecord[] = [],
  ) => context({
    forecasts: createForecastReader({ stores: forecastStores(rows, runs, notes, rules) }),
  });

  it('takes { from, to } of at most 92 days, as the forecast route reads (D42), starting at most 92 days back', () => {
    expect(MAX_FORECAST_RANGE_DAYS).toBe(92);
    expect(parse({ from: '2026-11-01', to: '2027-01-31' })).toEqual({ from: '2026-11-01', to: '2027-01-31' });
    expect(parse({ from: '2026-11-01', to: '2027-02-01' })).toBeNull();
    const tool = toolNamed('get_forecast');
    expect(tool?.invalidInput).toContain('at most 92 days apart counting both ends');
    expect(tool?.definition.description).toContain('for a date range of at most 92 days');
    expect(parse({ from: '2026-08-05', to: '2026-08-10' })).not.toBeNull();
    expect(parse({ from: '2026-08-04', to: '2026-08-10' })).toBeNull();
    expect(parse({ from: '2026-11-02', to: '2026-11-01' })).toBeNull();
  });

  it('with no published forecast answers exactly that, and what to use instead', async () => {
    const { parsed, content } = await run('get_forecast', { from: '2026-11-01', to: '2026-11-07' });
    expect(parsed).toEqual({
      available: false, reason: 'Townwise has no forecast for this location yet.', useInstead: 'the location\'s history and the town calendar',
    });
    expect(resultViewOf('get_forecast', ok(content))).toEqual({ available: false, modelVersion: null, madeAt: null, dataThrough: null, days: 0, notCovered: 0 });
  });

  it('rounds each range outward, keeps the middle whole, and gives the model, accuracy, actuals and reasons in words', async () => {
    const tc = withRows([dayRow('2026-11-02'), dayRow('2026-11-03', { status: 'closed', low: null, mid: null, high: null, reasons: [{ kind: 'closure', ref: null, effectPct: null }] })]);
    const { parsed, content } = await run('get_forecast', { from: '2026-11-02', to: '2026-11-04' }, tc);
    expect(parsed).toMatchObject({
      available: true, metric: 'guests',
      model: {
        label: 'Townwise demand model v9', version: 'v9', trainedOn: 'sales exports the owner sent Townwise', trainedFrom: '2025-01-01',
        dataThrough: '2026-10-31', madeAt: '2026-11-01', frozen: true, rangesWidened: true, engine: 'model',
        accuracy: { backtest: { weeks: 10, weeklyTypicalErrorPct: 10, weeksOver20Pct: 1 }, live: null },
      },
      interval: { level: 0.8, meaning: 'About 8 in 10 days should land inside the model\'s own range: a day\'s modelRange when a note changed it, otherwise its low to high. A range that includes guests from notes is not the model\'s.' },
      notCovered: [{ from: '2026-11-04', to: '2026-11-04' }],
    });
    const days = parsed.days as Record<string, unknown>[];
    expect(days[0]).toEqual({
      date: '2026-11-02', weekday: 'Mon', status: 'open', low: 80, mid: 100, high: 120, vsBaselinePct: null,
      reasons: [{ label: 'Monday', effectPct: null, effect: null, sources: [], note: null, rule: null }], modelRange: null, noteGuests: 0,
      moreNotes: 0, moreRules: 0, madeAt: '2026-11-01', madeAfterDay: false, laterNote: false, actual: 140, inRange: false, outlook: false,
    });
    expect(days[1]).toMatchObject({ status: 'closed', low: null, mid: null, high: null, reasons: [{ label: 'Closed' }] });
    expect(resultViewOf('get_forecast', ok(content))).toEqual({
      available: true, modelVersion: 'v9', madeAt: '2026-11-01', dataThrough: '2026-10-31', days: 2, notCovered: 1,
    });
    // D49 as amended: a run made after a day is still compared with it, and a day it may have learned about is not.
    const description = toolNamed('get_forecast')?.definition.description ?? '';
    expect(description).toContain('madeAfterDay is true when the day\'s model was made after the day: its data still ends before the day, so it never saw that day\'s sales and its inRange stands; say the forecast came from sales through that model\'s dataThrough.');
    expect(description).toContain('laterNote is true when that model may have read a private event note or rule about the day written once the day had begun, so the day is not compared (inRange is null); say so plainly.');
  });

  it('names the engine of each run: a seasonal_baseline run is the baseline, with its label (D42)', async () => {
    const runs = [publishedRun({ model: { family: 'seasonal_baseline', version: 'v1', notebookCommit: '0000000' } })];
    const { parsed } = await run('get_forecast', { from: '2026-11-02', to: '2026-11-02' }, withRows([dayRow('2026-11-02')], runs));
    expect(parsed.model).toMatchObject({ engine: 'baseline', label: 'Townwise\'s baseline from your recent weeks and the town calendar', version: 'v1' });
  });

  it('gives each run its own live accuracy, so a newer run is never credited with an older run’s days', async () => {
    const OLDER = '000000000000000000000011';
    const NEWER = '000000000000000000000012';
    const runs = [
      // Each run's range and dayCount are its rows' (the reader chooses by them, D52).
      publishedRun({
        id: NEWER, model: { family: 'hybrid_linear_xgboost', version: 'v10', notebookCommit: '0000000' }, dataThrough: '2026-11-01', madeAt: '2026-11-02',
        backtest: null, range: { from: '2026-11-02', to: '2026-11-05' }, dayCount: 4,
      }),
      publishedRun({ id: OLDER, dataThrough: '2026-10-25', madeAt: '2026-10-26', range: { from: '2026-10-27', to: '2026-11-01' }, dayCount: 6 }),
    ];
    const olderDays = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
    const rows = [
      ...olderDays.map((date) => dayRow(date, { runId: OLDER, low: 80, mid: 100, high: 120 })),
      ...['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((date) => dayRow(date, { runId: NEWER })),
    ];
    const forecasts = { published: () => Promise.resolve(runs), rows: () => Promise.resolve(rows) } as unknown as ForecastStore;
    const salesDays = { days: () => Promise.resolve(olderDays.map((date) => ({ date, guests: date === '2026-10-30' ? 130 : 100, netSalesCents: 1 }))) } as unknown as SalesDayStore;
    const reader = createForecastReader({ stores: { forecasts, salesDays, notes: NO_NOTES, businessRules: NO_RULES } });
    const { parsed } = await run('get_forecast', { from: '2026-10-27', to: '2026-11-05' }, context({ forecasts: reader }));
    expect(parsed.accuracy).toBeUndefined();
    expect(parsed.model).toMatchObject({ version: 'v10', madeAt: '2026-11-02', accuracy: { backtest: null, live: null } });
    expect(parsed.earlierModels).toEqual([expect.objectContaining({
      version: 'v9', madeAt: '2026-10-26',
      accuracy: expect.objectContaining({ live: { days: 6, inRange: 5, typicalErrorPct: 4.8, from: '2026-10-27', to: '2026-11-01' } }) as unknown,
    })]);
    // The model card's read: the newest run, with none of the older run's days.
    expect(await reader.latest({ orgId: '000000000000000000000003' } as unknown as OrgScope, location().id, TODAY)).toMatchObject({ run: { id: NEWER }, live: null });
  });

  it('gives each reason’s effect: the model’s where the run recorded one, else from today on the location’s own history', async () => {
    // Today is Thu, Nov 5, 2026. From Sep 11, 2025 (the 8 weeks before the history) to yesterday: Saturdays 170, other days 100.
    const history: SalesDay[] = [];
    for (let date = '2025-09-11'; date <= '2026-11-04'; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const guests = new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 170 : 100;
      history.push({ date, guests, netSalesCents: guests * 2000 });
    }
    const forecasts = {
      published: () => Promise.resolve([publishedRun()]),
      rows: () => Promise.resolve([
        dayRow('2026-11-02'), dayRow('2026-11-07', { reasons: [{ kind: 'weekday', ref: null, effectPct: null }, { kind: 'event', ref: null, effectPct: 12 }] }),
      ]),
    } as unknown as ForecastStore;
    const salesDays = { days: () => Promise.resolve(history) } as unknown as SalesDayStore;
    const reader = createForecastReader({ stores: { forecasts, salesDays, notes: NO_NOTES, businessRules: NO_RULES } });
    const days = (await run('get_forecast', { from: '2026-11-02', to: '2026-11-07' }, context({ forecasts: reader }))).parsed.days as {
      date: string; reasons: { label: string; effectPct: number | null; effect: unknown }[];
    }[];
    // 52 Saturdays of 170 against 110 a day, the average open day: usually 55% more. A past day's reasons carry none.
    expect(days.find((day) => day.date === '2026-11-07')?.reasons.map((reason) => [reason.label, reason.effectPct, reason.effect])).toEqual([
      ['Saturday', null, { direction: 'more', pct: 55, basis: 'history', days: 52, averageGuests: 110 }],
      ['Town event', 12, { direction: 'more', pct: 10, basis: 'model', days: null, averageGuests: null }],
    ]);
    expect(days.find((day) => day.date === '2026-11-02')?.reasons.map((reason) => reason.effect)).toEqual([null]);
    const description = toolNamed('get_forecast')?.definition.description ?? '';
    expect(description).toContain('Say "usually"');
    expect(description).toContain('closed and likely-closed days left out');
    expect(description).toContain('averageGuests, on a weekday\'s history effect, is the average open day\'s guests (say it: "than your average day (210)")');
    expect(description).toContain('("Saturdays usually bring about 35% more guests than your average day (210)")');
  });

  it('gives a busier-or-quieter percentage only where the run recorded a usual level', async () => {
    const tc = withRows([dayRow('2026-11-05', { baseline: 80 }), dayRow('2026-11-06')]);
    const days = (await run('get_forecast', { from: '2026-11-05', to: '2026-11-06' }, tc)).parsed.days as { vsBaselinePct: number | null }[];
    expect(days.map((day) => day.vsBaselinePct)).toEqual([26, null]);
  });

  it('marks a day or week after its run’s forecast tier as outlook, and says how to word it (D52)', async () => {
    // Made 2026-11-01 with sales through 2026-10-31: its forecast tier ends 2027-01-31 (91 days after it was made).
    const runs = [publishedRun({ range: { from: '2026-11-01', to: '2027-02-07' }, dayCount: 99 })];
    const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.parse('2027-01-25T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));
    const week = (from: string, to: string): ForecastRow => ({ ...dayRow(from), span: 'week', to, status: null, low: 560, mid: 700, high: 840, openDays: 7, reasons: [] });
    const rows = [...dates.map((date) => dayRow(date)), week('2027-01-25', '2027-01-31'), week('2027-02-01', '2027-02-07')];
    const { parsed } = await run('get_forecast', { from: '2027-01-30', to: '2027-02-02' }, withRows(rows, runs));
    expect((parsed.days as { date: string; outlook: boolean }[]).map((day) => [day.date, day.outlook])).toEqual([
      ['2027-01-30', false], ['2027-01-31', false], ['2027-02-01', true], ['2027-02-02', true],
    ]);
    expect((parsed.weeks as { from: string; outlook: boolean }[]).map((each) => [each.from, each.outlook])).toEqual([
      ['2027-01-25', false], ['2027-02-01', true],
    ]);
    expect(toolNamed('get_forecast')?.definition.description).toContain(
      'A day or week with outlook true is more than 91 days after its run was made, or more than 182 days after the last sales the run learned from: call it Townwise\'s outlook, give its range, and don\'t say 8 in 10 for it.',
    );
  });

  it('gives weeks from the run’s own week rows, never sums of days', async () => {
    const week: ForecastRow = { ...dayRow('2026-11-02'), span: 'week', to: '2026-11-08', status: null, low: 500.5, mid: 600.5, high: 700.5, openDays: 7, reasons: [] };
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((date) => dayRow(date));
    const { parsed } = await run('get_forecast', { from: '2026-11-02', to: '2026-11-08' }, withRows([...days, week]));
    expect(parsed.weeks).toEqual([{
      from: '2026-11-02', to: '2026-11-08', openDays: 7, low: 500, mid: 601, high: 701, noteGuests: 0, madeAt: '2026-11-01', actual: null, inRange: null,
      outlook: false,
    }]);
    const noWeek = await run('get_forecast', { from: '2026-11-02', to: '2026-11-08' }, withRows(days));
    expect(noWeek.parsed.weeks).toEqual([]);
  });

  // Spec 14.5: a week shifts by its days' note and rule changes from today on (today is Thu, Nov 5).
  describe('a week a note or rule changed', () => {
    const MONDAY = '2026-11-02';
    const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    const weekRow = (fields: Partial<ForecastRow> = {}): ForecastRow => ({
      ...dayRow(MONDAY), span: 'week', to: '2026-11-08', status: null, low: 200.5, mid: 600.5, high: 700.5, openDays: 6, reasons: [], ...fields,
    });
    /** Six open days of 80.6 to 119.2 and a Sunday the model closed. */
    const days = (sunday: Partial<ForecastRow> = { status: 'closed', low: null, mid: null, high: null }) => WEEK.map((date) => dayRow(date, date === '2026-11-08' ? sunday : {}));
    const closedFridays = {
      id: '0000000000000000000000dd', text: 'Closed Fridays', addedVia: 'page', createdBy: SENTINEL_USER, byStaff: false,
      schedule: { kind: 'closure', startDate: '2026-10-01', endDate: null, weekdays: [5], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
      createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    } satisfies BusinessRuleRecord;
    const weeksOf = async (rows: ForecastRow[], notes: NoteRecord[] = [], rules: BusinessRuleRecord[] = []) =>
      (await run('get_forecast', { from: MONDAY, to: '2026-11-08' }, withRows(rows, undefined, notes, rules))).parsed.weeks;

    it('takes a newly closed day’s model middle off and adds the guests notes add, shifting low, mid and high alike', async () => {
      // Friday closed by the rule (-100.4), a party of 70 on Saturday (+70): -30.4.
      expect(await weeksOf([...days(), weekRow()], [savedNote({ startDate: '2026-11-07' })], [closedFridays])).toEqual([{
        from: MONDAY, to: '2026-11-08', openDays: 5, low: 170, mid: 570, high: 671, noteGuests: 70, madeAt: '2026-11-01', actual: null, inRange: null,
        outlook: false,
      }]);
      // A party on the Sunday the model closed opens it with its 70 guests, and they add too.
      expect(await weeksOf([...days(), weekRow()], [savedNote({ startDate: '2026-11-07' }), savedNote({ startDate: '2026-11-08' })], [closedFridays]))
        .toEqual([expect.objectContaining({ openDays: 6, low: 240, mid: 640, high: 741, noteGuests: 140 })]);
    });

    it('never goes below 0, and a day before today changes nothing', async () => {
      // Closed Wednesday to Sunday: only Thursday, Friday and Saturday come off (-301.2); Wednesday is past.
      const closed = savedNote({ startDate: '2026-11-04', endDate: '2026-11-08', kind: 'closure', effect: 'closed', expectedGuests: null });
      expect(await weeksOf([...days(), weekRow()], [closed])).toEqual([expect.objectContaining({ openDays: 3, low: 0, mid: 299, high: 400, noteGuests: 0 })]);
    });

    it('is left out only when a changed day has no model middle to take off', async () => {
      const noMid = days().map((row) => (row.from === '2026-11-06' ? { ...row, mid: null } : row));
      expect(await weeksOf([...noMid, weekRow()], [], [closedFridays])).toEqual([]);
      expect(await weeksOf([...noMid, weekRow()])).toEqual([expect.objectContaining({ mid: 601 })]);
    });
  });

  it('leaves closed and likely-closed days out of live accuracy (spec D32): they are closures, not misses', async () => {
    const OLDER = '000000000000000000000011';
    const scoredDays = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
    const rows = scoredDays.map((date) => dayRow(date, { runId: OLDER, low: 80, mid: 100, high: 120 }));
    // From the 8 weeks before, 100 a day; Oct 28 near empty (likely closed), Oct 29 all zero, Oct 30 under a closure note,
    // and Oct 31, a Saturday under a closure rule, with 130 real guests: the rule gives way to them and it is scored.
    const guestsOn: Record<string, [number, number]> = { '2026-10-28': [2, 4000], '2026-10-29': [0, 0], '2026-10-31': [130, 260_000] };
    const stored: SalesDay[] = [];
    for (let date = '2026-09-01'; date <= '2026-11-04'; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const [guests, netSalesCents] = guestsOn[date] ?? [100, 200_000];
      stored.push({ date, guests, netSalesCents });
    }
    const forecasts = {
      published: () => Promise.resolve([publishedRun({
        id: OLDER, dataThrough: '2026-10-25', madeAt: '2026-10-26', range: { from: '2026-10-27', to: '2026-11-04' }, dayCount: 9,
      })]),
      rows: () => Promise.resolve(rows),
    } as unknown as ForecastStore;
    const salesDays = { days: () => Promise.resolve(stored) } as unknown as SalesDayStore;
    const notes = { overlapping: () => Promise.resolve([savedNote({ startDate: '2026-10-30', kind: 'closure', effect: 'closed', expectedGuests: null })]) };
    const closedSaturdays = {
      id: '0000000000000000000000ee', text: 'Closed Saturdays', addedVia: 'page', createdBy: SENTINEL_USER, byStaff: false,
      schedule: { kind: 'closure', startDate: '2026-10-01', endDate: null, weekdays: [6], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
      createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    } satisfies BusinessRuleRecord;
    const reader = createForecastReader({ stores: { forecasts, salesDays, notes, businessRules: { scheduled: () => Promise.resolve([closedSaturdays]) } } });
    const live = { days: 6, inRange: 5, typicalErrorPct: 4.8, from: '2026-10-27', to: '2026-11-04' };
    const { parsed } = await run('get_forecast', { from: '2026-10-27', to: '2026-11-04' }, context({ forecasts: reader }));
    expect(parsed.model).toMatchObject({ accuracy: { live } });
    // The model card's read leaves them out too.
    expect(await reader.latest({ orgId: '000000000000000000000003' } as unknown as OrgScope, location().id, TODAY)).toMatchObject({ live });
  });

  it('get_forecast gives a noted day its modelRange, noteGuests and the note reason\'s guests and outcome, never the note\'s detail or id', async () => {
    const notes = [
      savedNote({ startDate: '2026-11-07' }),
      savedNote({ startDate: '2026-11-07', kind: 'opening', effect: 'unknown', expectedGuests: 20, startTime: null, endTime: null }),
    ];
    const tc = withRows([dayRow('2026-11-06'), dayRow('2026-11-07')], undefined, notes);
    const { parsed, content } = await run('get_forecast', { from: '2026-11-06', to: '2026-11-07' }, tc);
    const days = parsed.days as Record<string, unknown>[];
    expect(days[0]).toMatchObject({ date: '2026-11-06', low: 80, mid: 100, high: 120, modelRange: null, noteGuests: 0 });
    expect(days[1]).toMatchObject({
      date: '2026-11-07', status: 'open', low: 150, mid: 170, high: 190, noteGuests: 70,
      modelRange: { status: 'open', low: 80, mid: 100, high: 120 },
      reasons: [
        { label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, sources: [], note: { guests: 70, outcome: 'added' } },
        { label: 'Saturday', effectPct: null, sources: [], note: null },
        { label: 'Your opening, 20 guests', effectPct: null, sources: [], note: { guests: 20, outcome: 'not_counted' } },
      ],
    });
    for (const sentinel of [NOTE_DETAIL, 'Smith', NOTE_ID, SENTINEL_USER]) expect(content).not.toContain(sentinel);
    const description = toolNamed('get_forecast')?.definition.description ?? '';
    expect(description).toContain('From today on, each day includes the owner\'s saved notes');
  });

  it('get_forecast applies a business rule\'s schedule with the notes, as a rule reason with its guests and outcome, never the rule\'s text or id', async () => {
    const RULE_TEXT = 'Sentinel rule: the Smith family dinner every Saturday';
    const rule = (id: string, schedule: BusinessRuleRecord['schedule']): BusinessRuleRecord => ({
      id, text: RULE_TEXT, addedVia: 'page', createdBy: SENTINEL_USER, byStaff: false, schedule,
      createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const RULE_ID = '0000000000000000000000bb';
    const rules = [
      rule(RULE_ID, { kind: 'private_event', startDate: '2026-10-03', endDate: null, weekdays: [6], effect: 'more_guests', expectedGuests: 40, startTime: '18:00', endTime: '21:00' }),
      rule('0000000000000000000000cc', { kind: 'closure', startDate: '2026-11-02', endDate: '2026-11-02', weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null }),
    ];
    const tc = withRows([dayRow('2026-11-06'), dayRow('2026-11-07'), dayRow('2026-11-09')], undefined, [savedNote({ startDate: '2026-11-07' })], rules);
    const { parsed, content } = await run('get_forecast', { from: '2026-11-06', to: '2026-11-09' }, tc);
    const days = parsed.days as Record<string, unknown>[];
    expect(days[0]).toMatchObject({ date: '2026-11-06', low: 80, mid: 100, high: 120, noteGuests: 0 });
    expect(days[1]).toMatchObject({
      date: '2026-11-07', status: 'open', low: 190, mid: 210, high: 230, noteGuests: 110,
      modelRange: { status: 'open', low: 80, mid: 100, high: 120 },
      reasons: [
        { label: 'Your rule: adds 40 guests on Saturdays, 6 pm to 9 pm', effectPct: null, sources: [], note: null, rule: { guests: 40, outcome: 'added' } },
        { label: 'Your private event, 70 guests, 6 pm to 9 pm', note: { guests: 70, outcome: 'added' }, rule: null },
        { label: 'Saturday', note: null, rule: null },
      ],
    });
    for (const sentinel of [RULE_TEXT, 'Smith', RULE_ID, SENTINEL_USER]) expect(content).not.toContain(sentinel);
    const description = toolNamed('get_forecast')?.definition.description ?? '';
    expect(description).toContain('business rules with a schedule');
  });

  it('get_forecast lists at most 6 rule reasons a day and counts the rest in moreRules; a note on the day beats a rule\'s closure', async () => {
    const rule = (id: number, schedule: BusinessRuleRecord['schedule']): BusinessRuleRecord => ({
      id: String(id).padStart(24, '0'), text: `Sentinel rule ${String(id)}`, addedVia: 'page', createdBy: SENTINEL_USER, byStaff: false, schedule,
      createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const quiet = { kind: 'other', startDate: '2026-10-01', endDate: null, weekdays: null, effect: 'fewer_guests', expectedGuests: null, startTime: null, endTime: null } as const;
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => rule(id, quiet));
    const busy = await run('get_forecast', { from: '2026-11-06', to: '2026-11-06' }, withRows([dayRow('2026-11-06')], undefined, [], many));
    const [day] = busy.parsed.days as { reasons: { rule: unknown }[]; moreRules: number; moreNotes: number }[];
    expect(day?.reasons.filter((reason) => reason.rule !== null)).toHaveLength(6);
    expect(day).toMatchObject({ moreRules: 2, moreNotes: 0 });
    // Closed on Fridays, but the owner opened this one with a one-day opening note.
    const closedFridays = rule(9, { ...quiet, kind: 'closure', weekdays: [5], effect: 'closed' });
    const opening = savedNote({ startDate: '2026-11-06', kind: 'opening', effect: 'unknown', expectedGuests: null, startTime: null, endTime: null });
    const opened = await run('get_forecast', { from: '2026-11-06', to: '2026-11-06' }, withRows([dayRow('2026-11-06')], undefined, [opening], [closedFridays]));
    expect((opened.parsed.days as Record<string, unknown>[])[0]).toMatchObject({ status: 'open', low: 80, mid: 100, high: 120 });
    expect(JSON.stringify(opened.parsed)).toContain('"rule":{"guests":null,"outcome":"overridden"}');
    const description = toolNamed('get_forecast')?.definition.description ?? '';
    for (const words of ['overridden', 'moreRules', 'A week\'s range shifts']) expect(description).toContain(words);
  });

  it('get_forecast keeps a past day\'s figures and says the note came after it', async () => {
    const tc = withRows([dayRow('2026-11-04')], undefined, [savedNote({ startDate: '2026-11-04' })]);
    const days = (await run('get_forecast', { from: '2026-11-04', to: '2026-11-04' }, tc)).parsed.days as Record<string, unknown>[];
    expect(days[0]).toMatchObject({ low: 80, mid: 100, high: 120, modelRange: null, noteGuests: 0 });
    expect((days[0]?.reasons as { note: unknown }[]).find((reason) => reason.note !== null)).toEqual(expect.objectContaining({
      note: { guests: 70, outcome: 'past_day' },
    }));
  });

  it('get_forecast shifts a week by a booked or closed day\'s model middle and by the guests notes add', async () => {
    const dates = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
    const week: ForecastRow = { ...dayRow('2026-11-09'), span: 'week', to: '2026-11-15', status: null, low: 500, mid: 600, high: 700, openDays: 7, reasons: [] };
    const rows = [...dates.map((date) => dayRow(date)), week];
    const weeksWith = async (notes: readonly NoteRecord[]) => (await run('get_forecast', { from: '2026-11-09', to: '2026-11-15' }, withRows(rows, undefined, notes))).parsed;
    const buyout = await weeksWith([savedNote({ startDate: '2026-11-14', effect: 'closed', startTime: null, endTime: null })]);
    // The booked Saturday's 100.4 comes off the week, and its party is no walk-in.
    expect(buyout.weeks).toEqual([expect.objectContaining({ openDays: 6, low: 399, mid: 500, high: 600, noteGuests: 0 })]);
    expect((buyout.days as Record<string, unknown>[])[5]).toMatchObject({
      status: 'booked', low: null, mid: null, high: null, noteGuests: 70, modelRange: { status: 'open', low: 80, mid: 100, high: 120 },
    });
    const closure = await weeksWith([savedNote({ startDate: '2026-11-10', kind: 'closure', effect: 'closed', expectedGuests: null, startTime: null, endTime: null })]);
    expect(closure.weeks).toEqual([expect.objectContaining({ openDays: 6, low: 399, mid: 500, high: 600, noteGuests: 0 })]);
    const party = await weeksWith([savedNote({ startDate: '2026-11-14' })]);
    expect(party.weeks).toEqual([expect.objectContaining({ low: 570, mid: 670, high: 770, noteGuests: 70 })]);
  });

  it('get_forecast: a party opens a day the model closed with only its guests; a note on a booked day is day_booked', async () => {
    const closedRow = dayRow('2026-11-09', { status: 'closed', low: null, mid: null, high: null, reasons: [{ kind: 'closure', ref: null, effectPct: null }] });
    const opened = await run('get_forecast', { from: '2026-11-09', to: '2026-11-09' }, withRows([closedRow], undefined, [savedNote({ startDate: '2026-11-09' })]));
    expect((opened.parsed.days as Record<string, unknown>[])[0]).toMatchObject({
      status: 'open', low: 70, mid: 70, high: 70, noteGuests: 70, modelRange: { status: 'closed', low: null, mid: null, high: null },
      reasons: [{ note: { guests: 70, outcome: 'added' } }, { label: 'Closed', note: null }],
    });
    const booked = await run('get_forecast', { from: '2026-11-10', to: '2026-11-10' }, withRows([dayRow('2026-11-10')], undefined, [
      savedNote({ startDate: '2026-11-10', effect: 'closed', expectedGuests: 50, startTime: null, endTime: null }),
      savedNote({ id: 'f'.repeat(24), startDate: '2026-11-10' }),
    ]));
    expect(((booked.parsed.days as Record<string, unknown>[])[0]?.reasons as { note: unknown }[]).map((reason) => reason.note)).toEqual([
      { guests: 50, outcome: 'booked' }, null, { guests: 70, outcome: 'day_booked' },
    ]);
    const description = toolNamed('get_forecast')?.definition.description ?? '';
    expect(description).toContain('a buyout books it, even a day the model expects closed');
    expect(description).toContain('day_booked');
  });

  it('cards show the model, dates and counts only, never a figure', async () => {
    const { content } = await run('get_forecast', { from: '2026-11-02', to: '2026-11-03' }, withRows([dayRow('2026-11-02')]));
    expect(inputViewOf('get_forecast', { from: '2026-11-02', to: '2026-11-03' }, TODAY)).toEqual({ from: '2026-11-02', to: '2026-11-03' });
    expect(JSON.stringify(resultViewOf('get_forecast', ok(content)))).not.toMatch(/"(low|mid|high|actual|guests|typicalErrorPct)"/);
  });

  it('never sends a staff id, the notebook commit, the run file or a stored calendar ref', async () => {
    const row = dayRow('2026-11-02', { reasons: [{ kind: 'event', ref: 'hanover-nh:home-football', effectPct: null }] });
    const { content } = await run('get_forecast', { from: '2026-11-02', to: '2026-11-02' }, withRows([row]));
    for (const sentinel of [SENTINEL_USER, '0000000', 'notebookCommit', 'fileSha256', 'importedBy', 'hanover-nh:home-football', '@']) {
      expect(content).not.toContain(sentinel);
    }
  });
});

describe('privacy', () => {
  it('neither tool’s output holds an email, a person’s or upload’s id, a note’s text or a file name', async () => {
    const outputs = [
      (await run('get_people_in_town', { from: '2026-09-01', to: '2026-11-30' })).content,
      (await run('get_town_calendar', { from: '2026-09-01', to: '2026-11-30' })).content,
    ];
    for (const output of outputs) {
      for (const sentinel of [SENTINEL_EMAIL, SENTINEL_USER, SENTINEL_FILE, SENTINEL_UPLOAD, 'Party booked', '@']) {
        expect(output).not.toContain(sentinel);
      }
    }
  });
});
