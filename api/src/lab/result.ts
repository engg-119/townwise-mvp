// The forecast lab's result (schema townwise.lab-result/1), as the job posts it to the callback: the draft run file,
// its scorecard and the parameters that reproduce it, or a failure code. checkLabResult also holds it to the
// calibration it answers (the same id, the same last day of data, the same current forecast compared, no scorecard week
// after that last day), and the engine its scorecard names to its run and its params (D42). Issues carry a path and a code only, never a value. Pure.
import { z } from 'zod';

import { isoDate } from '../dates.ts';
import { checkLabRunFile, issueOf, labRunFileSchema, MAX_ISSUES, type FileIssue } from '../forecasts/file.ts';
import type { CalibrationRecord } from '../stores/calibrations.ts';
import { engineOf } from '../forecasts/reader.ts';
import { labScorecardSchema } from './scorecard.ts';

export const LAB_RESULT_SCHEMA = 'townwise.lab-result/1';
/** The codes a failed result carries. */
export const LAB_FAILURE_CODES = ['not_enough_history', 'invalid_input', 'internal'] as const;

const calibrationId = z.string().regex(/^[0-9a-f]{24}$/);
const num = z.number();
const int = z.number().int();
const columns = z.array(z.string().min(1).max(130)).max(200);

/** How much a run's ranges widen from a lead on (D42: past 28 days, by the longer horizons' backtest bands). */
const wideningSchema = z.array(z.strictObject({ fromLead: int, ratio: num })).max(4);

/** The model's LabParams. */
const modelParamsSchema = z.strictObject({
  target: z.literal('guests'),
  baseCols: columns,
  eventCols: columns,
  regimeStart: isoDate.nullable(),
  xgb: z.strictObject({
    objective: z.string().max(40), n_estimators: int, learning_rate: num, max_depth: int, min_child_weight: num,
    subsample: num, colsample_bytree: num, reg_lambda: num, random_state: int, n_jobs: int,
  }),
  holidayLambdas: z.strictObject({ hol_big_night: num, hol_halloween: num }),
  holidayEffects: z.strictObject({ hol_big_night: num, hol_halloween: num }),
  widenK: num,
  weeklyLogRange: z.strictObject({ lo: num, hi: num }),
  widening: wideningSchema.optional(),
  refitEveryMonths: int,
  horizonDays: int,
  minPastWeeks: int,
  floor: num,
});

/** The baseline engine's LabParams (D42): its rule's constants, the calendar effects it found, its ranges. */
const baselineParamsSchema = z.strictObject({
  target: z.literal('guests'),
  engine: z.literal('baseline'),
  regimeStart: isoDate.nullable(),
  levelDays: int,
  levelMinDays: int,
  shapeClamp: z.strictObject({ min: num, max: num }),
  calendarEffects: z.record(z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,119}$/), num),
  dailyLogRange: z.strictObject({ lo: num, hi: num }),
  widenK: num,
  weeklyLogRange: z.strictObject({ lo: num, hi: num }),
  widening: wideningSchema,
  horizonDays: int,
  minPastWeeks: int,
  floor: num,
});

/** The Contracts' LabParams: stored as JSON on the run's lab block, with the code version and the input's hash (G3). */
export const labParamsSchema = z.union([modelParamsSchema, baselineParamsSchema]);

export const labResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schema: z.literal(LAB_RESULT_SCHEMA),
    calibrationId,
    ok: z.literal(true),
    codeVersion: z.string().regex(/^[0-9a-f]{40}$/),
    params: labParamsSchema,
    scorecard: labScorecardSchema,
    run: labRunFileSchema,
  }),
  z.strictObject({
    schema: z.literal(LAB_RESULT_SCHEMA),
    // Null when the lab could not read the input's id.
    calibrationId: calibrationId.nullable(),
    ok: z.literal(false),
    code: z.enum(LAB_FAILURE_CODES),
  }),
]);

export type LabResult = z.infer<typeof labResultSchema>;
export type LabSuccess = Extract<LabResult, { ok: true }>;

export type LabResultCheck = { ok: true; result: LabResult } | { ok: false; issues: FileIssue[] };

/**
 * The result for `calibration`, checked against today (UTC): its shape, the run file's own rules (checkLabRunFile),
 * the calibration's id, the last day of the input it was given, the current forecast it was compared with, and that
 * every scorecard week starts on or before that last day: those weeks reach TownwiseAI (lab/components.ts), and a later
 * one would be a forecast week, not the owner's history. The engine the scorecard names (which the gate judges by) is
 * the run's (its model family), the params' (the baseline's carry `engine`), and has its own figures in `engines`.
 */
export function checkLabResult(
  raw: unknown,
  calibration: Pick<CalibrationRecord, 'id' | 'dataThrough' | 'championRunId'>,
  today: string,
): LabResultCheck {
  const parsed = labResultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, MAX_ISSUES).map(issueOf) };
  const result = parsed.data;
  const issues: FileIssue[] = [];
  if (result.calibrationId !== null && result.calibrationId !== calibration.id) issues.push({ path: 'calibrationId', code: 'calibration_mismatch' });
  if (result.ok) {
    const run = checkLabRunFile(result.run, today);
    if (!run.ok) issues.push(...run.issues.map((issue) => ({ path: issue.path === '' ? 'run' : `run.${issue.path}`, code: issue.code })));
    if (result.run.dataThrough !== calibration.dataThrough) issues.push({ path: 'run.dataThrough', code: 'data_through_mismatch' });
    const { engine, engines } = result.scorecard;
    const paramsEngine = 'engine' in result.params ? result.params.engine : 'model';
    if (engineOf(result.run.model.family) !== engine || paramsEngine !== engine || engines[engine] === null) {
      issues.push({ path: 'scorecard.engine', code: 'engine_mismatch' });
    }
    const compared = result.scorecard.comparison;
    if (compared !== null && compared.championRunId !== calibration.championRunId) {
      issues.push({ path: 'scorecard.comparison.championRunId', code: 'champion_mismatch' });
    }
    const through = calibration.dataThrough;
    if (through !== null) {
      const later = (path: string, weeks: readonly { week: string }[]): FileIssue[] => weeks.flatMap((row, i) => (
        row.week > through ? [{ path: `${path}[${String(i)}].week`, code: 'after_data_through' }] : []
      ));
      issues.push(...later('scorecard.backtest.series', result.scorecard.backtest.series));
      if (compared !== null) issues.push(...later('scorecard.comparison.series', compared.series));
      const { learning } = result.scorecard;
      if (learning != null && learning.to > through) issues.push({ path: 'scorecard.learning.to', code: 'after_data_through' });
    }
  }
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, MAX_ISSUES) } : { ok: true, result };
}
