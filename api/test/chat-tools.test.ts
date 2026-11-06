// The TownwiseAI tool registry (docs/portal/tuning-chat.md section 4), without Docker: the frozen, append-only order
// of the tools, what the model is sent, and the input and result views each tool call's card shows.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { townProfileOf } from '../src/handlers/towns.ts';
import { inputViewOf, resultViewOf, TOOL_REGISTRY, TOOLS, toolNamed, type ToolContext, type ToolView } from '../src/chat/tools/registry.ts';
import type { NoteRecord, NoteStore } from '../src/stores/notes.ts';
import type { SalesDayStore, SalesDayWithUpload } from '../src/stores/sales-days.ts';
import type { UploadRecord, UploadStore } from '../src/stores/uploads.ts';
import type { Town } from '../src/towns.ts';

/**
 * The contract. Append a new tool's name at the end in the PR that registers it; never rename, remove or move one,
 * because stored conversations name their tool calls and the prompt cache keys on this list. The client's tool table
 * (client/src/chat/tools.ts), once it exists, lists the same names.
 */
const FROZEN_NAMES = [
  'get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note',
  // U13A.
  'get_town_calendar', 'get_people_in_town',
  // U13B.
  'get_forecast',
  // F2.
  'get_day',
];

describe('the tool registry', () => {
  it('holds the tools in their frozen order, each name once', () => {
    const names = TOOL_REGISTRY.map((tool) => tool.definition.name);
    expect(names).toEqual(FROZEN_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('sends the model exactly the registry’s definitions, in order, each streaming its input unbuffered', () => {
    expect(TOOLS).toEqual(TOOL_REGISTRY.map((tool) => tool.definition));
    expect(TOOLS.every((tool) => tool.eager_input_streaming === true)).toBe(true);
  });

  it('finds a tool by name and nothing for an unknown one', () => {
    expect(toolNamed('list_notes')?.definition.name).toBe('list_notes');
    expect(toolNamed('get_weather')).toBeUndefined();
  });
});

describe('the views on a tool call’s card', () => {
  const ok = (content: unknown) => ({
    type: 'tool_result' as const, tool_use_id: 't1', content: typeof content === 'string' ? content : JSON.stringify(content),
  });
  const today = '2026-06-01';

  it('get_location_overview: no input view; the coverage dates and counts and how many months were read', () => {
    expect(inputViewOf('get_location_overview', {}, today)).toBeNull();
    expect(resultViewOf('get_location_overview', ok({
      location: { name: 'Taproom', town: { name: 'Hanover', state: 'NH' } }, today,
      coverage: { firstDate: '2026-05-01', lastDate: '2026-05-02', dayCount: 2, guestsDayCount: 2, netSalesDayCount: 1, missingDays: 0 },
      calibration: 'not_calibrated', townProfile: true,
      months: [{ month: '2026-05', days: 2, guests: 230, netSalesUsd: 5123.45 }],
    }))).toEqual({ firstDate: '2026-05-01', lastDate: '2026-05-02', dayCount: 2, missingDays: 0, monthCount: 1 });
    expect(resultViewOf('get_location_overview', ok({
      coverage: { firstDate: null, lastDate: null, dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, missingDays: 0 }, months: [],
    }))).toEqual({ firstDate: null, lastDate: null, dayCount: 0, missingDays: 0, monthCount: 0 });
  });

  it('get_sales_days: the range as input; the range and day counts as result; an invalid range has no input view', () => {
    expect(inputViewOf('get_sales_days', { from: '2026-05-01', to: '2026-05-31' }, today)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(inputViewOf('get_sales_days', { from: '2026-05-01', to: '2026-12-31' }, today)).toBeNull();
    expect(resultViewOf('get_sales_days', ok({
      from: '2026-05-01', to: '2026-05-31',
      days: [{ date: '2026-05-01', guests: 140, netSalesUsd: 5123.45 }, { date: '2026-05-02', guests: 90, netSalesUsd: null }],
    }))).toEqual({ from: '2026-05-01', to: '2026-05-31', dayCount: 2, guestsDayCount: 2, netSalesDayCount: 1 });
  });

  it('list_notes: how many notes, never their text', () => {
    expect(inputViewOf('list_notes', {}, today)).toBeNull();
    expect(resultViewOf('list_notes', ok({ notes: [{ detail: 'Sentinel-note-detail' }, { detail: null }] }))).toEqual({ count: 2 });
  });

  it('get_town_profile: the town and at most 5 distinct https sources with their hosts, or unavailable', () => {
    const profile = townProfileOf('hanover-nh');
    expect(profile).toBeDefined();
    const view = resultViewOf('get_town_profile', ok({ profile }));
    expect(view).toMatchObject({ available: true, town: { name: 'Hanover', state: 'NH' } });
    const sources = view?.sources as { host: string; url: string }[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBeLessThanOrEqual(5);
    expect(new Set(sources.map((source) => source.url)).size).toBe(sources.length);
    for (const source of sources) {
      expect(source.url.startsWith('https://')).toBe(true);
      expect(source.host).toBe(new URL(source.url).hostname.replace(/^www\./, ''));
    }
    expect(resultViewOf('get_town_profile', ok({
      profile: {
        name: 'Testville', state: 'NH',
        drivers: [{ sourceUrls: ['http://plain.example.test/a', 'https://www.example.test/b', 'https://www.example.test/b'] }],
        dates: [{ sourceUrls: ['not a url', 'https://data.example.test/c'] }],
      },
    }))).toEqual({
      available: true, town: { name: 'Testville', state: 'NH' },
      sources: [{ host: 'example.test', url: 'https://www.example.test/b' }, { host: 'data.example.test', url: 'https://data.example.test/c' }],
    });
    expect(resultViewOf('get_town_profile', ok({ profile: null }))).toEqual({ available: false, town: null, sources: [] });
  });

  it('propose_note: no views (the proposal card shows the note)', () => {
    const note = {
      kind: 'closure', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
    };
    expect(inputViewOf('propose_note', note, today)).toBeNull();
    expect(resultViewOf('propose_note', ok('Shown to the owner as a proposal. They decide whether to add it.'))).toBeNull();
  });

  it('a result that is an error, unreadable or for an unknown tool has no view', () => {
    expect(resultViewOf('list_notes', { ...ok({ notes: [] }), is_error: true })).toBeNull();
    expect(resultViewOf('list_notes', ok('not json'))).toBeNull();
    expect(resultViewOf('list_notes', ok({ other: 1 }))).toBeNull();
    expect(resultViewOf('get_weather', ok({ notes: [] }))).toBeNull();
    expect(inputViewOf('get_weather', {}, today)).toBeNull();
  });

  it('no view of any tool holds a figure: no guests, sales or dollars key at any depth', () => {
    const keys = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(keys);
      if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
      return [];
    };
    const views: (ToolView | null)[] = [
      resultViewOf('get_location_overview', ok({
        coverage: { firstDate: '2026-05-01', lastDate: '2026-05-02', dayCount: 2, guestsDayCount: 2, netSalesDayCount: 1, missingDays: 0 },
        months: [{ month: '2026-05', days: 2, guests: 230, netSalesUsd: 5123.45 }],
      })),
      resultViewOf('get_sales_days', ok({ from: '2026-05-01', to: '2026-05-01', days: [{ date: '2026-05-01', guests: 140, netSalesUsd: 5123.45 }] })),
      resultViewOf('list_notes', ok({ notes: [{ expectedGuests: 120 }] })),
      resultViewOf('get_town_profile', ok({ profile: townProfileOf('hanover-nh') })),
      inputViewOf('get_sales_days', { from: '2026-05-01', to: '2026-05-31' }, today),
    ];
    expect(views.every((view) => view !== null)).toBe(true);
    const all = views.flatMap(keys);
    for (const key of all) expect(key).not.toMatch(/^(guests|netSales|netSalesUsd|netSalesCents|expectedGuests|months|days|notes)$/);
    // The town profile's view holds only its source links, whose paths may hold any digits.
    expect(JSON.stringify(views.filter((_view, index) => index !== 3))).not.toMatch(/5123|230|140|120/);
  });
});

// F2: get_day, everything Townwise has for one day, from fakes of the stores it reads. Synthetic data only.
describe('get_day', () => {
  const TODAY = '2026-11-05';
  const SENTINEL_USER = 'sentinel-user-id-0001';
  const UPLOAD_ID = '0000000000000000000000c1';
  const ok = (content: unknown) => ({ type: 'tool_result' as const, tool_use_id: 't1', content: JSON.stringify(content) });

  function note(fields: Partial<NoteRecord>): NoteRecord {
    return {
      id: '000000000000000000000002', kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null,
      effect: 'more_guests', expectedGuests: 60, detail: 'Sentinel-day-detail', createdBy: SENTINEL_USER,
      createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z'), ...fields,
    };
  }

  function context(opts: { days?: SalesDayWithUpload[]; notes?: NoteRecord[]; uploads?: UploadRecord[]; townId?: Town['townId'] } = {}) {
    const byIds: string[][] = [];
    const upload: UploadRecord = {
      id: UPLOAD_ID, uploadedBy: SENTINEL_USER, uploadedAt: new Date('2026-11-23T03:30:00Z'), status: 'applied', dayCount: 7, inserted: 7,
      replaced: 0, kept: 0, firstDate: '2026-11-16', lastDate: '2026-11-22', hasGuests: true, hasNetSales: true,
    };
    const stores = {
      salesDays: { history: () => Promise.resolve(opts.days ?? []) } as unknown as SalesDayStore,
      notes: { list: () => Promise.resolve(opts.notes ?? []) } as unknown as NoteStore,
      uploads: {
        byIds: (_scope: OrgScope, _location: string, ids: string[]) => {
          byIds.push(ids);
          return Promise.resolve((opts.uploads ?? [upload]).filter((row) => ids.includes(row.id)));
        },
      } as unknown as UploadStore,
    };
    const tc: ToolContext = {
      ctx: { stores } as unknown as TownwiseContext,
      scope: { orgId: '000000000000000000000003' } as unknown as OrgScope,
      location: {
        id: '000000000000000000000001', name: 'Test Taproom', placeId: null, createdAt: new Date('2026-01-01T00:00:00Z'),
        town: { townId: opts.townId === undefined ? 'hanover-nh' : opts.townId, name: 'Hanover', state: 'NH' },
      },
      today: TODAY,
      timeZone: 'America/New_York',
    };
    return { tc, byIds };
  }

  async function run(input: unknown, tc: ToolContext): Promise<{ content: string; parsed: Record<string, unknown> }> {
    const tool = toolNamed('get_day');
    const parsed = tool?.parse(input, TODAY) ?? null;
    if (tool === undefined || parsed === null) throw new Error('invalid input');
    const { content } = await tool.run(tc, parsed);
    return { content, parsed: JSON.parse(content) as Record<string, unknown> };
  }

  it('takes one real date from 2010-01-01 to 400 days after today', () => {
    expect(inputViewOf('get_day', { date: '2026-11-21' }, TODAY)).toEqual({ date: '2026-11-21' });
    expect(inputViewOf('get_day', { date: '2010-01-01' }, TODAY)).toEqual({ date: '2010-01-01' });
    expect(inputViewOf('get_day', { date: '2027-12-10' }, TODAY)).toEqual({ date: '2027-12-10' });
    for (const bad of [{ date: '2009-12-31' }, { date: '2027-12-11' }, { date: '2026-02-30' }, { date: '11/21/2026' }, {}, { date: 20261121 }]) {
      expect(inputViewOf('get_day', bad, TODAY)).toBeNull();
    }
  });

  it('gives the day’s row, the notes and calendar entries that cover it, and when its upload was made, never who made it', async () => {
    const days = [
      { date: '2026-11-20', guests: 90, netSalesCents: 180_000, uploadId: UPLOAD_ID },
      { date: '2026-11-21', guests: 140, netSalesCents: 512_345, uploadId: UPLOAD_ID },
    ];
    const notes = [
      note({}),
      // Mondays only: not this Saturday.
      note({ id: '000000000000000000000004', kind: 'closure', startDate: '2026-11-01', endDate: '2026-11-30', weekdays: [1], effect: 'closed', detail: null }),
      note({ id: '000000000000000000000005', startDate: '2026-11-22', endDate: '2026-11-22' }),
    ];
    const { tc, byIds } = context({ days, notes });
    const { content, parsed } = await run({ date: '2026-11-21' }, tc);
    expect(parsed).toMatchObject({
      date: '2026-11-21', weekday: 'Sat', sales: { guests: 140, netSalesUsd: 5123.45 }, closed: false, dayClass: 'noted',
      notes: [{ kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null, effect: 'more_guests', expectedGuests: 60, detail: 'Sentinel-day-detail' }],
      town: { name: 'Hanover', state: 'NH' }, covered: true,
      // Uploaded at 03:30 UTC on the 23rd: the 22nd in Hanover.
      upload: { uploadedOn: '2026-11-22', finished: true },
    });
    const events = parsed.events as { id: string; startWeekday: string; sources: unknown[] }[];
    expect(events.some((event) => event.id.includes('brown'))).toBe(true);
    expect(events.every((event) => event.sources.length > 0 && typeof event.startWeekday === 'string')).toBe(true);
    expect(byIds).toEqual([[UPLOAD_ID]]);
    expect(content).not.toContain(SENTINEL_USER);
    expect(content).not.toContain(UPLOAD_ID);
    expect(content).not.toMatch(/createdBy|uploadedBy|email/);
  });

  it('says so when the day has no row, a covering note closed it, or the town’s calendar isn’t researched', async () => {
    const closed = note({ kind: 'closure', effect: 'closed', expectedGuests: null, detail: null });
    const { tc, byIds } = context({ notes: [closed], townId: null });
    const { parsed } = await run({ date: '2026-11-21' }, tc);
    expect(parsed).toMatchObject({ sales: null, closed: true, dayClass: 'closed', covered: false, upload: null, events: [] });
    expect(byIds).toEqual([]);
    // Thanksgiving is a federal holiday in every town.
    const { parsed: holiday } = await run({ date: '2026-11-26' }, context({ townId: null }).tc);
    expect(holiday).toMatchObject({ weekday: 'Thu', dayClass: 'holiday', closed: false });
    // An all-zero row is closed; an upload record that is gone is null.
    const zero = context({ days: [{ date: '2026-11-21', guests: 0, netSalesCents: 0, uploadId: UPLOAD_ID }], uploads: [] }).tc;
    expect((await run({ date: '2026-11-21' }, zero)).parsed).toMatchObject({ sales: { guests: 0, netSalesUsd: 0 }, closed: true, upload: null });
  });

  it('shows the date, whether there were sales, closed, counts and source links on its card, never a figure', async () => {
    const days = [{ date: '2026-11-21', guests: 140, netSalesCents: 512_345, uploadId: UPLOAD_ID }];
    const { content } = await run({ date: '2026-11-21' }, context({ days, notes: [note({})] }).tc);
    const view = resultViewOf('get_day', { type: 'tool_result', tool_use_id: 't1', content });
    expect(view).toMatchObject({ date: '2026-11-21', hasSales: true, closed: false, noteCount: 1 });
    expect(typeof view?.eventCount).toBe('number');
    const sources = view?.sources as { host: string; url: string }[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBeLessThanOrEqual(5);
    // Source links are left out here: their paths may hold any digits.
    expect(JSON.stringify({ ...view, sources: null })).not.toMatch(/140|5123|60|Sentinel/);
    expect(resultViewOf('get_day', ok({ date: '2026-11-21', sales: null, closed: false, notes: [], events: [] }))).toEqual({
      date: '2026-11-21', hasSales: false, closed: false, noteCount: 0, eventCount: 0, sources: [],
    });
    expect(resultViewOf('get_day', ok({ other: 1 }))).toBeNull();
  });

  it('is named in the system prompt, with which kind each of its figures is', () => {
    expect(SYSTEM_PROMPT).toContain('When the owner asks about one day, call get_day: it gives that day\'s sales, whether it was closed, the notes and town calendar entries that cover it, and when its data was uploaded. Its sales are the owner\'s own history; its calendar entries are public town data.');
  });
});
