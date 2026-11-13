// show_visual (docs/portal/tuning-chat.md section 4): the model names what to draw, never a figure; Townwise computes
// every figure from the location's stored days (and, for daily guests, its published forecast through
// ctx.ports.forecasts), returns them to the model as the result and streams the same visual to the owner, who sees it
// under the reply. Four kinds: a daily line, a weekday or month breakdown, a short table of days and a few totals.
// Visuals hold figures, so the tool's card has no views and nothing of a visual is ever logged.
import { z } from 'zod';

import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { eachDay } from '../../forecasts/file.ts';
import { MAX_FORECAST_RANGE_DAYS, type ForecastDayView, type ForecastWindowRun } from '../../forecasts/reader.ts';
import type { SalesDay } from '../../stores/sales-days.ts';
import type { ChatTool, ToolContext } from './registry.ts';
import { DATE } from './shared.ts';

export type Metric = 'guests' | 'netSales';

export type Visual =
  | {
    kind: 'daily'; metric: Metric; from: string; to: string;
    days: { date: string; value: number | null; low: number | null; high: number | null }[];
    forecast: { model: string; madeAt: string } | null;
  }
  | {
    kind: 'breakdown'; metric: Metric; from: string; to: string; by: 'weekday' | 'month';
    /** `key`: '0' to '6' (Sunday 0), Monday first, or 'YYYY-MM'. */
    bars: { key: string; value: number | null; days: number }[];
  }
  | { kind: 'days_table'; from: string; to: string; rows: { date: string; guests: number | null; netSales: number | null }[] }
  | {
    kind: 'metrics'; metric: Metric; from: string; to: string; total: number | null; dailyAverage: number | null; dayCount: number;
    compare: { basis: 'last_year' | 'previous_period'; from: string; to: string; total: number | null; dayCount: number } | null;
  };

export interface VisualRequest {
  kind: Visual['kind'];
  metric: Metric | null;
  from: string;
  to: string;
  by: 'weekday' | 'month' | null;
  compare: 'last_year' | 'previous_period' | null;
}

/** What the model reads with the figures. */
export const VISUAL_RESULT = 'Shown to the owner under your reply. Describe it in a sentence or two; don’t repeat every figure.';
export const NO_SALES_REASON = 'No sales in this range, so nothing was shown.';

/** last_year: the same dates this many days earlier, so weekdays line up (Analytics' YEAR_DAYS). */
const YEAR_DAYS = 364;
/** Analytics' weekly shape runs Monday first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Each kind's longest range, both ends included, and how many days after today its `to` may be. */
const LIMITS: Readonly<Record<Visual['kind'], { maxDays: number; daysAhead: number }>> = {
  daily: { maxDays: 92, daysAhead: 31 },
  breakdown: { maxDays: 731, daysAhead: 0 },
  days_table: { maxDays: 31, daysAhead: 0 },
  metrics: { maxDays: 366, daysAhead: 0 },
};

const METRIC_OF_INPUT = { guests: 'guests', net_sales: 'netSales' } as const;

const visualInput = z.object({
  kind: z.enum(['daily', 'breakdown', 'days_table', 'metrics']),
  metric: z.enum(['guests', 'net_sales']).nullable(),
  from: isoDate,
  to: isoDate,
  by: z.enum(['weekday', 'month']).nullable(),
  compare: z.enum(['last_year', 'previous_period']).nullable(),
});

const metric = z.enum(['guests', 'netSales']);
const value = z.number().nullable();

export const visualSchema: z.ZodType<Visual> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daily'), metric, from: isoDate, to: isoDate,
    days: z.array(z.object({ date: isoDate, value, low: value, high: value })),
    forecast: z.object({ model: z.string(), madeAt: z.string() }).nullable(),
  }),
  z.object({
    kind: z.literal('breakdown'), metric, from: isoDate, to: isoDate, by: z.enum(['weekday', 'month']),
    bars: z.array(z.object({ key: z.string(), value, days: z.number() })),
  }),
  z.object({
    kind: z.literal('days_table'), from: isoDate, to: isoDate,
    rows: z.array(z.object({ date: isoDate, guests: value, netSales: value })),
  }),
  z.object({
    kind: z.literal('metrics'), metric, from: isoDate, to: isoDate, total: value, dailyAverage: value, dayCount: z.number(),
    compare: z.object({
      basis: z.enum(['last_year', 'previous_period']), from: isoDate, to: isoDate, total: value, dayCount: z.number(),
    }).nullable(),
  }),
]);

const visualResult = z.object({ visual: visualSchema });

/** The visual in a stored show_visual result; null for a result that showed nothing or does not parse. */
export function visualOf(content: string): Visual | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = visualResult.safeParse(raw);
  return parsed.success ? parsed.data.visual : null;
}

function shift(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

/** A field the input rules require for this kind; parse never lets one through as null. */
function required<T>(field: T | null, name: string): T {
  if (field === null) throw new Error(`show_visual: ${name} is required for this kind`);
  return field;
}

/** A day's value in whole units: guests, or net sales in cents. */
function unitsOf(day: SalesDay, of: Metric): number | null {
  return of === 'guests' ? day.guests : day.netSalesCents;
}

/** Whole units as shown: guests as they are, cents as dollars. */
function shown(units: number | null, of: Metric): number | null {
  if (units === null) return null;
  return of === 'guests' ? units : units / 100;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** The average of whole units, rounded to a whole guest or cent; null with no values. */
function average(values: readonly number[], of: Metric): number | null {
  return values.length === 0 ? null : shown(Math.round(sum(values) / values.length), of);
}

function valuesOf(days: readonly SalesDay[], of: Metric): number[] {
  return days.flatMap((day) => {
    const units = unitsOf(day, of);
    return units === null ? [] : [units];
  });
}

/**
 * One row per day of the range; the 80% band (low down, high up, as get_forecast rounds) only for guests. The band is
 * the model's own range (spec 14.5), never one an owner's note moved, so it stays the 80% range it is drawn as.
 */
export function dailyVisual(
  req: VisualRequest, days: readonly SalesDay[], forecast: readonly ForecastDayView[], run: { model: string; madeAt: string } | null,
): Visual {
  const of = required(req.metric, 'metric');
  const rows = new Map(days.map((day) => [day.date, day]));
  const band = new Map(of === 'guests' ? forecast.map((day) => [day.date, day]) : []);
  const out = eachDay(req.from, req.to).map((date) => {
    const row = rows.get(date);
    const low = band.get(date)?.model.low ?? null;
    const high = band.get(date)?.model.high ?? null;
    const banded = low !== null && high !== null;
    return {
      date, value: row === undefined ? null : shown(unitsOf(row, of), of),
      low: banded ? Math.floor(low) : null, high: banded ? Math.ceil(high) : null,
    };
  });
  const hasBand = out.some((day) => day.low !== null);
  return {
    kind: 'daily', metric: of, from: req.from, to: req.to, days: out,
    forecast: hasBand && run !== null ? { model: run.model, madeAt: run.madeAt } : null,
  };
}

function monthsOf(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = shift(`${month}-28`, 7).slice(0, 7)) months.push(month);
  return months;
}

/** The average per day with a value, by weekday (Monday first, Sunday 0) or by month, with each one's day count. */
export function breakdownVisual(req: VisualRequest, days: readonly SalesDay[]): Visual {
  const of = required(req.metric, 'metric');
  const by = required(req.by, 'by');
  const keys = by === 'weekday' ? WEEK_ORDER.map(String) : monthsOf(req.from, req.to);
  const keyOf = (date: string): string => (by === 'weekday' ? String(new Date(`${date}T00:00:00.000Z`).getUTCDay()) : date.slice(0, 7));
  const groups = new Map(keys.map((key): [string, number[]] => [key, []]));
  for (const day of days) {
    const units = unitsOf(day, of);
    if (units !== null) groups.get(keyOf(day.date))?.push(units);
  }
  return {
    kind: 'breakdown', metric: of, from: req.from, to: req.to, by,
    bars: keys.map((key) => {
      const values = groups.get(key) ?? [];
      return { key, value: average(values, of), days: values.length };
    }),
  };
}

/** One row per day of the range: guests and net sales in dollars. */
export function daysTableVisual(req: VisualRequest, days: readonly SalesDay[]): Visual {
  const rows = new Map(days.map((day) => [day.date, day]));
  return {
    kind: 'days_table', from: req.from, to: req.to,
    rows: eachDay(req.from, req.to).map((date) => {
      const row = rows.get(date);
      return { date, guests: row?.guests ?? null, netSales: shown(row?.netSalesCents ?? null, 'netSales') };
    }),
  };
}

/** The range a metrics visual compares with: the same dates 364 days earlier, or the same number of days just before. */
export function compareRangeOf(req: VisualRequest): { from: string; to: string } | null {
  if (req.compare === null) return null;
  if (req.compare === 'last_year') return { from: shift(req.from, -YEAR_DAYS), to: shift(req.to, -YEAR_DAYS) };
  const length = daysBetween(req.from, req.to) + 1;
  return { from: shift(req.from, -length), to: shift(req.from, -1) };
}

/** The total, average per day with a value and day count over the range, and the comparison range's total and count. */
export function metricsVisual(req: VisualRequest, days: readonly SalesDay[], compareDays: readonly SalesDay[] | null): Visual {
  const of = required(req.metric, 'metric');
  const values = valuesOf(days, of);
  const range = compareRangeOf(req);
  const before = valuesOf(compareDays ?? [], of);
  return {
    kind: 'metrics', metric: of, from: req.from, to: req.to,
    total: values.length === 0 ? null : shown(sum(values), of), dailyAverage: average(values, of), dayCount: values.length,
    compare: range === null || req.compare === null ? null : {
      basis: req.compare, ...range, total: before.length === 0 ? null : shown(sum(before), of), dayCount: before.length,
    },
  };
}

/** True when a day of the range has the value the visual draws (either value, for a days table). */
function hasValue(req: VisualRequest, days: readonly SalesDay[]): boolean {
  const { metric: of } = req;
  if (of === null) return days.some((day) => day.guests !== null || day.netSalesCents !== null);
  return days.some((day) => unitsOf(day, of) !== null);
}

/** The published forecast over the range, read in windows of at most 31 days, and the newest run that supplied a day. */
async function publishedForecast(tc: ToolContext, from: string, to: string): Promise<{ days: ForecastDayView[]; run: { model: string; madeAt: string } | null }> {
  const ranges: { from: string; to: string }[] = [];
  for (let start = from; start <= to; start = shift(start, MAX_FORECAST_RANGE_DAYS)) {
    const end = shift(start, MAX_FORECAST_RANGE_DAYS - 1);
    ranges.push({ from: start, to: end < to ? end : to });
  }
  const windows = await Promise.all(ranges.map((range) => tc.ctx.ports.forecasts.window(tc.scope, tc.location, range, tc.today)));
  let newest: ForecastWindowRun | null = null;
  for (const run of windows.flatMap((window) => window.runs)) if (newest === null || run.dataThrough > newest.dataThrough) newest = run;
  return {
    days: windows.flatMap((window) => window.days),
    run: newest === null ? null : { model: newest.model.label, madeAt: newest.madeAt },
  };
}

async function visualFor(tc: ToolContext, req: VisualRequest, days: readonly SalesDay[]): Promise<Visual> {
  switch (req.kind) {
    case 'daily': {
      if (req.metric !== 'guests') return dailyVisual(req, days, [], null);
      const forecast = await publishedForecast(tc, req.from, req.to);
      return dailyVisual(req, days, forecast.days, forecast.run);
    }
    case 'breakdown': return breakdownVisual(req, days);
    case 'days_table': return daysTableVisual(req, days);
    case 'metrics': {
      const range = compareRangeOf(req);
      const before = range === null ? null : await tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, range);
      return metricsVisual(req, days, before);
    }
  }
}

export const showVisualTool: ChatTool<VisualRequest> = {
  definition: {
    name: 'show_visual',
    description: 'Draws a chart, a short table of days or a few totals under your reply from Townwise\'s own data, and returns the figures it drew. Name what to draw, never figures. Every key is required; use null where it does not apply. kind daily: one metric per day for at most 92 days, to at most 31 days after today; for guests it shades Townwise\'s published forecast range (80%) where one exists. kind breakdown: the average per day with a value, by weekday or by month (by is required), for at most 731 days. kind days_table: guests and net sales per day for at most 31 days (metric is null). kind metrics: the total, average per day and number of days with a value for at most 366 days, compared with the same dates 364 days earlier (last_year, so weekdays line up), the same number of days just before (previous_period), or nothing (null). breakdown, days_table and metrics end today or earlier. Net sales are in US dollars. With no sales in the range it shows nothing and says so.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['daily', 'breakdown', 'days_table', 'metrics'] },
        metric: { type: ['string', 'null'], enum: ['guests', 'net_sales', null] },
        from: DATE,
        to: DATE,
        by: { type: ['string', 'null'], enum: ['weekday', 'month', null] },
        compare: { type: ['string', 'null'], enum: ['last_year', 'previous_period', null] },
      },
      required: ['kind', 'metric', 'from', 'to', 'by', 'compare'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: kind is daily, breakdown, days_table or metrics; from and to are YYYY-MM-DD dates, from on or before to. daily needs a metric, at most 92 days, to at most 31 days after today; breakdown needs a metric and by, at most 731 days; days_table at most 31 days; metrics needs a metric, at most 366 days. breakdown, days_table and metrics end today or earlier.',
  parse(raw, today) {
    const input = visualInput.safeParse(raw);
    if (!input.success) return null;
    const { kind, from, to, by, compare } = input.data;
    const of = input.data.metric === null ? null : METRIC_OF_INPUT[input.data.metric];
    const { maxDays, daysAhead } = LIMITS[kind];
    if (from < EARLIEST_DATE || from > to || daysBetween(from, to) >= maxDays || to > shift(today, daysAhead)) return null;
    if (kind !== 'days_table' && of === null) return null;
    if (kind === 'breakdown' && by === null) return null;
    // by and compare count only for the kinds that use them, and a days table has no metric.
    return {
      kind, metric: kind === 'days_table' ? null : of, from, to, by: kind === 'breakdown' ? by : null, compare: kind === 'metrics' ? compare : null,
    };
  },
  inputView: () => null,
  resultView: () => null,
  async run(tc, req) {
    const days = await tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, { from: req.from, to: req.to });
    if (!hasValue(req, days)) return { content: JSON.stringify({ available: false, reason: NO_SALES_REASON }) };
    const visual = await visualFor(tc, req, days);
    return { content: JSON.stringify({ shown: VISUAL_RESULT, visual }), visual };
  },
};
