// The forecast run file (spec 14.4, docs/portal/estimates.md section 7): what staff upload to import one model run's
// outputs for one location, schema id townwise.forecast-run/1. Outputs and metadata only: no location id (the route
// path sets it), no name, note, URL or other free text, so nothing a partner's export holds can reach an owner or
// Anthropic through a forecast. Labels for its reasons are made in code (reasons.ts), never read from here. Every
// object is strict, so an unknown key anywhere is an issue. Issues carry a path and a code only, never a value. Pure.
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { daysBetween, isCalendarDate } from '../dates.ts';

export const FORECAST_RUN_SCHEMA = 'townwise.forecast-run/1';

export const MODEL_FAMILIES = ['hybrid_linear_xgboost', 'linear_median', 'weekday_median'] as const;
export const DAY_STATUSES = ['open', 'closed', 'booked'] as const;
export const REASON_KINDS = ['weekday', 'term', 'event', 'holiday', 'level', 'closure', 'booking'] as const;
/** Kinds whose reason may name a calendar entry (a TownEvent id, or a calendar group such as 'hanover-nh:home-football'). */
export const REF_KINDS: readonly ReasonKind[] = ['term', 'event', 'holiday'];

export type DayStatus = (typeof DAY_STATUSES)[number];
export type ReasonKind = (typeof REASON_KINDS)[number];

/** A day's guests at most; a week's at most seven times this. */
export const MAX_DAY_GUESTS = 20_000;
export const MAX_DAYS = 400;
export const MAX_WEEKS = 60;
export const MAX_REASONS = 6;
/** Issues listed in a 400, at most. */
export const MAX_ISSUES = 50;

/** A YYYY-MM-DD calendar date; anything else is the issue code not_a_date. */
const date = z.string().refine(isCalendarDate, { params: { code: 'not_a_date' } });
const guests = (max: number) => z.number().min(0).max(max);
const pct = z.number();

const reasonSchema = z.strictObject({
  kind: z.enum(REASON_KINDS),
  ref: z.string().regex(/^[a-z0-9][a-z0-9:-]{0,119}$/).nullable(),
  effectPct: pct.min(-100).max(1000).nullable(),
});

const daySchema = z.strictObject({
  date,
  status: z.enum(DAY_STATUSES),
  low: guests(MAX_DAY_GUESTS).nullable(),
  mid: guests(MAX_DAY_GUESTS).nullable(),
  high: guests(MAX_DAY_GUESTS).nullable(),
  baseline: guests(MAX_DAY_GUESTS).nullable(),
  reasons: z.array(reasonSchema).max(MAX_REASONS),
});

const weekSchema = z.strictObject({
  from: date,
  to: date,
  openDays: z.number().int().min(0).max(7),
  low: guests(MAX_DAY_GUESTS * 7),
  mid: guests(MAX_DAY_GUESTS * 7),
  high: guests(MAX_DAY_GUESTS * 7),
});

const backtestSchema = z.strictObject({
  from: date,
  to: date,
  weeks: z.number().int().min(1).max(520),
  weeklyTypicalErrorPct: pct.min(0).max(100),
  weeksOver20Pct: z.number().int().min(0).max(520),
  weeklyRangePct: z.strictObject({ below: pct.min(0).max(100), above: pct.min(0).max(1000) }).nullable(),
});

export const forecastRunFileSchema = z.strictObject({
  schema: z.literal(FORECAST_RUN_SCHEMA),
  metric: z.literal('guests'),
  model: z.strictObject({
    family: z.enum(MODEL_FAMILIES),
    version: z.string().regex(/^v[0-9]{1,3}$/),
    notebookCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  }),
  // 'townwise_uploads' (a model trained on days owners uploaded to Townwise) is reserved until the team decides
  // whether staff may copy uploaded days into research (spec 14, DECISION NEEDED); until then only exports an owner
  // sent the team directly are accepted.
  trainingSource: z.literal('files_from_owner'),
  trainedFrom: date,
  dataThrough: date,
  madeAt: date,
  frozen: z.strictObject({
    files: z.array(z.strictObject({
      name: z.string().regex(/^frozen_forecast_[a-z0-9_.-]{1,80}\.csv$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })).min(1).max(10),
  }).nullable(),
  interval: z.strictObject({ level: z.literal(0.8), widened: z.boolean() }),
  backtest: backtestSchema.nullable(),
  days: z.array(daySchema).min(1).max(MAX_DAYS),
  weeks: z.array(weekSchema).max(MAX_WEEKS),
});

/**
 * A run the forecast lab made from the days an owner uploaded to Townwise (forecasts/lab, stores/calibrations.ts). The
 * lab posts it to the API's callback, never staff to the import route, which still refuses this training source.
 * Never frozen: a lab run is scored prospectively like any published run, but no frozen file registered it.
 */
export const labRunFileSchema = forecastRunFileSchema.extend({
  trainingSource: z.literal('townwise_lab'),
  frozen: z.null(),
});

export type ForecastRunFile = z.infer<typeof forecastRunFileSchema>;
export type LabRunFile = z.infer<typeof labRunFileSchema>;
export type ForecastFileDay = ForecastRunFile['days'][number];
export type ForecastFileWeek = ForecastRunFile['weeks'][number];
export type ForecastFileReason = ForecastFileDay['reasons'][number];

/** One problem in a run file: where, as "days[3].high", and a code (the client words it); never the value. */
export interface FileIssue { path: string; code: string }

export type FileCheck<T extends ForecastRunFile | LabRunFile = ForecastRunFile> = { ok: true; file: T } | { ok: false; issues: FileIssue[] };

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${String(part)}]`;
    return text === '' ? String(part) : `${text}.${String(part)}`;
  }, '');
}

function issueOf(issue: z.core.$ZodIssue): FileIssue {
  const params = (issue as { params?: { code?: unknown } }).params;
  const code = issue.code === 'custom' && typeof params?.code === 'string' ? params.code : issue.code;
  return { path: pathText(issue.path), code };
}

const DAY_MS = 86_400_000;

/** The Monday of a date's week (weeks run Monday to Sunday). */
function mondayOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  const back = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - back * DAY_MS).toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00.000Z`); at <= Date.parse(`${to}T00:00:00.000Z`); at += DAY_MS) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

/** The rules across fields (spec 14.4), on a file whose shape already parsed. */
function crossFieldIssues(file: ForecastRunFile | LabRunFile, today: string): FileIssue[] {
  const issues: FileIssue[] = [];
  const add = (path: string, code: string): void => { issues.push({ path, code }); };
  if (file.trainedFrom > file.dataThrough) add('trainedFrom', 'dates_out_of_order');
  if (file.dataThrough > file.madeAt) add('dataThrough', 'dates_out_of_order');
  if (file.madeAt > today) add('madeAt', 'made_in_future');
  if (file.backtest !== null) {
    if (file.backtest.from > file.backtest.to || file.backtest.to > file.madeAt) add('backtest.to', 'dates_out_of_order');
    if (file.backtest.weeksOver20Pct > file.backtest.weeks) add('backtest.weeksOver20Pct', 'over_count');
  }

  const statusOf = new Map<string, DayStatus>();
  file.days.forEach((day, index) => {
    const at = `days[${String(index)}]`;
    if (statusOf.has(day.date)) add(`${at}.date`, 'duplicate_date');
    statusOf.set(day.date, day.status);
    // An in-sample fit is not a forecast: every day comes after the last day the model saw.
    if (day.date <= file.dataThrough) add(`${at}.date`, 'not_after_data');
    else if (daysBetween(file.dataThrough, day.date) > MAX_DAYS) add(`${at}.date`, 'too_far_ahead');
    const numbers = [day.low, day.mid, day.high];
    if (day.status === 'open') {
      if (numbers.some((value) => value === null)) add(at, 'numbers_required');
      else if (day.low !== null && day.mid !== null && day.high !== null) {
        if (day.mid < day.low) add(`${at}.mid`, 'below_low');
        if (day.high < day.mid) add(`${at}.high`, 'below_mid');
      }
    } else if ([...numbers, day.baseline].some((value) => value !== null)) {
      add(at, 'numbers_not_allowed');
    }
    day.reasons.forEach((reason, r) => {
      if (reason.ref !== null && !REF_KINDS.includes(reason.kind)) add(`${at}.reasons[${String(r)}].ref`, 'ref_not_allowed');
    });
  });

  const covered = new Set<string>();
  file.weeks.forEach((week, index) => {
    const at = `weeks[${String(index)}]`;
    if (week.mid < week.low) add(`${at}.mid`, 'below_low');
    if (week.high < week.mid) add(`${at}.high`, 'below_mid');
    if (week.from > week.to || mondayOf(week.from) !== mondayOf(week.to)) {
      add(at, 'week_span');
      return;
    }
    const days = eachDay(week.from, week.to);
    if (days.some((day) => covered.has(day))) add(at, 'week_overlap');
    for (const day of days) covered.add(day);
    if (days.some((day) => !statusOf.has(day))) {
      add(at, 'week_day_missing');
      return;
    }
    // A booked day may count as open in the model's own week (it forecast walk-ins before the booking rule applied).
    const open = days.filter((day) => statusOf.get(day) === 'open').length;
    const booked = days.filter((day) => statusOf.get(day) === 'booked').length;
    if (week.openDays < open || week.openDays > open + booked) add(`${at}.openDays`, 'open_days_mismatch');
  });
  return issues;
}

/** Validates a run file against today (UTC). The issues, at most 50, say where and what, never the value. */
export function checkForecastRunFile(raw: unknown, today: string): FileCheck {
  const parsed = forecastRunFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, MAX_ISSUES).map(issueOf) };
  const issues = crossFieldIssues(parsed.data, today);
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };
  return { ok: true, file: parsed.data };
}

/** Checks a lab run file the same way as an imported one: the same shape, with the lab's training source, and the same rules. */
export function checkLabRunFile(raw: unknown, today: string): FileCheck<LabRunFile> {
  const parsed = labRunFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, MAX_ISSUES).map(issueOf) };
  const issues = crossFieldIssues(parsed.data, today);
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };
  return { ok: true, file: parsed.data };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** SHA-256 over a value's canonical JSON (keys sorted at every level). */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

/** SHA-256 over the file's canonical JSON, so the same run imported again is found. */
export function runFileSha256(file: ForecastRunFile | LabRunFile): string {
  return canonicalSha256(file);
}
