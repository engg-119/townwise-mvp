// The TownwiseAI tool registry (docs/portal/tuning-chat.md section 4), without Docker: the frozen, append-only order
// of the tools, what the model is sent, and the input and result views each tool call's card shows.
import { describe, expect, it } from 'vitest';

import { townProfileOf } from '../src/handlers/towns.ts';
import { inputViewOf, resultViewOf, TOOL_REGISTRY, TOOLS, toolNamed, type ToolView } from '../src/chat/tools/registry.ts';

/**
 * The contract. Append a new tool's name at the end in the PR that registers it; never rename, remove or move one,
 * because stored conversations name their tool calls and the prompt cache keys on this list. The client's tool table
 * (client/src/chat/tools.ts), once it exists, lists the same names.
 */
const FROZEN_NAMES = ['get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note'];

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
    expect(toolNamed('get_forecast')).toBeUndefined();
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
