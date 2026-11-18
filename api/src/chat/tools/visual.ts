// show_visual (docs/portal/tuning-chat.md section 4): the model names what to draw, never a figure; Townwise computes
// every figure from the location's stored days (and, for daily guests, its published forecast through
// ctx.ports.forecasts), returns them to the model as the result and streams the same visual to the owner, who sees it
// under the reply. Four kinds: a daily line, a weekday or month breakdown, a short table of days and a few totals.
// Daily guests read the forecast before deciding whether there is anything to show, since a day from today on has a
// forecast and no sales yet: such a range is shown when a day has a value or a day from today on has a band, a closed
// or a booked status. Net sales have no forecast, so an all-future net sales range says Townwise forecasts guests only.
// Closed and likely-closed days (spec D32, closed-days.ts, from the location's notes, rule schedules and the 8 weeks
// before each range) are closures, not slow days: breakdown and metrics average open days only, as Analytics does, and
// a days table marks a likely-closed row. Visuals hold figures, so the tool's card has no views and nothing of a visual
// is ever logged.
import { z } from 'zod';

import { noteCovers } from '../../agent/questions.ts';
import { closureOf, TYPICAL_LOOKBACK_DAYS, typicalByDate, type Closure } from '../../closed-days.ts';
import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { scheduledRules } from '../../forecasts/adjust.ts';
import { eachDay } from '../../forecasts/file.ts';
import { MAX_FORECAST_RANGE_DAYS, type ForecastDayView, type ForecastWindowRun } from '../../forecasts/reader.ts';
import type { SalesDay } from '../../stores/sales-days.ts';
import type { ChatTool, ToolContext, ToolRun } from './registry.ts';
import { DATE } from './shared.ts';

export type Metric = 'guests' | 'netSales';
/** A day the published forecast closed or booked (a private buyout); an open day has none. */
export type ForecastStatus = 'closed' | 'booked';

export type Visual =
  | {
    kind: 'daily'; metric: Metric; from: string; to: string;
    /**
     * `low`, `mid` and `high` are the forecast's, rounded as get_forecast rounds them; `status` is set only on a closed or
     * booked day, and `outlook` (true) only on a day after its run's forecast tier (D52).
     */
    days: {
      date: string; value: number | null; low: number | null; mid: number | null; high: number | null; status?: ForecastStatus | undefined;
      outlook?: boolean | undefined;
    }[];
    forecast: { model: string; madeAt: string } | null;
  }
  | {
    kind: 'breakdown'; metric: Metric; from: string; to: string; by: 'weekday' | 'month';
    /** `key`: '0' to '6' (Sunday 0), Monday first, or 'YYYY-MM'. */
    bars: { key: string; value: number | null; days: number }[];
  }
  | {
    kind: 'days_table'; from: string; to: string;
    /** `likelyClosed` is set, true, only on a likely-closed day (spec D32). */
    rows: { date: string; guests: number | null; netSales: number | null; likelyClosed?: true | undefined }[];
  }
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
/** With a band on a day from today on: the prompt's rule that a forecast is given as its range, said where it applies. */
export const FORECAST_VISUAL_RESULT = `${VISUAL_RESULT} Give the forecast as its range.`;
export const NO_SALES_REASON = 'No sales in this range, so nothing was shown.';
/** Daily guests over a range reaching today with no value and no forecast on a day from today on. */
export const NO_SALES_OR_FORECAST_REASON = 'No sales or published forecast in this range, so nothing was shown.';
/** Daily net sales over a range wholly after today: no sales yet, and the forecast is of guests only. */
export const GUESTS_ONLY_REASON = 'Townwise forecasts guests only, so there are no net sales to show for future days.';

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
    // A visual stored before `mid`, `status` and `outlook` existed still parses and replays: mid as null, no status, no outlook.
    days: z.array(z.object({
      date: isoDate, value, low: value, mid: value.default(null), high: value, status: z.enum(['closed', 'booked']).optional(),
      outlook: z.boolean().optional(),
    })),
    forecast: z.object({ model: z.string(), madeAt: z.string() }).nullable(),
  }),
  z.object({
    kind: z.literal('breakdown'), metric, from: isoDate, to: isoDate, by: z.enum(['weekday', 'month']),
    bars: z.array(z.object({ key: z.string(), value, days: z.number() })),
  }),
  z.object({
    kind: z.literal('days_table'), from: isoDate, to: isoDate,
    rows: z.array(z.object({ date: isoDate, guests: value, netSales: value, likelyClosed: z.literal(true).optional() })),
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

/** Whether a stored day was closed or likely closed (spec D32); none by default. */
export type ClosureOn = (day: SalesDay) => Closure | null;
const NO_CLOSURES: ClosureOn = () => null;

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
 * One row per day of the range; the forecast band (low down, mid to the nearest guest, high up, as get_forecast rounds)
 * only for guests. The band is the day's range as the owner's notes leave it from the town's today on (spec 14.5), the
 * same low, mid and high get_forecast and the Calendar give, so a closed or booked day has none and says which it is in
 * `status`; it is the model's 80% range only on a day no note changed (get_forecast's modelRange is the model's own on
 * the others). A day in its run's outlook (D52) says so in `outlook`.
 */
export function dailyVisual(
  req: VisualRequest, days: readonly SalesDay[], forecast: readonly ForecastDayView[], run: { model: string; madeAt: string } | null,
): Visual {
  const of = required(req.metric, 'metric');
  const rows = new Map(days.map((day) => [day.date, day]));
  const band = new Map(of === 'guests' ? forecast.map((day) => [day.date, day]) : []);
  const out = eachDay(req.from, req.to).map((date) => {
    const row = rows.get(date);
    const forecastDay = band.get(date);
    const low = forecastDay?.low ?? null;
    const mid = forecastDay?.mid ?? null;
    const high = forecastDay?.high ?? null;
    const banded = low !== null && high !== null;
    const status = forecastDay === undefined || forecastDay.status === 'open' ? null : forecastDay.status;
    return {
      date, value: row === undefined ? null : shown(unitsOf(row, of), of),
      low: banded ? Math.floor(low) : null, mid: banded && mid !== null ? Math.round(mid) : null, high: banded ? Math.ceil(high) : null,
      ...(status === null ? {} : { status }),
      ...(forecastDay?.outlook === true ? { outlook: true } : {}),
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

/**
 * The average per open day with a value, by weekday (Monday first, Sunday 0) or by month, with each one's day count:
 * closed and likely-closed days are left out, as Analytics leaves them out.
 */
export function breakdownVisual(req: VisualRequest, days: readonly SalesDay[], closureOn: ClosureOn = NO_CLOSURES): Visual {
  const of = required(req.metric, 'metric');
  const by = required(req.by, 'by');
  const keys = by === 'weekday' ? WEEK_ORDER.map(String) : monthsOf(req.from, req.to);
  const keyOf = (date: string): string => (by === 'weekday' ? String(new Date(`${date}T00:00:00.000Z`).getUTCDay()) : date.slice(0, 7));
  const groups = new Map(keys.map((key): [string, number[]] => [key, []]));
  for (const day of days) {
    const units = unitsOf(day, of);
    if (units !== null && closureOn(day) === null) groups.get(keyOf(day.date))?.push(units);
  }
  return {
    kind: 'breakdown', metric: of, from: req.from, to: req.to, by,
    bars: keys.map((key) => {
      const values = groups.get(key) ?? [];
      return { key, value: average(values, of), days: values.length };
    }),
  };
}

/** One row per day of the range: guests and net sales in dollars, and likelyClosed on a likely-closed day. */
export function daysTableVisual(req: VisualRequest, days: readonly SalesDay[], closureOn: ClosureOn = NO_CLOSURES): Visual {
  const rows = new Map(days.map((day) => [day.date, day]));
  return {
    kind: 'days_table', from: req.from, to: req.to,
    rows: eachDay(req.from, req.to).map((date) => {
      const row = rows.get(date);
      const likely = row !== undefined && closureOn(row) === 'likely_closed';
      return { date, guests: row?.guests ?? null, netSales: shown(row?.netSalesCents ?? null, 'netSales'), ...(likely ? { likelyClosed: true as const } : {}) };
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

/**
 * The total over every day with a value, and the average per day and day count over the open ones (closed and
 * likely-closed days left out, as Analytics leaves them out), over the range; the comparison range's total and count.
 */
export function metricsVisual(
  req: VisualRequest, days: readonly SalesDay[], compareDays: readonly SalesDay[] | null, closureOn: ClosureOn = NO_CLOSURES,
): Visual {
  const of = required(req.metric, 'metric');
  const values = valuesOf(days, of);
  const open = valuesOf(days.filter((day) => closureOn(day) === null), of);
  const range = compareRangeOf(req);
  const before = valuesOf(compareDays ?? [], of);
  const openBefore = valuesOf((compareDays ?? []).filter((day) => closureOn(day) === null), of);
  return {
    kind: 'metrics', metric: of, from: req.from, to: req.to,
    total: values.length === 0 ? null : shown(sum(values), of), dailyAverage: average(open, of), dayCount: open.length,
    compare: range === null || req.compare === null ? null : {
      basis: req.compare, ...range, total: before.length === 0 ? null : shown(sum(before), of), dayCount: openBefore.length,
    },
  };
}

/** True when a day of the range has the value the visual draws (either value, for a days table). */
function hasValue(req: VisualRequest, days: readonly SalesDay[]): boolean {
  const { metric: of } = req;
  if (of === null) return days.some((day) => day.guests !== null || day.netSalesCents !== null);
  return days.some((day) => unitsOf(day, of) !== null);
}

/** The published forecast over the range, read in windows of at most MAX_FORECAST_RANGE_DAYS, and the newest run that supplied a day. */
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

/** A range's stored days, from the 8 weeks before it too: their same weekdays give each day its typical guests (D32). */
function readWithLookback(tc: ToolContext, range: { from: string; to: string }): Promise<SalesDay[]> {
  return tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, { from: shift(range.from, -TYPICAL_LOOKBACK_DAYS), to: range.to });
}

/**
 * Which of the stored days `read` were closed or likely closed, from the location's notes and rule schedules (read
 * once) and the town's today: a function of the read, so the comparison range gets its own typical guests.
 */
async function closuresOf(tc: ToolContext): Promise<(read: readonly SalesDay[]) => ClosureOn> {
  const [notes, scheduled] = await Promise.all([
    tc.ctx.stores.notes.list(tc.scope, tc.location.id), tc.ctx.stores.businessRules.scheduled(tc.scope, tc.location.id),
  ]);
  const schedules = scheduledRules(scheduled).map((rule) => rule.schedule);
  return (read) => {
    const typical = typicalByDate(read);
    return (day) => closureOf(day, typical.get(day.date) ?? null, notes.filter((note) => noteCovers(note, day.date)), {
      rules: schedules.filter((schedule) => noteCovers(schedule, day.date)), past: day.date < tc.today,
    });
  };
}

function unavailable(reason: string): ToolRun {
  return { content: JSON.stringify({ available: false, reason }) };
}

/** A daily visual's days from today on, the ones a forecast is for; none for another kind. */
function daysAhead(visual: Visual, today: string): Extract<Visual, { kind: 'daily' }>['days'] {
  return visual.kind === 'daily' ? visual.days.filter((day) => day.date >= today) : [];
}

/** `days` is the range's stored days; `read` the same with the 8 weeks before (every kind but daily). */
async function visualFor(tc: ToolContext, req: VisualRequest, days: readonly SalesDay[], read: readonly SalesDay[]): Promise<Visual> {
  if (req.kind === 'daily') {
    if (req.metric !== 'guests') return dailyVisual(req, days, [], null);
    const forecast = await publishedForecast(tc, req.from, req.to);
    return dailyVisual(req, days, forecast.days, forecast.run);
  }
  const closures = await closuresOf(tc);
  switch (req.kind) {
    case 'breakdown': return breakdownVisual(req, days, closures(read));
    case 'days_table': return daysTableVisual(req, days, closures(read));
    case 'metrics': {
      const range = compareRangeOf(req);
      if (range === null) return metricsVisual(req, days, null, closures(read));
      const before = await readWithLookback(tc, range);
      const closureOn = closures([...before, ...read]);
      return metricsVisual(req, days, before.filter((day) => day.date >= range.from), closureOn);
    }
  }
}

export const showVisualTool: ChatTool<VisualRequest> = {
  definition: {
    name: 'show_visual',
    description: 'Draws a chart, a short table of days or a few totals under your reply from Townwise\'s own data, and returns the figures it drew. Name what to draw, never figures. Every key is required; use null where it does not apply. kind daily: one metric per day for at most 92 days, to at most 31 days after today; for guests it shades Townwise\'s published forecast range where one exists, from today on including the owner\'s saved notes, as get_forecast\'s low and high do (the 80% range is the model\'s own: modelRange on a day a note changed). kind breakdown: the average per open day with a value, by weekday or by month (by is required), for at most 731 days. kind days_table: guests and net sales per day for at most 31 days (metric is null); a row with likelyClosed true was likely closed (before today, guests under a tenth of the typical guests of the same weekday over the 8 weeks before, and no note or business rule schedule says more or fewer guests), so treat it as closed, never as a slow day. kind metrics: the total over every day with a value, and the average per day and number of days over the open days with a value, for at most 366 days, compared with the same dates 364 days earlier (last_year, so weekdays line up), the same number of days just before (previous_period), or nothing (null). Open days leave out closed and likely-closed days, as Analytics does. breakdown, days_table and metrics end today or earlier. Net sales are in US dollars. With no sales in the range it shows nothing and says so.',
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
    const read = req.kind === 'daily'
      ? await tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, { from: req.from, to: req.to })
      : await readWithLookback(tc, req);
    const days = read.filter((day) => day.date >= req.from);
    const sales = hasValue(req, days);
    // Daily guests reaching today read the published forecast before deciding: a day from today on has no sales yet. A
    // range that ends before today can show only sales, as before forecasts reached this tool.
    const forecastable = req.kind === 'daily' && req.metric === 'guests' && req.to >= tc.today;
    if (!sales && !forecastable) {
      const futureNetSales = req.kind === 'daily' && req.metric === 'netSales' && req.from > tc.today;
      return unavailable(futureNetSales ? GUESTS_ONLY_REASON : NO_SALES_REASON);
    }
    const visual = await visualFor(tc, req, days, read);
    const ahead = daysAhead(visual, tc.today);
    if (!sales && !ahead.some((day) => day.low !== null || day.status !== undefined)) return unavailable(NO_SALES_OR_FORECAST_REASON);
    return { content: JSON.stringify({ shown: ahead.some((day) => day.low !== null) ? FORECAST_VISUAL_RESULT : VISUAL_RESULT, visual }), visual };
  },
};
