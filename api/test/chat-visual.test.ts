// TownwiseAI's visuals and next questions (docs/portal/tuning-chat.md section 4), without Docker: show_visual's input
// rules and the figures each kind computes from the location's days and the published forecast, how a stored result
// is rebuilt, suggest_next's three prompts, both tools' null views, and how a stored reply replays them. Synthetic data.
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { nextOf, suggestNextTool } from '../src/chat/tools/next.ts';
import { inputViewOf, resultViewOf, type ToolContext } from '../src/chat/tools/registry.ts';
import {
  breakdownVisual, dailyVisual, daysTableVisual, metricsVisual, showVisualTool, visualOf, type Visual, type VisualRequest,
} from '../src/chat/tools/visual.ts';
import { nodesOf } from '../src/chat/tree.ts';
import { chatMessageViews } from '../src/chat/view.ts';
import type { ForecastDayView, ForecastWindow, ForecastWindowRun } from '../src/forecasts/reader.ts';
import type { Closure } from '../src/closed-days.ts';
import { utcDay } from '../src/dates.ts';
import type { BusinessRuleRecord } from '../src/stores/business-rules.ts';
import type { NoteRecord } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';
import { weekdayOf } from '../src/time-zones.ts';

const TODAY = '2026-11-05';
const SHOWN = 'Shown to the owner under your reply. Describe it in a sentence or two; don’t repeat every figure.';
const SHOWN_FORECAST = `${SHOWN} Give the forecast as its range.`;
const NO_SALES = { available: false, reason: 'No sales in this range, so nothing was shown.' };
const NO_SALES_OR_FORECAST = { available: false, reason: 'No sales or published forecast in this range, so nothing was shown.' };
const GUESTS_ONLY = { available: false, reason: 'Townwise forecasts guests only, so there are no net sales to show for future days.' };
const run = { model: 'Townwise demand model v0', madeAt: '2026-09-30' };

function req(
  kind: VisualRequest['kind'], metric: VisualRequest['metric'], from: string, to: string,
  opts: { by?: VisualRequest['by']; compare?: VisualRequest['compare'] } = {},
): VisualRequest {
  return { kind, metric, from, to, by: opts.by ?? null, compare: opts.compare ?? null };
}

function day(date: string, guests: number | null, netSalesCents: number | null = null): SalesDay {
  return { date, guests, netSalesCents };
}

function fc(date: string, low: number | null, high: number | null): ForecastDayView {
  const status = low === null ? 'closed' : 'open';
  const mid = low === null || high === null ? null : (low + high) / 2;
  return {
    date, weekday: weekdayOf(date), status, low, mid, high, baseline: null, reasons: [], runId: 'run-0001', madeAt: run.madeAt,
    madeAfterDay: false, actual: null, inRange: null, model: { status, low, mid, high }, noteGuests: 0, moreNotes: 0, moreRules: 0,
  };
}

describe('the figures of each kind', () => {
  it('daily: one row per day in the range, nulls for days with no row, the band only where a published forecast covers guests', () => {
    const v = dailyVisual(req('daily', 'guests', '2026-10-01', '2026-10-03'), [day('2026-10-01', 40), day('2026-10-03', 52)], [fc('2026-10-03', 45, 60)], run);
    expect(v).toEqual({
      kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-03', forecast: { model: run.model, madeAt: run.madeAt },
      days: [
        { date: '2026-10-01', value: 40, low: null, mid: null, high: null }, { date: '2026-10-02', value: null, low: null, mid: null, high: null },
        { date: '2026-10-03', value: 52, low: 45, mid: 53, high: 60 },
      ],
    });
  });

  it('daily: the band rounds low down and high up, as get_forecast does; a closed forecast day has none; no band, no forecast', () => {
    const v = dailyVisual(req('daily', 'guests', '2026-10-01', '2026-10-02'), [day('2026-10-01', 40)], [fc('2026-10-01', 44.6, 59.2), fc('2026-10-02', null, null)], run);
    expect(v).toMatchObject({ days: [{ low: 44, high: 60 }, { low: null, mid: null, high: null, status: 'closed' }], forecast: run });
    const none = dailyVisual(req('daily', 'guests', '2026-10-01', '2026-10-01'), [day('2026-10-01', 40)], [fc('2026-10-01', null, null)], run);
    expect(none).toMatchObject({ forecast: null, days: [{ value: 40, low: null, high: null }] });
    expect(dailyVisual(req('daily', 'guests', '2026-10-01', '2026-10-01'), [day('2026-10-01', 40)], [], null)).toMatchObject({ forecast: null });
  });

  it('daily: the band is the day’s range with the owner’s notes, the low and high get_forecast and the Calendar give (spec 14.5)', () => {
    const noted: ForecastDayView = { ...fc('2026-10-01', 45, 60), low: 115.4, mid: 122.5, high: 129.6, noteGuests: 70 };
    const booked: ForecastDayView = { ...fc('2026-10-02', 45, 60), status: 'booked', low: null, mid: null, high: null, noteGuests: 50 };
    // A day the model closed that a private event of 70 opened.
    const opened: ForecastDayView = { ...fc('2026-10-03', null, null), status: 'open', low: 70, mid: 70, high: 70, noteGuests: 70 };
    const v = dailyVisual(req('daily', 'guests', '2026-10-01', '2026-10-03'), [], [noted, booked, opened], run);
    expect(v).toMatchObject({
      days: [{ low: 115, mid: 123, high: 130 }, { low: null, mid: null, high: null, status: 'booked' }, { low: 70, mid: 70, high: 70 }], forecast: run,
    });
  });

  it('daily: the middle rounds to the nearest guest, as get_forecast gives it; a status only on a closed or booked day', () => {
    const open: ForecastDayView = { ...fc('2026-11-16', 117.4, 255.2), mid: 180.5 };
    const quiet: ForecastDayView = { ...fc('2026-11-17', 60.9, 90.1), mid: 75.49 };
    const closed = fc('2026-11-18', null, null);
    const booked: ForecastDayView = { ...fc('2026-11-19', 45, 60), status: 'booked', low: null, mid: null, high: null, noteGuests: 50 };
    const v = dailyVisual(req('daily', 'guests', '2026-11-16', '2026-11-20'), [], [open, quiet, closed, booked], run);
    expect(v).toEqual({
      kind: 'daily', metric: 'guests', from: '2026-11-16', to: '2026-11-20', forecast: run,
      days: [
        { date: '2026-11-16', value: null, low: 117, mid: 181, high: 256 },
        { date: '2026-11-17', value: null, low: 60, mid: 75, high: 91 },
        { date: '2026-11-18', value: null, low: null, mid: null, high: null, status: 'closed' },
        { date: '2026-11-19', value: null, low: null, mid: null, high: null, status: 'booked' },
        { date: '2026-11-20', value: null, low: null, mid: null, high: null },
      ],
    });
    // Net sales never carry the forecast's middle or status.
    expect(dailyVisual(req('daily', 'netSales', '2026-11-18', '2026-11-18'), [], [closed], run)).toMatchObject({
      days: [{ date: '2026-11-18', value: null, low: null, mid: null, high: null }], forecast: null,
    });
  });

  it('daily net sales never carries a band, and gives dollars', () => {
    const v = dailyVisual(req('daily', 'netSales', '2026-10-01', '2026-10-02'), [day('2026-10-01', 40, 123_456), day('2026-10-02', 52, null)], [fc('2026-10-01', 45, 60)], run);
    expect(v).toEqual({
      kind: 'daily', metric: 'netSales', from: '2026-10-01', to: '2026-10-02', forecast: null,
      days: [{ date: '2026-10-01', value: 1234.56, low: null, mid: null, high: null }, { date: '2026-10-02', value: null, low: null, mid: null, high: null }],
    });
  });

  it('breakdown averages days with a value by weekday (Sunday 0) or month, with each day count', () => {
    // Sun Oct 4 to Sat Oct 17, 2026.
    const weekdays = breakdownVisual(req('breakdown', 'guests', '2026-10-04', '2026-10-17', { by: 'weekday' }), [
      day('2026-10-04', 30), day('2026-10-11', 50),
      day('2026-10-05', 10), day('2026-10-12', null),
      day('2026-10-10', 41), day('2026-10-17', 42),
    ]);
    // Monday first, as Analytics' weekly shape runs; every weekday, a weekday with no value null with 0 days.
    expect(weekdays).toEqual({
      kind: 'breakdown', metric: 'guests', from: '2026-10-04', to: '2026-10-17', by: 'weekday',
      bars: [
        { key: '1', value: 10, days: 1 }, { key: '2', value: null, days: 0 }, { key: '3', value: null, days: 0 },
        { key: '4', value: null, days: 0 }, { key: '5', value: null, days: 0 }, { key: '6', value: 42, days: 2 },
        { key: '0', value: 40, days: 2 },
      ],
    });
    const months = breakdownVisual(req('breakdown', 'netSales', '2026-09-15', '2026-11-02', { by: 'month' }), [
      day('2026-09-15', 10, 10_001), day('2026-09-16', 12, 10_002), day('2026-09-17', 14, null), day('2026-11-02', 9, 50_000),
    ]);
    // Every month the range touches; dollars averaged to the cent.
    expect(months).toEqual({
      kind: 'breakdown', metric: 'netSales', from: '2026-09-15', to: '2026-11-02', by: 'month',
      bars: [{ key: '2026-09', value: 100.02, days: 2 }, { key: '2026-10', value: null, days: 0 }, { key: '2026-11', value: 500, days: 1 }],
    });
  });

  it('days_table: one row per day with guests and net sales in dollars, nulls where not recorded', () => {
    expect(daysTableVisual(req('days_table', null, '2026-10-01', '2026-10-03'), [day('2026-10-01', 40, 123_450), day('2026-10-03', null, 99)])).toEqual({
      kind: 'days_table', from: '2026-10-01', to: '2026-10-03',
      rows: [
        { date: '2026-10-01', guests: 40, netSales: 1234.5 }, { date: '2026-10-02', guests: null, netSales: null },
        { date: '2026-10-03', guests: null, netSales: 0.99 },
      ],
    });
  });

  it('metrics compares with the same dates 364 days earlier, or the same number of days before', () => {
    const range = req('metrics', 'guests', '2026-10-01', '2026-10-03', { compare: 'last_year' });
    const days = [day('2026-10-01', 40), day('2026-10-02', null), day('2026-10-03', 53)];
    expect(metricsVisual(range, days, [day('2025-10-02', 30)])).toEqual({
      kind: 'metrics', metric: 'guests', from: '2026-10-01', to: '2026-10-03', total: 93, dailyAverage: 47, dayCount: 2,
      compare: { basis: 'last_year', from: '2025-10-02', to: '2025-10-04', total: 30, dayCount: 1 },
    });
    expect(metricsVisual({ ...range, compare: 'previous_period' }, days, [])).toMatchObject({
      compare: { basis: 'previous_period', from: '2026-09-28', to: '2026-09-30', total: null, dayCount: 0 },
    });
    expect(metricsVisual({ ...range, compare: null }, days, null)).toMatchObject({ compare: null });
    // Net sales in dollars, the average to the cent.
    expect(metricsVisual(req('metrics', 'netSales', '2026-10-01', '2026-10-03'), [day('2026-10-01', 1, 10_000), day('2026-10-02', 1, 10_001)], null))
      .toMatchObject({ total: 200.01, dailyAverage: 100.01, dayCount: 2, compare: null });
  });

  // Spec D32: closed and likely-closed days are closures, not slow days, as Analytics treats them.
  const closures: Readonly<Record<string, Closure>> = { '2026-10-05': 'likely_closed', '2026-10-12': 'closed', '2025-10-03': 'likely_closed' };
  const closureOn = (each: SalesDay): Closure | null => closures[each.date] ?? null;

  it('breakdown and metrics average open days only: closed and likely-closed days are left out, as Analytics leaves them out', () => {
    const days = [day('2026-10-05', 2), day('2026-10-12', 0, 0), day('2026-10-19', 90), day('2026-10-26', 110)];
    const weekdays = breakdownVisual(req('breakdown', 'guests', '2026-10-05', '2026-10-26', { by: 'weekday' }), days, closureOn);
    expect(weekdays.kind === 'breakdown' ? weekdays.bars[0] : null).toEqual({ key: '1', value: 100, days: 2 });
    // The total keeps every recorded guest; the average and the day count are over open days.
    const range = req('metrics', 'guests', '2026-10-05', '2026-10-26', { compare: 'last_year' });
    expect(metricsVisual(range, days, [day('2025-10-03', 1), day('2025-10-10', 80)], closureOn)).toMatchObject({
      total: 202, dailyAverage: 100, dayCount: 2, compare: { total: 81, dayCount: 1 },
    });
  });

  it('days_table marks a likely-closed day’s row', () => {
    expect(daysTableVisual(req('days_table', null, '2026-10-05', '2026-10-06'), [day('2026-10-05', 2), day('2026-10-06', 50)], closureOn)).toEqual({
      kind: 'days_table', from: '2026-10-05', to: '2026-10-06',
      rows: [{ date: '2026-10-05', guests: 2, netSales: null, likelyClosed: true }, { date: '2026-10-06', guests: 50, netSales: null }],
    });
    expect(showVisualTool.definition.description).toContain('likelyClosed');
  });
});

describe('show_visual’s input', () => {
  const raw = (fields: Record<string, unknown>) => ({ kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-31', by: null, compare: null, ...fields });
  const parse = (fields: Record<string, unknown>) => showVisualTool.parse(raw(fields), TODAY);

  it('names what to draw, maps net_sales to netSales, and keeps by and compare only for the kinds that use them', () => {
    expect(parse({})).toEqual({ kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-31', by: null, compare: null });
    expect(parse({ metric: 'net_sales', by: 'weekday', compare: 'last_year' })).toEqual({
      kind: 'daily', metric: 'netSales', from: '2026-10-01', to: '2026-10-31', by: null, compare: null,
    });
    expect(parse({ kind: 'breakdown', by: 'month' })).toMatchObject({ kind: 'breakdown', by: 'month', compare: null });
    expect(parse({ kind: 'metrics', compare: 'previous_period', by: 'month' })).toMatchObject({ kind: 'metrics', by: null, compare: 'previous_period' });
    expect(parse({ kind: 'days_table', metric: 'guests' })).toMatchObject({ kind: 'days_table', metric: null });
  });

  it('refuses ranges past each kind’s limit, a future to for history kinds, a missing metric and an unknown kind', () => {
    expect(showVisualTool.parse({ kind: 'days_table', metric: null, from: '2026-01-01', to: '2026-02-15', by: null, compare: null }, TODAY)).toBeNull();
    // daily: at most 92 days, to at most 31 days after today.
    expect(parse({ from: '2026-08-05', to: '2026-11-04' })).not.toBeNull();
    expect(parse({ from: '2026-08-04', to: '2026-11-04' })).toBeNull();
    expect(parse({ from: '2026-11-01', to: '2026-12-06' })).not.toBeNull();
    expect(parse({ from: '2026-11-01', to: '2026-12-07' })).toBeNull();
    // breakdown: at most 731 days, ending today or earlier.
    expect(parse({ kind: 'breakdown', by: 'month', from: '2024-11-05', to: TODAY })).not.toBeNull();
    expect(parse({ kind: 'breakdown', by: 'month', from: '2024-11-04', to: TODAY })).toBeNull();
    expect(parse({ kind: 'breakdown', by: 'month', from: '2026-10-01', to: '2026-11-06' })).toBeNull();
    // days_table: at most 31 days, ending today or earlier.
    expect(parse({ kind: 'days_table', metric: null, from: '2026-10-06', to: TODAY })).not.toBeNull();
    expect(parse({ kind: 'days_table', metric: null, from: '2026-10-05', to: TODAY })).toBeNull();
    expect(parse({ kind: 'days_table', metric: null, from: '2026-11-01', to: '2026-11-06' })).toBeNull();
    // metrics: at most 366 days, ending today or earlier.
    expect(parse({ kind: 'metrics', from: '2025-11-05', to: TODAY })).not.toBeNull();
    expect(parse({ kind: 'metrics', from: '2025-11-04', to: TODAY })).toBeNull();
    expect(parse({ kind: 'metrics', from: '2026-11-01', to: '2026-11-06' })).toBeNull();
    // A missing metric, a breakdown with no by, an unknown kind or value, a missing key, a bad or backwards range.
    for (const bad of [
      { metric: null }, { kind: 'breakdown', metric: null, by: 'month' }, { kind: 'metrics', metric: null }, { kind: 'breakdown', by: null },
      { kind: 'heatmap' }, { metric: 'covers' }, { by: 'week' }, { compare: 'last_month' }, { from: '2026-02-30' }, { from: '10/01/2026' },
      { from: '2026-10-31', to: '2026-10-01' }, { from: '2009-12-31', to: '2010-01-01' }, { metric: undefined }, { compare: undefined },
    ]) expect({ bad, parsed: parse(bad) }).toEqual({ bad, parsed: null });
    expect(showVisualTool.parse('daily', TODAY)).toBeNull();
  });
});

describe('show_visual’s run', () => {
  const runOf = (label: string, dataThrough: string, madeAt: string) => ({
    id: `run-${label}`, model: { family: 'f', version: label, label: `Townwise demand model ${label}` }, dataThrough, madeAt,
  }) as unknown as ForecastWindowRun;
  const EMPTY: ForecastWindow = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], notCovered: [] };

  function context(
    days: SalesDay[], windowOf: (range: { from: string; to: string }) => ForecastWindow = () => EMPTY,
    saved: { notes?: NoteRecord[]; rules?: Pick<BusinessRuleRecord, 'id' | 'schedule'>[] } = {},
  ) {
    const dayReads: { from: string; to: string }[] = [];
    const windowReads: { from: string; to: string }[] = [];
    const ctx = {
      stores: {
        salesDays: {
          days: (_scope: OrgScope, _location: string, range: { from: string; to: string }) => {
            dayReads.push(range);
            return Promise.resolve(days.filter((d) => d.date >= range.from && d.date <= range.to));
          },
        },
        notes: { list: () => Promise.resolve(saved.notes ?? []) },
        businessRules: { scheduled: () => Promise.resolve(saved.rules ?? []) },
      },
      ports: {
        forecasts: {
          window: (_scope: OrgScope, _location: unknown, range: { from: string; to: string }, today: string) => {
            expect(today).toBe(TODAY);
            windowReads.push(range);
            return Promise.resolve(windowOf(range));
          },
        },
      },
    };
    const tc: ToolContext = {
      ctx: ctx as unknown as TownwiseContext,
      scope: { orgId: '000000000000000000000003' } as unknown as OrgScope,
      location: {
        id: '000000000000000000000001', name: 'Test Taproom', placeId: null, createdAt: new Date('2026-01-01T00:00:00Z'),
        town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
      },
      today: TODAY,
      timeZone: 'America/New_York',
      // The forecast lab's fields (#59); show_visual reads neither.
      role: 'member',
      actor: { actorUserId: '000000000000000000000002', actorEmail: 'member@example.test', actorRole: 'member', viewAsGrantId: null },
      turn: { readUntrusted: false, readWeb: false },
    };
    return { tc, dayReads, windowReads };
  }

  async function shown(tc: ToolContext, input: Record<string, unknown>): Promise<{ visual: Visual | undefined; content: unknown }> {
    const parsed = showVisualTool.parse(input, TODAY);
    if (parsed === null) throw new Error('invalid input');
    const result = await showVisualTool.run(tc, parsed);
    return { visual: result.visual, content: JSON.parse(result.content) };
  }

  it('daily guests read the published forecast in windows of at most 42 days, labeled with the newest run that supplied days', async () => {
    const older = runOf('v1', '2026-09-15', '2026-09-16');
    const newer = runOf('v2', '2026-10-25', '2026-10-26');
    const { tc, dayReads, windowReads } = context([day('2026-10-01', 40), day('2026-11-13', 60)], (range) => (range.from === '2026-10-01'
      ? { ...EMPTY, available: true, reason: null, runs: [older], days: [fc('2026-10-01', 30, 50)] }
      : { ...EMPTY, available: true, reason: null, runs: [newer], days: [fc('2026-11-13', 50, 70)] }));
    const { visual, content } = await shown(tc, { kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-11-15', by: null, compare: null });
    expect(dayReads).toEqual([{ from: '2026-10-01', to: '2026-11-15' }]);
    expect(windowReads).toEqual([{ from: '2026-10-01', to: '2026-11-11' }, { from: '2026-11-12', to: '2026-11-15' }]);
    expect(visual).toMatchObject({ kind: 'daily', forecast: { model: 'Townwise demand model v2', madeAt: '2026-10-26' } });
    if (visual?.kind !== 'daily') throw new Error('not daily');
    expect(visual.days).toHaveLength(46);
    expect(visual.days[0]).toEqual({ date: '2026-10-01', value: 40, low: 30, mid: 40, high: 50 });
    expect(visual.days.find((d) => d.date === '2026-11-13')).toEqual({ date: '2026-11-13', value: 60, low: 50, mid: 60, high: 70 });
    // The model reads the same figures, with what to do with them: Nov 13 is a forecast day from today on.
    expect(content).toEqual({ shown: SHOWN_FORECAST, visual });
  });

  it('daily net sales never read the forecast; metrics read the comparison range too', async () => {
    const net = context([day('2026-10-01', 40, 10_000)]);
    expect((await shown(net.tc, { kind: 'daily', metric: 'net_sales', from: '2026-10-01', to: '2026-10-02', by: null, compare: null })).visual)
      .toMatchObject({ forecast: null, days: [{ value: 100 }, { value: null }] });
    expect(net.windowReads).toEqual([]);

    const totals = context([day('2026-10-01', 40), day('2025-10-02', 30)]);
    const { visual } = await shown(totals.tc, { kind: 'metrics', metric: 'guests', from: '2026-10-01', to: '2026-10-03', by: null, compare: 'last_year' });
    // Each range with the 8 weeks before it, whose same weekdays say which days were likely closed (spec D32).
    expect(totals.dayReads).toEqual([{ from: '2026-08-06', to: '2026-10-03' }, { from: '2025-08-07', to: '2025-10-04' }]);
    expect(visual).toMatchObject({ total: 40, compare: { total: 30, dayCount: 1 } });
  });

  it('shows nothing and says so when no day in the range has a value; a days table needs either value', async () => {
    const empty = context([day('2026-10-01', null, null), day('2026-10-02', null, 5000)]);
    for (const input of [
      { kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-02', by: null, compare: null },
      { kind: 'breakdown', metric: 'guests', from: '2026-10-01', to: '2026-10-02', by: 'weekday', compare: null },
      { kind: 'metrics', metric: 'guests', from: '2026-10-01', to: '2026-10-02', by: null, compare: 'last_year' },
      { kind: 'days_table', metric: null, from: '2026-10-01', to: '2026-10-01', by: null, compare: null },
    ]) expect(await shown(empty.tc, input)).toEqual({ visual: undefined, content: NO_SALES });
    // Nothing more is read for a range with no sales.
    expect(empty.windowReads).toEqual([]);
    expect(empty.dayReads).toHaveLength(4);
    expect((await shown(empty.tc, { kind: 'days_table', metric: null, from: '2026-10-01', to: '2026-10-02', by: null, compare: null })).visual)
      .toMatchObject({ rows: [{ guests: null, netSales: null }, { guests: null, netSales: 50 }] });
  });

  it('daily guests for days with no sales yet show the published forecast, and the model is told to give it as its range', async () => {
    // The incident: next week, no sales yet, a published forecast. Mon Nov 9 to Sun Nov 15, today Thu Nov 5.
    const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
    const forecastDays = week.map((date, i): ForecastDayView => (i === 2 ? fc(date, null, null) : { ...fc(date, 117.4 + i, 255.2 + i), mid: 180.5 + i }));
    const newer = runOf('v2', '2026-11-04', '2026-11-05');
    const { tc, windowReads } = context([], () => ({ ...EMPTY, available: true, reason: null, runs: [newer], days: forecastDays }));
    const { visual, content } = await shown(tc, { kind: 'daily', metric: 'guests', from: '2026-11-09', to: '2026-11-15', by: null, compare: null });
    expect(windowReads).toEqual([{ from: '2026-11-09', to: '2026-11-15' }]);
    if (visual?.kind !== 'daily') throw new Error('not daily');
    expect(visual.forecast).toEqual({ model: 'Townwise demand model v2', madeAt: '2026-11-05' });
    expect(visual.days.slice(0, 3)).toEqual([
      { date: '2026-11-09', value: null, low: 117, mid: 181, high: 256 },
      { date: '2026-11-10', value: null, low: 118, mid: 182, high: 257 },
      { date: '2026-11-11', value: null, low: null, mid: null, high: null, status: 'closed' },
    ]);
    expect(content).toEqual({ shown: SHOWN_FORECAST, visual });
  });

  it('a range with values and forecast bands keeps both; the forecast line goes only with forecast days from today on', async () => {
    // Nov 3 and 4 have sales; Nov 3 to 7 have bands, Nov 5 (today) on are forecast days.
    const covered = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'].map((date) => fc(date, 40, 60));
    const mixed = context([day('2026-11-03', 44), day('2026-11-04', 58)], () => ({ ...EMPTY, available: true, reason: null, runs: [runOf('v2', '2026-11-01', '2026-11-02')], days: covered }));
    const both = await shown(mixed.tc, { kind: 'daily', metric: 'guests', from: '2026-11-03', to: '2026-11-07', by: null, compare: null });
    expect(both.visual).toMatchObject({
      days: [
        { value: 44, low: 40, mid: 50, high: 60 }, { value: 58, low: 40, mid: 50, high: 60 }, { value: null, low: 40, mid: 50, high: 60 },
        { value: null, low: 40 }, { value: null, low: 40 },
      ],
    });
    expect(both.content).toMatchObject({ shown: SHOWN_FORECAST });
    // A past range with bands is shown as before: its bands are what was forecast, not a forecast to give.
    const past = context([day('2026-10-01', 44)], () => ({ ...EMPTY, available: true, reason: null, runs: [runOf('v1', '2026-09-15', '2026-09-16')], days: [fc('2026-10-01', 40, 60)] }));
    expect((await shown(past.tc, { kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-02', by: null, compare: null })).content)
      .toMatchObject({ shown: SHOWN, visual: { days: [{ value: 44, low: 40, mid: 50, high: 60 }, { value: null, low: null, mid: null, high: null }] } });
  });

  it('days from today on whose forecast only closes or books them are still shown; the range line needs a band', async () => {
    const closedWeek = context([], () => ({ ...EMPTY, available: true, reason: null, runs: [runOf('v2', '2026-11-04', '2026-11-05')], days: [fc('2026-11-09', null, null)] }));
    const { visual, content } = await shown(closedWeek.tc, { kind: 'daily', metric: 'guests', from: '2026-11-09', to: '2026-11-10', by: null, compare: null });
    expect(visual).toMatchObject({ forecast: null, days: [{ status: 'closed' }, { low: null }] });
    expect(content).toMatchObject({ shown: SHOWN });
  });

  it('says why nothing was shown: no sales or forecast from today on, net sales after today, a past range with no sales', async () => {
    // No published run: the forecast is read, and there is nothing to show.
    const none = context([]);
    expect(await shown(none.tc, { kind: 'daily', metric: 'guests', from: '2026-11-09', to: '2026-11-15', by: null, compare: null }))
      .toEqual({ visual: undefined, content: NO_SALES_OR_FORECAST });
    expect(none.windowReads).toEqual([{ from: '2026-11-09', to: '2026-11-15' }]);
    // A range reaching today counts too, and a band only before today is no forecast to show.
    const before = context([], () => ({ ...EMPTY, available: true, reason: null, runs: [runOf('v1', '2026-10-01', '2026-10-02')], days: [fc('2026-11-04', 40, 60)] }));
    expect(await shown(before.tc, { kind: 'daily', metric: 'guests', from: '2026-11-04', to: '2026-11-06', by: null, compare: null }))
      .toEqual({ visual: undefined, content: NO_SALES_OR_FORECAST });
    // Net sales after today: the forecast is of guests only, and it is never read.
    const net = context([]);
    expect(await shown(net.tc, { kind: 'daily', metric: 'net_sales', from: '2026-11-06', to: '2026-11-12', by: null, compare: null }))
      .toEqual({ visual: undefined, content: GUESTS_ONLY });
    // A net sales range from today on is not wholly after it, so it has no sales, as before.
    expect(await shown(net.tc, { kind: 'daily', metric: 'net_sales', from: TODAY, to: '2026-11-12', by: null, compare: null }))
      .toEqual({ visual: undefined, content: NO_SALES });
    expect(net.windowReads).toEqual([]);
  });

  it('reads the notes, the rule schedules and the 8 weeks before the range to find closed and likely-closed days (spec D32)', async () => {
    // Mondays of 100 from Aug 3; Oct 5 near empty (likely closed), Oct 12 under a closure note, Oct 19 under a closure rule
    // with its 90 real guests (they beat the rule), Oct 26 the town's today in a later read.
    const mondays: SalesDay[] = [];
    for (let date = '2026-08-03'; date <= '2026-10-26'; date = utcDay(new Date(`${date}T00:00:00.000Z`), 7)) mondays.push(day(date, 100));
    const changed = new Map([['2026-10-05', 2], ['2026-10-19', 90]]);
    const days = mondays.map((each) => day(each.date, changed.get(each.date) ?? 100));
    const closure = {
      id: '0000000000000000000000aa', kind: 'closure', startDate: '2026-10-12', endDate: '2026-10-12', weekdays: null, effect: 'closed', expectedGuests: null,
      detail: null, startTime: null, endTime: null, createdBy: 'u', byStaff: false, source: null, createdAt: new Date(0), updatedAt: new Date(0),
    } satisfies NoteRecord;
    const rule = {
      id: 'r1', schedule: { kind: 'closure', startDate: '2026-10-19', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    } satisfies Pick<BusinessRuleRecord, 'id' | 'schedule'>;
    const { tc } = context(days, undefined, { notes: [closure], rules: [rule] });
    const breakdown = await shown(tc, { kind: 'breakdown', metric: 'guests', from: '2026-10-05', to: '2026-10-25', by: 'weekday', compare: null });
    expect(breakdown.visual?.kind === 'breakdown' ? breakdown.visual.bars[0] : null).toEqual({ key: '1', value: 90, days: 1 });
    const table = await shown(tc, { kind: 'days_table', metric: null, from: '2026-10-05', to: '2026-10-05', by: null, compare: null });
    expect(table.visual).toMatchObject({ rows: [{ date: '2026-10-05', guests: 2, likelyClosed: true }] });
  });

  it('visualOf rebuilds a stored visual and drops one that does not parse', () => {
    const visual = metricsVisual(req('metrics', 'guests', '2026-10-01', '2026-10-03'), [day('2026-10-01', 40)], null);
    expect(visualOf(JSON.stringify({ shown: SHOWN, visual }))).toEqual(visual);
    expect(visualOf(JSON.stringify(NO_SALES))).toBeNull();
    expect(visualOf('not json')).toBeNull();
    expect(visualOf(JSON.stringify({ shown: SHOWN, visual: { ...visual, kind: 'heatmap' } }))).toBeNull();
    expect(visualOf(JSON.stringify({ shown: SHOWN, visual: { kind: 'breakdown', metric: 'guests', from: '2026-10-01', to: '2026-10-03', by: 'weekday' } }))).toBeNull();
  });

  it('visualOf rebuilds a daily visual stored before mid and status, with mid null, and keeps a status', () => {
    const old = {
      kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-02', forecast: run,
      days: [{ date: '2026-10-01', value: 40, low: 30, high: 50 }, { date: '2026-10-02', value: null, low: null, high: null }],
    };
    expect(visualOf(JSON.stringify({ shown: SHOWN, visual: old }))).toEqual({
      ...old, days: [{ date: '2026-10-01', value: 40, low: 30, mid: null, high: 50 }, { date: '2026-10-02', value: null, low: null, mid: null, high: null }],
    });
    const visual = dailyVisual(req('daily', 'guests', '2026-11-09', '2026-11-10'), [], [{ ...fc('2026-11-09', 40, 60), mid: 50.4 }, fc('2026-11-10', null, null)], run);
    expect(visualOf(JSON.stringify({ shown: SHOWN_FORECAST, visual }))).toEqual(visual);
    expect(visualOf(JSON.stringify({ shown: SHOWN, visual: { ...old, days: [{ ...old.days[0], mid: 40, status: 'open' }] } }))).toBeNull();
  });

  it('has no input or result view: the visual under the reply is what the owner sees', () => {
    const input = { kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-02', by: null, compare: null };
    expect(inputViewOf('show_visual', input, TODAY)).toBeNull();
    const content = JSON.stringify({ shown: SHOWN, visual: dailyVisual(req('daily', 'guests', '2026-10-01', '2026-10-01'), [day('2026-10-01', 40)], [], null) });
    expect(resultViewOf('show_visual', { type: 'tool_result', tool_use_id: 't1', content })).toBeNull();
  });
});

describe('suggest_next', () => {
  const THREE = ['How did Monday go?', 'Any events next week?', 'Show last month'];

  it('suggest_next takes exactly three prompts of 2 to 80 characters with no line breaks', () => {
    expect(suggestNextTool.parse({ prompts: ['a?', 'b?'] }, TODAY)).toBeNull();
    expect(suggestNextTool.parse({ prompts: ['How did Monday go?', 'Any events next week?', 'Show last month'] }, TODAY)).not.toBeNull();
    for (const prompts of [
      [...THREE, 'One more?'], ['a', 'b?', 'c?'], ['   a   ', 'b?', 'c?'], ['x'.repeat(81), 'b?', 'c?'], ['Line one\nline two', 'b?', 'c?'],
      ['Line one\rline two', 'b?', 'c?'], [1, 'b?', 'c?'], 'a?, b?, c?',
    ]) expect(suggestNextTool.parse({ prompts }, TODAY)).toBeNull();
    expect(suggestNextTool.parse({}, TODAY)).toBeNull();
    // Trimmed, then counted; 80 characters is fine.
    expect(suggestNextTool.parse({ prompts: ['  How did Monday go?  ', 'x'.repeat(80), 'ok'] }, TODAY))
      .toEqual({ prompts: ['How did Monday go?', 'x'.repeat(80), 'ok'] });
  });

  it('nextOf reads the prompts from a stored input, or null', () => {
    expect(nextOf({ prompts: THREE })).toEqual(THREE);
    expect(nextOf({ prompts: [' a? ', 'b?', 'c?'] })).toEqual(['a?', 'b?', 'c?']);
    expect(nextOf({ prompts: ['a?'] })).toBeNull();
    expect(nextOf(null)).toBeNull();
  });

  it('answers that the prompts were shown, with the prompts for the stream, and has no views', async () => {
    const input = suggestNextTool.parse({ prompts: THREE }, TODAY);
    if (input === null) throw new Error('invalid input');
    expect(await suggestNextTool.run({} as unknown as ToolContext, input)).toEqual({ content: 'Shown to the owner as three buttons.', prompts: THREE });
    expect(inputViewOf('suggest_next', { prompts: THREE }, TODAY)).toBeNull();
    expect(resultViewOf('suggest_next', { type: 'tool_result', tool_use_id: 't1', content: 'Shown to the owner as three buttons.' })).toBeNull();
  });
});

describe('a stored reply with visuals and next questions', () => {
  const at = new Date('2026-11-05T12:00:00.000Z');
  const stored = (params: BetaMessageParam[]) => nodesOf(params.map((param) => ({ at, param: JSON.stringify(param) })));
  const result = (id: string, content: string, isError = false) => ({ type: 'tool_result' as const, tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });
  const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use' as const, id, name, input });
  const THREE = ['How did Monday go?', 'Any events next week?', 'Show last month'];
  const visual = daysTableVisual(req('days_table', null, '2026-10-01', '2026-10-01'), [day('2026-10-01', 40, 1000)]);
  const daysInput = { kind: 'days_table', metric: null, from: '2026-10-01', to: '2026-10-01', by: null, compare: null };

  it('replays a visual as a part in order, the last valid suggest_next as next, and neither on the person’s message', () => {
    const views = chatMessageViews(stored([
      { role: 'user', content: 'Show me Oct 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'Here it is.' }, use('v1', 'show_visual', daysInput)] },
      { role: 'user', content: [result('v1', JSON.stringify({ shown: SHOWN, visual }))] },
      { role: 'assistant', content: [{ type: 'text', text: 'A quiet day.' }, use('n0', 'suggest_next', { prompts: ['a?', 'b?', 'c?'] }), use('n1', 'suggest_next', { prompts: THREE })] },
      { role: 'user', content: [result('n0', 'Shown to the owner as three buttons.'), result('n1', 'Shown to the owner as three buttons.')] },
    ]), TODAY);
    expect(views.map((v) => v.next)).toEqual([null, THREE]);
    expect(views[1]?.parts).toEqual([
      { type: 'text', text: 'Here it is.' }, { type: 'visual', id: 'v1', visual }, { type: 'text', text: 'A quiet day.' },
    ]);
    expect(views[1]?.text).toBe('Here it is.\n\nA quiet day.');
  });

  it('a visual that showed nothing is a tool part with no views; an invalid suggest_next is an error part and gives no next', () => {
    const [, reply] = chatMessageViews(stored([
      { role: 'user', content: 'Show me Oct 1' },
      { role: 'assistant', content: [use('v1', 'show_visual', daysInput), use('n1', 'suggest_next', { prompts: ['a?'] })] },
      { role: 'user', content: [result('v1', JSON.stringify(NO_SALES)), result('n1', 'Invalid input', true)] },
    ]), TODAY);
    expect(reply?.parts).toEqual([
      { type: 'tool', id: 'v1', name: 'show_visual', state: 'done', input: null, result: null },
      { type: 'tool', id: 'n1', name: 'suggest_next', state: 'error', input: null, result: null },
    ]);
    expect(reply?.next).toBeNull();
  });
});
