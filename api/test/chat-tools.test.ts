// The TownwiseAI tool registry (docs/portal/tuning-chat.md section 4), without Docker: the frozen, append-only order
// of the tools, what the model is sent, and the input and result views each tool call's card shows.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { TEXT_ITEM_MAX_CHARS, TEXT_ITEM_TITLE_MAX } from '../src/files/items.ts';
import { townProfileOf } from '../src/handlers/towns.ts';
import { inputViewOf, resultViewOf, TOOL_REGISTRY, TOOLS, toolNamed, type ToolContext, type ToolView } from '../src/chat/tools/registry.ts';
import { requestParams } from '../src/chat/turn.ts';
import { WEB_SEARCH_TOOL } from '../src/chat/web-search.ts';
import type { BusinessRuleRecord, BusinessRuleStore } from '../src/stores/business-rules.ts';
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
  // Chat redesign A4: visuals and next questions.
  'show_visual', 'suggest_next',
  // Your data.
  'list_data_items', 'read_data_item', 'propose_data_item',
  // The forecast lab.
  'start_calibration', 'get_calibration', 'compare_forecast_models',
  // The owner's own calendars.
  'get_owner_calendar',
  // Orders.
  'get_order_board', 'get_order_line', 'get_order_setup', 'propose_order_change', 'propose_order_rule', 'propose_order_setup',
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

  it('keeps web search (D37) out of the registry: sent after every registry tool while on, so a tool appended later goes before it', () => {
    expect(FROZEN_NAMES).not.toContain('web_search');
    expect(toolNamed('web_search')).toBeUndefined();
    const tools = requestParams([{ role: 'user', content: 'Hi' }], true).tools ?? [];
    expect(tools.map((tool) => ('name' in tool ? tool.name : null))).toEqual([...FROZEN_NAMES, 'web_search']);
    expect(tools.at(-1)).toBe(WEB_SEARCH_TOOL);
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
    // The Your data items holding the range, by ref only (spec P25), when the result names them.
    const refs = ['u_0123456789abcdef01234567', 'u_89abcdef0123456789abcdef'];
    expect(resultViewOf('get_sales_days', ok({ from: '2026-05-01', to: '2026-05-01', days: [], uploadRefs: refs })))
      .toEqual({ from: '2026-05-01', to: '2026-05-01', dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, uploadRefs: refs });
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

  // BLS withheld Nantucket County for April to June 2025: the tool gives TownwiseAI the profile with a null series and
  // the reason, never a stale or made-up index, and the card still names the town.
  it('get_town_profile: a county BLS did not publish for the whole year comes with a null series and the reason', async () => {
    const tc = { location: { town: { townId: 'nantucket-ma' } } } as unknown as ToolContext;
    const { content } = await toolNamed('get_town_profile')?.run(tc, {}) ?? { content: '' };
    const { profile } = JSON.parse(content) as { profile: { name: string; county: string; year: number; series: unknown; seriesUnavailable: string } };
    expect(profile).toMatchObject({
      name: 'Nantucket', county: 'Nantucket County', year: 2025, series: null,
      seriesUnavailable: 'BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.',
    });
    expect(resultViewOf('get_town_profile', ok({ profile }))).toEqual({ available: true, town: { name: 'Nantucket', state: 'MA' }, sources: [] });
    const hanover = JSON.parse((await toolNamed('get_town_profile')?.run({ location: { town: { townId: 'hanover-nh' } } } as unknown as ToolContext, {}))?.content ?? '{}') as { profile: { series: { index: number[] } | null; seriesUnavailable: string | null } };
    expect(hanover.profile.series?.index).toHaveLength(12);
    expect(hanover.profile.seriesUnavailable).toBeNull();
  });

  it('propose_note: no views (the proposal card shows the note)', () => {
    const note = {
      kind: 'closure', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
    };
    expect(inputViewOf('propose_note', note, today)).toBeNull();
    expect(resultViewOf('propose_note', ok('Shown to the owner as a proposal. They decide whether to add it.'))).toBeNull();
  });

  it('propose_note takes the event’s name (D49): required, a string of at most 120 characters naming no person, or null', () => {
    const tool = toolNamed('propose_note');
    if (tool === undefined) throw new Error('no propose_note');
    const schema = tool.definition.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties.title).toEqual({ type: ['string', 'null'], maxLength: 120 });
    expect(schema.required).toContain('title');
    expect(tool.definition.description).toContain('title names the event in at most 120 characters, never a person, or is null');
    const note = {
      kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'closed', expectedGuests: 70, detail: null,
    };
    expect(tool.parse({ ...note, title: 'Alumni weekend dinner' }, today)).toMatchObject({ note: { title: 'Alumni weekend dinner' } });
    expect(tool.parse({ ...note, title: null }, today)).toMatchObject({ note: { title: null } });
    // A call stored before titles reads as untitled.
    expect(tool.parse(note, today)).toMatchObject({ note: { title: null } });
    expect(tool.parse({ ...note, title: 'x'.repeat(121) }, today)).toBeNull();
    expect(tool.parse({ ...note, title: 'Alumni\ndinner' }, today)).toBeNull();
  });

  it('D59 slice 4: propose_note takes `plain`, required; absent or anything but true reads as false (the card)', () => {
    const tool = toolNamed('propose_note');
    if (tool === undefined) throw new Error('no propose_note');
    const schema = tool.definition.input_schema as { properties: Record<string, { type?: unknown }>; required: string[] };
    expect(schema.properties.plain?.type).toBe('boolean');
    expect(schema.required).toContain('plain');
    expect(tool.definition.description).toContain('Set plain to true only when the person’s own message in this turn stated this event');
    const note = {
      kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'more_guests', expectedGuests: 70,
      detail: null, title: 'Alumni dinner',
    };
    expect(tool.parse({ ...note, plain: true }, today)).toMatchObject({ plain: true, note: { title: 'Alumni dinner' } });
    for (const plain of [false, 'true', 1, null, undefined]) expect(tool.parse({ ...note, plain }, today)).toMatchObject({ plain: false });
    // The note itself never carries the mark: it is not a note field.
    expect((tool.parse({ ...note, plain: true }, today) as { note: Record<string, unknown> }).note).not.toHaveProperty('plain');
  });

  it('D59 slice 4: a plain note is only proposed, with nothing read or written, once the turn has read a file, a picture or a web page, or for staff open as admin', async () => {
    const tool = toolNamed('propose_note');
    if (tool === undefined) throw new Error('no propose_note');
    // Any store or switch read throws: these refusals come first.
    const untouchable = new Proxy({}, { get: () => { throw new Error('read a store'); } });
    const base = {
      ctx: { stores: untouchable, config: untouchable, now: () => new Date('2026-06-01T12:00:00.000Z') } as unknown as TownwiseContext,
      scope: { orgId: '000000000000000000000003' } as unknown as OrgScope, conversationId: '0000000000000000000000c1',
      location: { id: '000000000000000000000004' }, today, timeZone: 'America/New_York', role: 'member',
      files: { attached: new Set(), by: 0, bytes: { reserve: () => false, release: () => undefined }, sent: new Map() },
    };
    const member = { actorUserId: 'u1', actorEmail: 'member@example.test', actorRole: 'member', viewAsGrantId: null };
    const contexts = [
      { ...base, actor: member, turn: { readUntrusted: true, readWeb: false, pictureBytes: 0 } },
      { ...base, actor: member, turn: { readUntrusted: true, readWeb: true, pictureBytes: 0 } },
      { ...base, actor: { ...member, actorRole: 'superadmin', viewAsGrantId: 'g1' }, turn: { readUntrusted: false, readWeb: false, pictureBytes: 0 } },
    ] as unknown as ToolContext[];
    const input = tool.parse({
      kind: 'closure', startDate: '2026-06-20', endDate: '2026-06-20', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
      title: null, plain: true,
    }, today);
    for (const tc of contexts) {
      const run = await tool.run(tc, input, 'toolu_1');
      expect(run.content).toBe('Shown to the owner as a proposal. They decide whether to add it.');
      expect(run.saved).toBeUndefined();
    }
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
      effect: 'more_guests', expectedGuests: 60, detail: 'Sentinel-day-detail', title: null, startTime: null, endTime: null, createdBy: SENTINEL_USER, byStaff: false, source: null, fromEvent: null, agent: null,
      createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z'), ...fields,
    };
  }

  function context(opts: {
    days?: SalesDayWithUpload[]; notes?: NoteRecord[]; rules?: Pick<BusinessRuleRecord, 'id' | 'schedule'>[]; uploads?: UploadRecord[]; townId?: Town['townId'];
    today?: string;
  } = {}) {
    const byIds: string[][] = [];
    const ranges: { from: string; to: string }[] = [];
    const upload: UploadRecord = {
      id: UPLOAD_ID, locationId: '000000000000000000000001', uploadedBy: SENTINEL_USER, uploadedAt: new Date('2026-11-23T03:30:00Z'),
      status: 'applied', dayCount: 7, inserted: 7, replaced: 0, kept: 0, firstDate: '2026-11-16', lastDate: '2026-11-22', hasGuests: true,
      hasNetSales: true, byStaff: false, disabledAt: null, disabledBy: null, source: null,
    };
    const stores = {
      salesDays: {
        history: () => Promise.resolve(opts.days ?? []),
        days: (_scope: OrgScope, _location: string, range: { from: string; to: string }) => {
          ranges.push(range);
          return Promise.resolve((opts.days ?? []).filter((day) => day.date >= range.from && day.date <= range.to)
            .map(({ date, guests, netSalesCents }) => ({ date, guests, netSalesCents })));
        },
        uploadIdsIn: (_scope: OrgScope, _location: string, range: { from: string; to: string }) => Promise.resolve([
          ...new Set((opts.days ?? []).filter((day) => day.date >= range.from && day.date <= range.to).map((day) => day.uploadId)),
        ].sort()),
      } as unknown as SalesDayStore,
      notes: { list: () => Promise.resolve(opts.notes ?? []) } as unknown as NoteStore,
      businessRules: { scheduled: () => Promise.resolve(opts.rules ?? []) } as unknown as BusinessRuleStore,
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
      conversationId: '0000000000000000000000c1',
      location: {
        id: '000000000000000000000001', name: 'Test Taproom', placeId: null, createdAt: new Date('2026-01-01T00:00:00Z'),
        town: { townId: opts.townId === undefined ? 'hanover-nh' : opts.townId, name: 'Hanover', state: 'NH' },
      },
      today: opts.today ?? TODAY,
      timeZone: 'America/New_York',
      role: 'member',
      actor: { actorUserId: SENTINEL_USER, actorEmail: 'member@example.test', actorRole: 'member', viewAsGrantId: null },
      turn: { readUntrusted: false, readWeb: false, pictureBytes: 0 },
      files: { attached: new Set(), by: 0, bytes: { reserve: () => false, release: () => undefined }, sent: new Map() },
    };
    return { tc, byIds, ranges };
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

  it('list_notes includes startTime and endTime, and get_day\'s notes carry them in the same shape (contract S5)', async () => {
    const timed = note({ startTime: '18:00', endTime: '21:00', title: 'Sentinel-day-title' });
    const { tc } = context({ notes: [timed] });
    const tool = toolNamed('list_notes');
    if (tool === undefined) throw new Error('no list_notes');
    const listed = JSON.parse((await tool.run(tc, {})).content) as { notes: Record<string, unknown>[] };
    const shape = {
      kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null, startTime: '18:00', endTime: '21:00',
      effect: 'more_guests', expectedGuests: 60, title: 'Sentinel-day-title', detail: 'Sentinel-day-detail',
    };
    expect(listed.notes).toEqual([shape]);
    expect(Object.keys(listed.notes[0] ?? {})).toEqual(Object.keys(shape));
    expect(tool.definition.description).toBe(
      'The notes already recorded for this location, by start date: kind, dates, weekdays, hours, effect, expected guests, title (the event’s name, or null) and detail.',
    );
    expect(toolNamed('get_day')?.definition.description).toContain('the notes that cover it (each with its title, the event’s name, or null)');
    const day = (await run({ date: '2026-11-21' }, tc)).parsed.notes as Record<string, unknown>[];
    expect(day).toEqual([shape]);
    expect(Object.keys(day[0] ?? {})).toEqual(Object.keys(shape));
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

  // Spec D32: Saturdays of 120 guests, then near-empty ones, all before the town's today (AFTER). Synthetic.
  const AFTER = '2026-12-01';
  const saturdays = ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14']
    .map((date) => ({ date, guests: 120, netSalesCents: 240_000, uploadId: UPLOAD_ID }));
  const nearEmpty = (date: string) => ({ date, guests: 1, netSalesCents: 2_500, uploadId: UPLOAD_ID });

  it('says a near-empty day is likely closed (spec D32), unless a note says more or fewer guests; an all-zero day is closed', async () => {
    const days = [...saturdays, nearEmpty('2026-11-21')];
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days }).tc)).parsed)
      .toMatchObject({ sales: { guests: 1, netSalesUsd: 25 }, closed: true, likelyClosed: true, dayClass: 'closed' });
    const slow = note({ kind: 'other', effect: 'fewer_guests', expectedGuests: null, detail: null });
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days, notes: [slow] }).tc)).parsed)
      .toMatchObject({ closed: false, likelyClosed: false, dayClass: 'noted' });
    const zero = [...saturdays, { date: '2026-11-21', guests: 0, netSalesCents: 0, uploadId: UPLOAD_ID }];
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days: zero }).tc)).parsed).toMatchObject({ closed: true, likelyClosed: false });
    expect((await run({ date: '2026-11-14' }, context({ today: AFTER, days }).tc)).parsed).toMatchObject({ closed: false, likelyClosed: false });
  });

  it('a covering rule schedule with more or fewer guests keeps a near-empty day open, as a note does; other effects change nothing', async () => {
    const days = [...saturdays, nearEmpty('2026-11-21')];
    const rule = (effect: 'more_guests' | 'fewer_guests' | 'unknown' | 'closed', endDate: string | null = null) => ({
      id: 'r1', schedule: { kind: 'other' as const, startDate: '2026-11-01', endDate, weekdays: null, effect, expectedGuests: null, startTime: null, endTime: null },
    });
    for (const effect of ['more_guests', 'fewer_guests'] as const) {
      expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days, rules: [rule(effect)] }).tc)).parsed)
        .toMatchObject({ closed: false, likelyClosed: false });
    }
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days, rules: [rule('unknown')] }).tc)).parsed)
      .toMatchObject({ closed: true, likelyClosed: true });
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days, rules: [rule('more_guests', '2026-11-20')] }).tc)).parsed)
      .toMatchObject({ likelyClosed: true });
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days, rules: [rule('closed')] }).tc)).parsed)
      .toMatchObject({ closed: true, likelyClosed: false });
    const tool = toolNamed('get_sales_days');
    const range = tool?.parse({ from: '2026-11-21', to: '2026-11-21' }, TODAY) ?? null;
    if (tool === undefined || range === null) throw new Error('invalid input');
    const sales = async (rules: ReturnType<typeof rule>[]) =>
      (JSON.parse((await tool.run(context({ today: AFTER, days, rules }).tc, range)).content) as { days: object[] }).days;
    expect(await sales([rule('fewer_guests')])).toEqual([{ date: '2026-11-21', guests: 1, netSalesUsd: 25 }]);
    expect(await sales([])).toEqual([{ date: '2026-11-21', guests: 1, netSalesUsd: 25, likelyClosed: true }]);
  });

  it('get_sales_days reads the 8 weeks before the range too, gives only the range, marks likely-closed days (spec D32) and names the range’s uploads by ref (P25)', async () => {
    const OTHER_UPLOAD = '0000000000000000000000c2';
    const days = [...saturdays, nearEmpty('2026-11-21'), { ...nearEmpty('2026-11-28'), uploadId: OTHER_UPLOAD }];
    const slow = note({ kind: 'other', startDate: '2026-11-28', endDate: '2026-11-28', effect: 'fewer_guests', expectedGuests: null, detail: null });
    const { tc, ranges } = context({ today: AFTER, days, notes: [slow] });
    const tool = toolNamed('get_sales_days');
    const range = tool?.parse({ from: '2026-11-14', to: '2026-11-30' }, TODAY) ?? null;
    if (tool === undefined || range === null) throw new Error('invalid input');
    const parsed = JSON.parse((await tool.run(tc, range)).content) as { from: string; to: string; days: unknown[] };
    expect(ranges).toEqual([{ from: '2026-09-19', to: '2026-11-30' }]);
    expect(parsed).toEqual({
      from: '2026-11-14', to: '2026-11-30',
      days: [
        { date: '2026-11-14', guests: 120, netSalesUsd: 2400 },
        { date: '2026-11-21', guests: 1, netSalesUsd: 25, likelyClosed: true },
        { date: '2026-11-28', guests: 1, netSalesUsd: 25 },
      ],
      // Only the uploads holding the range's days, not the 8 weeks read before it (every saturday is UPLOAD_ID's too).
      uploadRefs: [`u_${UPLOAD_ID}`, `u_${OTHER_UPLOAD}`],
    });
    const before = tool.parse({ from: '2026-10-03', to: '2026-10-10' }, TODAY);
    if (before === null) throw new Error('invalid input');
    expect(JSON.parse((await tool.run(tc, before)).content)).toMatchObject({ uploadRefs: [`u_${UPLOAD_ID}`] });
    expect(tool.definition.description).toContain('likelyClosed');
    expect(toolNamed('get_day')?.definition.description).toContain('likelyClosed');
  });

  it('never calls today or a later day likely closed: its upload may be partial (spec D32)', async () => {
    const days = [...saturdays, nearEmpty('2026-11-21')];
    expect((await run({ date: '2026-11-21' }, context({ today: '2026-11-21', days }).tc)).parsed)
      .toMatchObject({ closed: false, likelyClosed: false });
    expect((await run({ date: '2026-11-21' }, context({ today: '2026-11-20', days }).tc)).parsed).toMatchObject({ closed: false, likelyClosed: false });
    const tool = toolNamed('get_sales_days');
    const range = tool?.parse({ from: '2026-11-21', to: '2026-11-21' }, '2026-11-21') ?? null;
    if (tool === undefined || range === null) throw new Error('invalid input');
    expect(JSON.parse((await tool.run(context({ today: '2026-11-21', days }).tc, range)).content)).toMatchObject({
      days: [{ date: '2026-11-21', guests: 1, netSalesUsd: 25 }],
    });
    expect(tool.definition.description).toContain('before today');
  });

  it('a past day’s real guests beat a closure rule; it closes a day with few or no guests, and today a one-day note beats it (spec D31, D32)', async () => {
    const days = [...saturdays, nearEmpty('2026-11-21')];
    const closedSaturdays = {
      id: 'r2', schedule: { kind: 'closure' as const, startDate: '2026-10-01', endDate: null, weekdays: [6], effect: 'closed' as const, expectedGuests: null, startTime: null, endTime: null },
    };
    expect((await run({ date: '2026-11-14' }, context({ today: AFTER, days, rules: [closedSaturdays] }).tc)).parsed)
      .toMatchObject({ closed: false, likelyClosed: false, dayClass: 'regular' });
    expect((await run({ date: '2026-11-21' }, context({ today: AFTER, days, rules: [closedSaturdays] }).tc)).parsed)
      .toMatchObject({ closed: true, likelyClosed: false, dayClass: 'closed' });
    // From today on the rule closes the day, unless a note on the day says it is open.
    const busy = [...saturdays, { ...nearEmpty('2026-11-21'), guests: 90 }];
    expect((await run({ date: '2026-11-21' }, context({ today: '2026-11-21', days: busy, rules: [closedSaturdays] }).tc)).parsed)
      .toMatchObject({ closed: true, dayClass: 'closed' });
    const opening = note({ kind: 'opening', effect: 'unknown', expectedGuests: null, detail: null });
    expect((await run({ date: '2026-11-21' }, context({ today: '2026-11-21', days: busy, notes: [opening], rules: [closedSaturdays] }).tc)).parsed)
      .toMatchObject({ closed: false, dayClass: 'noted' });
    expect(toolNamed('get_day')?.definition.description).toContain('before today');
  });

  it('is named in the system prompt, with which kind each of its figures is', () => {
    expect(SYSTEM_PROMPT).toContain('When the owner asks about one day, call get_day: it gives that day\'s sales, whether it was closed, the notes and town calendar entries that cover it, and when its data was uploaded. Its sales are the owner\'s own history; its calendar entries are public town data.');
  });
});

// Your data: propose_data_item shows the owner a card proposing to keep text; it never writes.
describe('propose_data_item', () => {
  const TODAY = '2026-11-05';
  const tool = toolNamed('propose_data_item');
  const tcWith = (on: boolean): ToolContext => ({ ctx: { items: { on } } } as unknown as ToolContext);

  it('shows only the text’s length and whether a card was shown, and refuses a title over 120 characters, an empty text or another key', () => {
    expect(inputViewOf('propose_data_item', { title: 'a', text: 'abc' }, TODAY)).toEqual({ chars: 3 });
    expect(resultViewOf('propose_data_item', { type: 'tool_result', tool_use_id: 't1', content: 'Shown to the owner as a proposal. They decide whether to keep it.' })).toEqual({ shown: true });
    const off = JSON.stringify({ available: false, reason: 'Townwise can’t keep items yet, so nothing was shown to the owner.' });
    expect(resultViewOf('propose_data_item', { type: 'tool_result', tool_use_id: 't1', content: off })).toEqual({ shown: false });
    for (const bad of [
      { title: 'a'.repeat(121), text: 'abc' }, { title: 'a', text: 'abc', extra: 1 }, { title: 'a', text: '' }, { title: '  ', text: 'abc' },
      { title: 'a', text: 'b'.repeat(10_001) }, { text: 'abc' }, { title: 'a' },
    ]) expect(inputViewOf('propose_data_item', bad, TODAY)).toBeNull();
    expect(tool?.parse({ title: 'a'.repeat(120), text: 'b'.repeat(10_000) }, TODAY)).not.toBeNull();
    // The text is kept exactly as given; the title is trimmed, as a pasted item's is.
    expect(tool?.parse({ title: ' Catering list ', text: '  Party of 40\n' }, TODAY)).toEqual({ title: 'Catering list', text: '  Party of 40\n' });
  });

  it('asks the model for the caps a pasted item has', () => {
    expect(tool?.definition.input_schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: TEXT_ITEM_TITLE_MAX },
        text: { type: 'string', minLength: 1, maxLength: TEXT_ITEM_MAX_CHARS },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    });
    expect(tool?.definition.description).toBe('Shows the owner a card proposing to keep text on their Your data page, with Keep and Not now. It never saves anything. Use it only for text the owner gave you in this conversation and asked to keep, copied exactly, with a short title of your own that names no person.');
  });

  it('answers that the card was shown, or available false while stored files are off', async () => {
    const input = { title: 'Catering list', text: 'Party of 40 on Dec 12' };
    expect(await tool?.run(tcWith(true), input)).toEqual({ content: 'Shown to the owner as a proposal. They decide whether to keep it.' });
    const off = await tool?.run(tcWith(false), input);
    expect(JSON.parse(off?.content ?? '')).toEqual({ available: false, reason: 'Townwise can’t keep items yet, so nothing was shown to the owner.' });
    expect(off?.proposal).toBeUndefined();
  });

  it('is named in the system prompt, which says the owner decides', () => {
    expect(SYSTEM_PROMPT).toContain('call propose_data_item with the text exactly as they gave it and a short title. The owner sees a card and decides; never say it was kept.');
  });
});
