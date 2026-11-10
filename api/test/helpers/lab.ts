// The forecast lab in integration tests: a fake runner that records each job (its calibration id and token) instead of
// starting one, the job's two callback calls, a synthetic sales history, and a valid LabResult built from the input the
// API served, as the lab would answer it. Every number is synthetic.
import { Types } from 'mongoose';

import { daysBetween } from '../../src/dates.ts';
import { eachDay } from '../../src/forecasts/file.ts';
import { RESULT_TOKEN_HEADER } from '../../src/lab/callback.ts';
import type { LabInput } from '../../src/lab/input.ts';
import type { LabResult, LabSuccess } from '../../src/lab/result.ts';
import type { LabJob, LabRunner, LabStart } from '../../src/lab/runner.ts';
import type { Scorecard } from '../../src/lab/scorecard.ts';
import { comparisonWith, scorecardWith } from './lab-scorecard.ts';
import type { TownwiseTestServer } from './server.ts';

export const IMAGE_DIGEST = `sha256:${'5e'.repeat(32)}`;
export const CODE_VERSION = 'c0de'.repeat(10);

export interface FakeLabRunner extends LabRunner {
  /** Every job started, oldest first. */
  readonly jobs: LabJob[];
  /** The next start throws `err` instead. */
  failNext(err: Error): void;
  /** Runs inside every start, before it answers (to look at the database while the job "starts"). */
  onStart: ((job: LabJob) => Promise<void>) | null;
}

export function fakeLabRunner(): FakeLabRunner {
  const jobs: LabJob[] = [];
  let failure: Error | null = null;
  const runner: FakeLabRunner = {
    jobs,
    onStart: null,
    failNext(err) { failure = err; },
    async start(job): Promise<LabStart> {
      await runner.onStart?.(job);
      if (failure !== null) {
        const err = failure;
        failure = null;
        throw err;
      }
      jobs.push(job);
      return { imageDigest: IMAGE_DIGEST, codeVersion: null };
    },
  };
  return runner;
}

/** The result token each calibration's input answer named, by calibration id: what the job posts its result with. */
const resultTokens = new Map<string, string>();

/** The result token the input answer for `calibrationId` named, if its input was fetched. */
export function resultTokenOf(calibrationId: string): string | undefined {
  return resultTokens.get(calibrationId);
}

/**
 * The job's own calls: GET .../input with the token it was started with, or POST .../result with `body`. Like the job, a
 * result goes with the result token its input answer named (X-Townwise-Result-Token), or the start token when no
 * input was fetched. `authorization` replaces the header (null leaves it out).
 */
export async function jobCall(
  server: Pick<TownwiseTestServer, 'url'>, job: Pick<LabJob, 'calibrationId' | 'token'>, verb: 'input' | 'result', body?: unknown,
  opts?: { authorization?: string | null },
): Promise<Response> {
  const headers = new Headers();
  const token = verb === 'result' ? resultTokens.get(job.calibrationId) ?? job.token : job.token;
  const authorization = opts?.authorization === undefined ? `Bearer ${token}` : opts.authorization;
  if (authorization !== null) headers.set('authorization', authorization);
  if (verb === 'result') headers.set('content-type', 'application/json');
  const res = await fetch(new URL(`/lab/calibrations/${job.calibrationId}/${verb}`, server.url), {
    method: verb === 'input' ? 'GET' : 'POST',
    headers,
    ...(verb === 'result' ? { body: JSON.stringify(body) } : {}),
  });
  const resultToken = verb === 'input' && res.status === 200 ? res.headers.get(RESULT_TOKEN_HEADER) : null;
  if (resultToken !== null) resultTokens.set(job.calibrationId, resultToken);
  return res;
}

/** One synthetic day of guests on every date from `from` to `to`, written straight to tw_sales_days. */
export async function seedHistory(
  server: Pick<TownwiseTestServer, 'connection' | 'clock'>,
  opts: { orgId: string; locationId: string; from: string; to: string; guests?: (date: string, index: number) => number },
): Promise<void> {
  const guests = opts.guests ?? ((_date: string, index: number) => 40 + (index % 7) * 5);
  await server.connection.collection('tw_sales_days').insertMany(eachDay(opts.from, opts.to).map((date, index) => ({
    orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), date, guests: guests(date, index),
    netSalesCents: null, uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
  })));
}

function plusDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function mondayOf(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  return plusDays(day, -((at.getUTCDay() + 6) % 7));
}

/** A run file's days and weeks from `dataThrough` + 1 for `days` days, every day open; weeks are each Monday's days. */
export function runDays(dataThrough: string, days: number): Pick<LabSuccess['run'], 'days' | 'weeks'> {
  const dates = eachDay(plusDays(dataThrough, 1), plusDays(dataThrough, days));
  const runDaysOut = dates.map((date) => ({
    date, status: 'open' as const, low: 40, mid: 50, high: 62, baseline: 50, reasons: [{ kind: 'weekday' as const, ref: null, effectPct: null }],
  }));
  const weeks = new Map<string, string[]>();
  for (const date of dates) weeks.set(mondayOf(date), [...(weeks.get(mondayOf(date)) ?? []), date]);
  return {
    days: runDaysOut,
    weeks: [...weeks.values()].map((week) => ({
      from: week[0] ?? '', to: week.at(-1) ?? '', openDays: week.length, low: 40 * week.length, mid: 50 * week.length, high: 62 * week.length,
    })),
  };
}

/** The lab's answer to `input`: a draft run for the 14 days after its last day, compared with its champion if it has one. */
export function labResultFor(input: LabInput, overrides?: { scorecard?: Scorecard; run?: Partial<LabSuccess['run']> }): LabSuccess {
  const firstDate = input.days[0]?.date ?? '';
  const scorecard = overrides?.scorecard ?? scorecardWith({
    history: { firstDate, lastDate: input.dataThrough, spanDays: daysBetween(firstDate, input.dataThrough) },
    comparison: input.champion === null ? null : {
      ...comparisonWith({ weeklyWape: 0.2 }, { weeklyWape: 0.15 }), championRunId: input.champion.runId,
      championDataThrough: input.champion.dataThrough,
    },
  });
  return {
    schema: 'townwise.lab-result/1',
    calibrationId: input.calibrationId,
    ok: true,
    codeVersion: CODE_VERSION,
    params: {
      target: 'guests', baseCols: ['weekday', 'recent_level', 'term'], eventCols: ['private_event', 'week_of_term', 'weekday'],
      regimeStart: input.regimeStart,
      xgb: {
        objective: 'reg:absoluteerror', n_estimators: 400, learning_rate: 0.03, max_depth: 3, min_child_weight: 5, subsample: 0.8,
        colsample_bytree: 0.8, reg_lambda: 5, random_state: 0, n_jobs: 1,
      },
      holidayLambdas: { hol_big_night: 3, hol_halloween: 3 }, holidayEffects: { hol_big_night: 0.3, hol_halloween: 0.1 },
      widenK: 1.2, weeklyLogRange: { lo: -0.1, hi: 0.2 }, refitEveryMonths: 3, horizonDays: 28, minPastWeeks: 8, floor: 1,
    },
    scorecard,
    run: {
      schema: 'townwise.forecast-run/1', metric: 'guests',
      model: { family: 'hybrid_linear_xgboost', version: 'v6', notebookCommit: CODE_VERSION },
      trainingSource: 'townwise_lab', trainedFrom: input.days[0]?.date ?? '', dataThrough: input.dataThrough, madeAt: input.today,
      frozen: null, interval: { level: 0.8, widened: true },
      backtest: { from: scorecard.backtest.from, to: scorecard.backtest.to, weeks: 12, weeklyTypicalErrorPct: 9.5, weeksOver20Pct: 1, weeklyRangePct: { below: 10, above: 20 } },
      ...runDays(input.dataThrough, 14),
      ...overrides?.run,
    },
  };
}

/** A failure the job reports. */
export function labFailure(input: Pick<LabInput, 'calibrationId'>, code: 'not_enough_history' | 'invalid_input' | 'internal'): LabResult {
  return { schema: 'townwise.lab-result/1', calibrationId: input.calibrationId, ok: false, code };
}
