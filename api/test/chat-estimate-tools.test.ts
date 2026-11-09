// TownwiseAI's estimate tools (spec 13.2, docs/portal/estimates.md), without Docker: get_town_calendar and
// get_people_in_town validate their ranges, give every dated row its weekday, say honestly what is missing, show
// only dates, counts and source links on their cards, and never put an email, a person's id, a note author or a file
// name in front of the model. Synthetic data only.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { inputViewOf, resultViewOf, toolNamed, type ToolContext } from '../src/chat/tools/registry.ts';
import { createForecastReader, type ForecastReader } from '../src/forecasts/reader.ts';
import { createPeopleInTownReader } from '../src/people-in-town/reader.ts';
import type { PeopleData } from '../src/people-in-town/sources.ts';
import type { ForecastRow, ForecastRunRecord, ForecastStore } from '../src/stores/forecasts.ts';
import type { LocationRecord } from '../src/stores/locations.ts';
import type { NoteRecord, NoteStore } from '../src/stores/notes.ts';
import type { SalesDayStore, SalesDayWithUpload } from '../src/stores/sales-days.ts';
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
    importedAt: new Date('2026-11-01T00:00:00Z'), publishedAt: new Date('2026-11-01T00:00:00Z'), withdrawnAt: null, ...fields,
  };
}

function dayRow(date: string, fields: Partial<ForecastRow> = {}): ForecastRow {
  return {
    runId: '000000000000000000000010', span: 'day', from: date, to: date, status: 'open', low: 80.6, mid: 100.4, high: 119.2,
    baseline: null, openDays: null, reasons: [{ kind: 'weekday', ref: null, effectPct: null }], ...fields,
  };
}

function forecastStores(rows: readonly ForecastRow[], runs: readonly ForecastRunRecord[] = rows.length === 0 ? [] : [publishedRun()]) {
  const forecasts = {
    published: () => Promise.resolve([...runs]),
    rows: () => Promise.resolve([...rows]),
  } as unknown as ForecastStore;
  const salesDays = { days: () => Promise.resolve([{ date: '2026-11-02', guests: 140, netSalesCents: 1 }]) } as unknown as SalesDayStore;
  return { forecasts, salesDays };
}

function context(opts: { data?: PeopleData; town?: Town; forecasts?: ForecastReader } = {}): ToolContext {
  const notes: NoteRecord[] = [{
    id: '000000000000000000000002', kind: 'private_event', startDate: '2026-10-10', endDate: '2026-10-10', weekdays: null,
    effect: 'more_guests', expectedGuests: null, detail: `Party booked by ${SENTINEL_EMAIL} from ${SENTINEL_FILE}`,
    createdBy: SENTINEL_USER, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
  }];
  const days = [...saturdays('2026-09-19', 8, 200), ...saturdays('2025-12-06', 3, 90)];
  const stores = {
    salesDays: { history: () => Promise.resolve(days.sort((a, b) => (a.date < b.date ? -1 : 1))) } as unknown as SalesDayStore,
    notes: { list: () => Promise.resolve(notes) } as unknown as NoteStore,
  };
  const reader = createPeopleInTownReader({ stores, data: opts.data ?? { sources: [], towns: [] } });
  const ctx = { ports: { peopleInTown: reader, forecasts: opts.forecasts ?? createForecastReader({ stores: forecastStores([]) }) } } as unknown as TownwiseContext;
  const scope = { orgId: '000000000000000000000003' } as unknown as OrgScope;
  return { ctx, scope, location: location(opts.town), today: TODAY, timeZone: 'America/New_York' };
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
      covers: { from: '2025-01-06', to: '2027-11-24' },
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
  const withRows = (rows: readonly ForecastRow[], runs?: readonly ForecastRunRecord[]) => context({ forecasts: createForecastReader({ stores: forecastStores(rows, runs) }) });

  it('takes { from, to } of at most 31 days, starting at most 92 days back', () => {
    expect(parse({ from: '2026-11-01', to: '2026-12-01' })).toEqual({ from: '2026-11-01', to: '2026-12-01' });
    expect(parse({ from: '2026-11-01', to: '2026-12-02' })).toBeNull();
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
        dataThrough: '2026-10-31', madeAt: '2026-11-01', frozen: true, rangesWidened: true,
        accuracy: { backtest: { weeks: 10, weeklyTypicalErrorPct: 10, weeksOver20Pct: 1 }, live: null },
      },
      interval: { level: 0.8, meaning: 'About 8 in 10 days should land inside the range.' },
      notCovered: [{ from: '2026-11-04', to: '2026-11-04' }],
    });
    const days = parsed.days as Record<string, unknown>[];
    expect(days[0]).toEqual({
      date: '2026-11-02', weekday: 'Mon', status: 'open', low: 80, mid: 100, high: 120, vsBaselinePct: null,
      reasons: [{ label: 'Monday', effectPct: null, sources: [] }], madeAt: '2026-11-01', madeAfterDay: false, actual: 140, inRange: false,
    });
    expect(days[1]).toMatchObject({ status: 'closed', low: null, mid: null, high: null, reasons: [{ label: 'Closed' }] });
    expect(resultViewOf('get_forecast', ok(content))).toEqual({
      available: true, modelVersion: 'v9', madeAt: '2026-11-01', dataThrough: '2026-10-31', days: 2, notCovered: 1,
    });
  });

  it('gives each run its own live accuracy, so a newer run is never credited with an older run’s days', async () => {
    const OLDER = '000000000000000000000011';
    const NEWER = '000000000000000000000012';
    const runs = [
      publishedRun({ id: NEWER, model: { family: 'hybrid_linear_xgboost', version: 'v10', notebookCommit: '0000000' }, dataThrough: '2026-11-01', madeAt: '2026-11-02', backtest: null }),
      publishedRun({ id: OLDER, dataThrough: '2026-10-25', madeAt: '2026-10-26' }),
    ];
    const olderDays = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
    const rows = [
      ...olderDays.map((date) => dayRow(date, { runId: OLDER, low: 80, mid: 100, high: 120 })),
      ...['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((date) => dayRow(date, { runId: NEWER })),
    ];
    const forecasts = { published: () => Promise.resolve(runs), rows: () => Promise.resolve(rows) } as unknown as ForecastStore;
    const salesDays = { days: () => Promise.resolve(olderDays.map((date) => ({ date, guests: date === '2026-10-30' ? 130 : 100, netSalesCents: 1 }))) } as unknown as SalesDayStore;
    const reader = createForecastReader({ stores: { forecasts, salesDays } });
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

  it('gives a busier-or-quieter percentage only where the run recorded a usual level', async () => {
    const tc = withRows([dayRow('2026-11-05', { baseline: 80 }), dayRow('2026-11-06')]);
    const days = (await run('get_forecast', { from: '2026-11-05', to: '2026-11-06' }, tc)).parsed.days as { vsBaselinePct: number | null }[];
    expect(days.map((day) => day.vsBaselinePct)).toEqual([26, null]);
  });

  it('gives weeks from the run’s own week rows, never sums of days', async () => {
    const week: ForecastRow = { ...dayRow('2026-11-02'), span: 'week', to: '2026-11-08', status: null, low: 500.5, mid: 600.5, high: 700.5, openDays: 7, reasons: [] };
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((date) => dayRow(date));
    const { parsed } = await run('get_forecast', { from: '2026-11-02', to: '2026-11-08' }, withRows([...days, week]));
    expect(parsed.weeks).toEqual([{ from: '2026-11-02', to: '2026-11-08', openDays: 7, low: 500, mid: 601, high: 701, madeAt: '2026-11-01', actual: null, inRange: null }]);
    const noWeek = await run('get_forecast', { from: '2026-11-02', to: '2026-11-08' }, withRows(days));
    expect(noWeek.parsed.weeks).toEqual([]);
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
