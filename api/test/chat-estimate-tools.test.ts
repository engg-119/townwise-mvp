// TownwiseAI's estimate tools (spec 13.2, docs/portal/estimates.md), without Docker: get_town_calendar and
// get_people_in_town validate their ranges, give every dated row its weekday, say honestly what is missing, show
// only dates, counts and source links on their cards, and never put an email, a person's id, a note author or a file
// name in front of the model. Synthetic data only.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { inputViewOf, resultViewOf, toolNamed, type ToolContext } from '../src/chat/tools/registry.ts';
import { createPeopleInTownReader } from '../src/people-in-town/reader.ts';
import type { PeopleData } from '../src/people-in-town/sources.ts';
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

function context(opts: { data?: PeopleData; town?: Town } = {}): ToolContext {
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
  const ctx = { ports: { peopleInTown: reader } } as unknown as TownwiseContext;
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
      covers: { from: '2025-01-06', to: '2027-01-05' },
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
