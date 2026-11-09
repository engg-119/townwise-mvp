// The contract between the API and the lab (plan, Contracts): the lab's own golden input and result, made from its
// synthetic fixture (modeling/lab/tests/make_golden.py), parse with the API's schemas and checks. A change on either side
// that breaks the other fails here.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { checkLabRunFile } from '../src/forecasts/file.ts';
import { labInputSchema } from '../src/lab/input.ts';
import { checkLabResult, labResultSchema } from '../src/lab/result.ts';
import { scorecardSchema } from '../src/lab/scorecard.ts';
import type { CalibrationRecord } from '../src/stores/calibrations.ts';

function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../modeling/lab/tests/golden/${name}`, import.meta.url), 'utf8'));
}

describe('lab contract', () => {
  it('golden input and result parse with labInputSchema, labResultSchema, scorecardSchema and checkLabRunFile', () => {
    const input = labInputSchema.parse(golden('input.json'));
    const result = labResultSchema.parse(golden('result.json'));
    if (!result.ok) return expect.unreachable('the golden result is a success');
    expect(scorecardSchema.safeParse(result.scorecard).success).toBe(true);
    expect(checkLabRunFile(result.run, input.today)).toMatchObject({ ok: true });
    expect(result.calibrationId).toBe(input.calibrationId);
    expect(result.run.dataThrough).toBe(input.dataThrough);
    expect(result.scorecard.comparison?.championRunId).toBe(input.champion?.runId);
    // As the callback checks it, for the calibration the input was built for.
    const calibration = { id: input.calibrationId, dataThrough: input.dataThrough, championRunId: input.champion?.runId ?? null };
    expect(checkLabResult(golden('result.json'), calibration, input.today)).toMatchObject({ ok: true });
    // Small enough for the callback's body limit with room to spare.
    expect(JSON.stringify(result).length).toBeLessThan(128 * 1024);
  });

  it('checkLabResult holds a result to its calibration: its id, its input’s last day and its current forecast', () => {
    const input = labInputSchema.parse(golden('input.json'));
    const calibration: Pick<CalibrationRecord, 'id' | 'dataThrough' | 'championRunId'> = {
      id: input.calibrationId, dataThrough: input.dataThrough, championRunId: input.champion?.runId ?? null,
    };
    const issuesOf = (changes: Partial<typeof calibration>) => {
      const check = checkLabResult(golden('result.json'), { ...calibration, ...changes }, input.today);
      return check.ok ? [] : check.issues;
    };
    expect(issuesOf({ id: 'e'.repeat(24) })).toEqual([{ path: 'calibrationId', code: 'calibration_mismatch' }]);
    // A calibration whose job never fetched its input has no last day to match.
    expect(issuesOf({ dataThrough: null })).toEqual([{ path: 'run.dataThrough', code: 'data_through_mismatch' }]);
    expect(issuesOf({ championRunId: null })).toEqual([{ path: 'scorecard.comparison.championRunId', code: 'champion_mismatch' }]);
    // The run's own rules, against today: made after today is refused.
    const early = checkLabResult(golden('result.json'), calibration, '2025-10-21');
    expect(early.ok ? [] : early.issues).toEqual([{ path: 'run.madeAt', code: 'made_in_future' }]);
  });

  it('a failure result parses with its code and refuses an unknown one', () => {
    const failed = { schema: 'townwise.lab-result/1', calibrationId: null, ok: false, code: 'invalid_input' };
    expect(labResultSchema.safeParse(failed).success).toBe(true);
    expect(labResultSchema.safeParse({ ...failed, code: 'out_of_memory' }).success).toBe(false);
    expect(labResultSchema.safeParse({ ...failed, extra: 1 }).success).toBe(false);
  });
});
