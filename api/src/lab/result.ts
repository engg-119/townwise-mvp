// The forecast lab's result (schema townwise.lab-result/1), as the job posts it to the callback: the draft run file,
// its scorecard and the parameters that reproduce it, or a failure code. checkLabResult also holds it to the
// calibration it answers (the same id, the same last day of data, the same current forecast compared). Issues carry a
// path and a code only, never a value. Pure.
import { z } from 'zod';

import { isoDate } from '../dates.ts';
import { checkLabRunFile, issueOf, labRunFileSchema, MAX_ISSUES, type FileIssue } from '../forecasts/file.ts';
import type { CalibrationRecord } from '../stores/calibrations.ts';
import { scorecardSchema } from './scorecard.ts';

export const LAB_RESULT_SCHEMA = 'townwise.lab-result/1';
/** The codes a failed result carries. */
export const LAB_FAILURE_CODES = ['not_enough_history', 'invalid_input', 'internal'] as const;

const calibrationId = z.string().regex(/^[0-9a-f]{24}$/);
const num = z.number();
const int = z.number().int();
const columns = z.array(z.string().min(1).max(130)).max(200);

/** The Contracts' LabParams: stored as JSON on the run's lab block, with the code version and the input's hash (G3). */
export const labParamsSchema = z.strictObject({
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
  refitEveryMonths: int,
  horizonDays: int,
  minPastWeeks: int,
  floor: num,
});

export const labResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schema: z.literal(LAB_RESULT_SCHEMA),
    calibrationId,
    ok: z.literal(true),
    codeVersion: z.string().regex(/^[0-9a-f]{40}$/),
    params: labParamsSchema,
    scorecard: scorecardSchema,
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
 * the calibration's id, the last day of the input it was given, and the current forecast it was compared with.
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
    const compared = result.scorecard.comparison;
    if (compared !== null && compared.championRunId !== calibration.championRunId) {
      issues.push({ path: 'scorecard.comparison.championRunId', code: 'champion_mismatch' });
    }
  }
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, MAX_ISSUES) } : { ok: true, result };
}
