import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { formatDate, plural } from '../format';

// Forecast runs in the staff console (spec 10.13, 14.4, 16.4 P21 Forecasts): the calls, their shapes, and the
// browser's read of a run file before it is sent. The read mirrors the server's schema shape (strict objects, the
// same enums and limits) so staff see what's wrong at once and a summary before importing; the server checks the
// rules across fields again and its issues read through the same words. An issue is a path and a code, never a value.

function id(value: string): string {
  return encodeURIComponent(value);
}

export const RUN_STATUSES = ['importing', 'draft', 'published', 'withdrawn'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const staffRunSchema = z.object({
  id: z.string(),
  metric: z.literal('guests'),
  model: z.object({ family: z.string(), version: z.string(), label: z.string() }),
  // Any string, like the model card’s: only 'townwise_lab' reads as a calibration.
  trainingSource: z.string(),
  trainedFrom: z.string(),
  dataThrough: z.string(),
  madeAt: z.string(),
  locationId: z.string(),
  status: z.enum(RUN_STATUSES),
  range: z.object({ from: z.string(), to: z.string() }),
  dayCount: z.number(),
  weekCount: z.number(),
  importedAt: z.string(),
  publishedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  importedByEmail: z.string().nullable(),
});
export type StaffRun = z.infer<typeof staffRunSchema>;

const runListSchema = z.object({ runs: z.array(staffRunSchema) });
const runAnswerSchema = z.object({ run: staffRunSchema });

export async function fetchForecastRuns(api: ApiClient, orgId: string): Promise<StaffRun[]> {
  return (await api.json(`/api/admin/orgs/${id(orgId)}/forecast-runs`, runListSchema)).runs;
}

/** 201 a new draft, 200 the same file's run in its current status; 400 invalid_forecast_file carries `issues`. */
export async function importForecastRun(api: ApiClient, orgId: string, locationId: string, file: unknown): Promise<StaffRun> {
  const path = `/api/admin/orgs/${id(orgId)}/locations/${id(locationId)}/forecast-runs` as const;
  return (await api.json(path, runAnswerSchema, { method: 'POST', body: file })).run;
}

export async function changeForecastRun(api: ApiClient, orgId: string, runId: string, verb: 'publish' | 'withdraw'): Promise<StaffRun> {
  const path = `/api/admin/orgs/${id(orgId)}/forecast-runs/${id(runId)}/${verb}` as const;
  return (await api.json(path, runAnswerSchema, { method: 'POST', body: {} })).run;
}

/** 204: the run's rows, then the run. */
export async function deleteForecastRun(api: ApiClient, orgId: string, runId: string): Promise<void> {
  await api.request(`/api/admin/orgs/${id(orgId)}/forecast-runs/${id(runId)}`, { method: 'DELETE' });
}

// How one run was trained (spec D50): percentages, counts, dates, settings and loss ratios, never a guest figure.

const learningSchema = z.object({
  trainThrough: z.string(),
  from: z.string(),
  to: z.string(),
  trainDays: z.number(),
  validDays: z.number(),
  train: z.array(z.number()).min(1),
  valid: z.array(z.number()).min(1),
});
export type Learning = z.infer<typeof learningSchema>;

const methodSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    baseInputs: z.array(z.string()),
    eventInputs: z.array(z.string()),
    trees: z.object({
      objective: z.string(), rounds: z.number(), learningRate: z.number(), maxDepth: z.number(), minChildWeight: z.number(),
      subsample: z.number(), columnSample: z.number(), l2: z.number(),
    }),
    refitEveryMonths: z.number(),
    regimeStart: z.string().nullable(),
  }),
  z.object({ kind: z.literal('baseline'), levelDays: z.number(), levelMinDays: z.number(), regimeStart: z.string().nullable() }),
]);

export const runTrainingSchema = z.object({
  code: z.object({ commit: z.string(), imageDigest: z.string().nullable() }),
  history: z.object({ from: z.string(), to: z.string(), days: z.number().nullable() }),
  // A method this client doesn't know yet reads as none, never as a failed page.
  method: methodSchema.nullable().catch(null),
  backtest: z.object({
    from: z.string(), to: z.string(), weeks: z.number(), weeklyTypicalErrorPct: z.number(), weeksOver20Pct: z.number(),
    weeklyRangePct: z.object({ below: z.number(), above: z.number() }).nullable(),
  }).nullable(),
  validation: z.object({
    from: z.string(), to: z.string(), weeks: z.number(), weeklyWapePct: z.number(), dailyWapePct: z.number(), worstWeekPct: z.number(),
    weeksOver20: z.number(), coverage: z.object({ inside: z.number(), weeks: z.number() }), weekdayMedianWeeklyWapePct: z.number(),
    engines: z.object({ modelWeeklyWapePct: z.number().nullable(), baselineWeeklyWapePct: z.number() }).nullable(),
    folds: z.array(z.object({
      trainThrough: z.string(), from: z.string(), to: z.string(), weeks: z.number(), weeklyWapePct: z.number(), weeksOver20: z.number(),
    })),
  }).nullable(),
  learning: learningSchema.nullable(),
});
export type RunTraining = z.infer<typeof runTrainingSchema>;

const runTrainingAnswerSchema = z.object({ training: runTrainingSchema });

export async function fetchRunTraining(api: ApiClient, orgId: string, runId: string): Promise<RunTraining> {
  return (await api.json(`/api/admin/orgs/${id(orgId)}/forecast-runs/${id(runId)}`, runTrainingAnswerSchema)).training;
}

/** A loss to three places ("0.124"): the mean absolute log error, so 0.10 is about 10% off. */
export function formatLoss(value: number): string {
  return value.toFixed(3);
}

export interface LearningSummary {
  rounds: number;
  trainEnd: number;
  validEnd: number;
  /** The round (from 1) where the validation loss was lowest, and that loss. */
  bestRound: number;
  bestValid: number;
  /** The validation loss ended more than 2% above its lowest: the later rounds fitted the training days only. */
  roseAfterBest: boolean;
}

export function learningSummary(learning: Learning): LearningSummary {
  const rounds = Math.min(learning.train.length, learning.valid.length);
  const valid = learning.valid.slice(0, rounds);
  const bestValid = Math.min(...valid);
  const validEnd = valid[rounds - 1] ?? bestValid;
  return {
    rounds,
    trainEnd: learning.train[rounds - 1] ?? 0,
    validEnd,
    bestRound: valid.indexOf(bestValid) + 1,
    bestValid,
    roseAfterBest: validEnd > bestValid * 1.02,
  };
}

/** The curve in words, so the chart is never the only place its numbers are. */
export function learningWords(learning: Learning): string[] {
  const s = learningSummary(learning);
  return [
    `Trained on ${plural(learning.trainDays, 'day', 'days')} through ${formatDate(learning.trainThrough)}, then checked on the ${plural(learning.validDays, 'day', 'days')} from ${formatDate(learning.from)} to ${formatDate(learning.to)}, which the trees never saw.`,
    `After ${plural(s.rounds, 'round', 'rounds')} the loss was ${formatLoss(s.trainEnd)} on the training days and ${formatLoss(s.validEnd)} on the validation days.`,
    s.roseAfterBest
      ? `Validation loss was lowest at round ${String(s.bestRound)} (${formatLoss(s.bestValid)}) and rose after it: the later rounds fitted the training days only.`
      : `Validation loss was lowest at round ${String(s.bestRound)} (${formatLoss(s.bestValid)}) and ended within 2% of it.`,
  ];
}

// The run file, read in the browser.

/** The import route's body limit, on what is sent: the parsed file as compact JSON. */
export const MAX_FILE_BYTES = 256 * 1024;
/** A file larger than this on disk isn't read at all (the exporter's indented JSON is a few times its compact size). */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const guests = (max: number) => z.number().min(0).max(max);

const runFileSchema = z.strictObject({
  schema: z.literal('townwise.forecast-run/1'),
  metric: z.literal('guests'),
  model: z.strictObject({
    family: z.enum(['hybrid_linear_xgboost', 'linear_median', 'weekday_median', 'seasonal_baseline']),
    version: z.string().regex(/^v[0-9]{1,3}$/),
    notebookCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  }),
  trainingSource: z.literal('files_from_owner'),
  trainedFrom: date,
  dataThrough: date,
  madeAt: date,
  frozen: z.strictObject({
    files: z.array(z.strictObject({ name: z.string().regex(/^frozen_forecast_[a-z0-9_.-]{1,80}\.csv$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(10),
  }).nullable(),
  interval: z.strictObject({ level: z.literal(0.8), widened: z.boolean() }),
  backtest: z.strictObject({
    from: date, to: date, weeks: z.number().int().min(1).max(520), weeklyTypicalErrorPct: z.number().min(0).max(100),
    weeksOver20Pct: z.number().int().min(0).max(520),
    weeklyRangePct: z.strictObject({ below: z.number().min(0).max(100), above: z.number().min(0).max(1000) }).nullable(),
  }).nullable(),
  days: z.array(z.strictObject({
    date,
    status: z.enum(['open', 'closed', 'booked']),
    low: guests(20_000).nullable(),
    mid: guests(20_000).nullable(),
    high: guests(20_000).nullable(),
    baseline: guests(20_000).nullable(),
    reasons: z.array(z.strictObject({
      kind: z.enum(['weekday', 'term', 'event', 'holiday', 'level', 'closure', 'booking']),
      ref: z.string().regex(/^[a-z0-9][a-z0-9:-]{0,119}$/).nullable(),
      effectPct: z.number().min(-100).max(1000).nullable(),
    })).max(6),
  })).min(1).max(400),
  weeks: z.array(z.strictObject({
    from: date, to: date, openDays: z.number().int().min(0).max(7), low: guests(140_000), mid: guests(140_000), high: guests(140_000),
  })).max(60),
});

export interface FileIssue { path: string; code: string }

export interface RunSummary {
  version: string;
  dayCount: number;
  openDays: number;
  from: string;
  to: string;
  dataThrough: string;
  madeAt: string;
}

export type FileRead = { ok: true; file: unknown; summary: RunSummary } | { ok: false; issues: FileIssue[] };

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${String(part)}]`;
    return text === '' ? String(part) : `${text}.${String(part)}`;
  }, '');
}

/** Reads a chosen file: refused unread over 2 MB on disk, else its text through readRunFile. */
export async function readChosenFile(file: Blob): Promise<FileRead> {
  if (file.size > MAX_READ_BYTES) return { ok: false, issues: [{ path: '', code: 'too_large_to_read' }] };
  return readRunFile(await file.text());
}

/**
 * Reads a run file's text: JSON, its size as it will be sent (compact, so the exporter's indenting doesn't count),
 * then the shape. The summary is what staff confirm before importing.
 */
export function readRunFile(text: string): FileRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: '', code: 'not_json' }] };
  }
  if (new Blob([JSON.stringify(raw)]).size > MAX_FILE_BYTES) return { ok: false, issues: [{ path: '', code: 'too_large' }] };
  const parsed = runFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 50).map((issue) => ({ path: pathText(issue.path), code: issue.code })) };
  const dates = parsed.data.days.map((day) => day.date).sort();
  return {
    ok: true,
    file: raw,
    summary: {
      version: parsed.data.model.version,
      dayCount: parsed.data.days.length,
      openDays: parsed.data.days.filter((day) => day.status === 'open').length,
      from: dates[0] ?? '',
      to: dates.at(-1) ?? '',
      dataThrough: parsed.data.dataThrough,
      madeAt: parsed.data.madeAt,
    },
  };
}

/** "Model v3, guests, 71 days (49 open) from Oct 22, 2026 to Dec 31, 2026, trained to Oct 21, 2026, made Nov 1, 2026." */
export function summaryText(summary: RunSummary): string {
  return `Model ${summary.version}, guests, ${plural(summary.dayCount, 'day', 'days')} (${String(summary.openDays)} open) from ${formatDate(summary.from)} to ${formatDate(summary.to)}, trained to ${formatDate(summary.dataThrough)}, made ${formatDate(summary.madeAt)}.`;
}

export const DRAFT_NOTE = 'Saved as a draft; owners and TownwiseAI see it only after you publish it.';

/** The words for each issue code, the server's and the browser's. */
export const ISSUE_WORDS: Readonly<Record<string, string>> = {
  not_json: 'isn’t a JSON file',
  too_large: 'is larger than 256 KB',
  too_large_to_read: 'is larger than 2 MB',
  unrecognized_keys: 'has a field Townwise doesn’t accept',
  invalid_type: 'is the wrong type, or missing',
  invalid_value: 'isn’t one of the accepted values',
  invalid_format: 'isn’t in the expected format',
  too_big: 'is too large or too long',
  too_small: 'is too small or too short',
  not_a_date: 'isn’t a real date (YYYY-MM-DD)',
  dates_out_of_order: 'is out of order with the other dates',
  made_in_future: 'is after today',
  duplicate_date: 'is a date listed twice',
  not_after_data: 'is on or before the last day the model saw',
  too_far_ahead: 'is more than 400 days after the last day the model saw',
  numbers_required: 'is an open day without low, mid and high',
  numbers_not_allowed: 'is a closed or booked day with numbers',
  below_low: 'is lower than low',
  below_mid: 'is lower than mid',
  ref_not_allowed: 'can’t name a calendar entry for this kind of reason',
  week_span: 'isn’t inside one Monday-to-Sunday week',
  week_overlap: 'overlaps another week',
  week_day_missing: 'covers a day the file has no row for',
  open_days_mismatch: 'doesn’t match the open days in the file',
  over_count: 'is more than the number of weeks',
};

/** "days[3].high: is lower than mid"; the file itself when the path is empty. */
export function issueText(issue: FileIssue): string {
  const words = ISSUE_WORDS[issue.code] ?? 'isn’t valid';
  return issue.path === '' ? `The file ${words}.` : `${issue.path} ${words}.`;
}

/** The issues of a 400 invalid_forecast_file, from the error's detail. */
export function issuesOf(detail: Readonly<Record<string, unknown>> | null): FileIssue[] {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string(), code: z.string() })) }).safeParse(detail);
  return parsed.success ? parsed.data.issues : [];
}

export const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  importing: 'Import unfinished',
  draft: 'Draft',
  published: 'Published',
  withdrawn: 'Withdrawn',
};
