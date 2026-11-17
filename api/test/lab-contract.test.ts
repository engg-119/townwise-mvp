// The contract between the API and the lab (plan, Contracts): the lab's own golden input and result, made from its
// synthetic fixture (modeling/lab/tests/make_golden.py), parse with the API's schemas and checks. A change on either side
// that breaks the other fails here.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { checkLabRunFile } from '../src/forecasts/file.ts';
import { LAB_MODEL_VERSION, labInputSchema } from '../src/lab/input.ts';
import { checkLabResult, labResultSchema } from '../src/lab/result.ts';
import { scorecardSchema } from '../src/lab/scorecard.ts';
import type { CalibrationRecord } from '../src/stores/calibrations.ts';

function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../modeling/lab/tests/golden/${name}`, import.meta.url), 'utf8'));
}

describe('lab contract', () => {
  it('LAB_MODEL_VERSION is the lab’s MODEL_VERSION (version.py), so the fingerprint moves with the lab’s model', () => {
    const source = readFileSync(new URL('../../modeling/lab/townwise_lab/version.py', import.meta.url), 'utf8');
    const versions = [...source.matchAll(/^MODEL_VERSION = "([^"]+)"$/gm)].map((match) => match[1]);
    expect(versions).toEqual([LAB_MODEL_VERSION]);
    expect(LAB_MODEL_VERSION).toBe('v7');
  });

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

  it('the golden result names its engine (D42): the baseline, more than 0.5 points better than the model on the same weeks', () => {
    const input = labInputSchema.parse(golden('input.json'));
    const result = labResultSchema.parse(golden('result.json'));
    if (!result.ok) return expect.unreachable('the golden result is a success');
    const { engine, engines, horizon91, horizonReach } = result.scorecard;
    expect(input.champion?.engine).toBe('model');
    expect(engine).toBe('baseline');
    expect(result.run.model.family).toBe('seasonal_baseline');
    expect(result.params).toMatchObject({ engine: 'baseline' });
    if (engines === undefined || engines.model === null) return expect.unreachable('both engines ran');
    expect(engines.baseline.weeklyWape).toBeLessThanOrEqual(engines.model.weeklyWape - 0.005);
    expect(engines.baseline.weeks).toBe(engines.model.weeks);
    expect(horizon91?.weeks).toBeGreaterThanOrEqual(8);
    // Its today is two days after its last day of sales, so the run reaches 93 days: past 91, with the reach reported.
    expect(horizonReach?.weeks).toBeGreaterThanOrEqual(8);
    expect(result.run.days.at(-1)?.date).toBe(new Date(Date.parse(`${input.today}T00:00:00Z`) + 91 * 86_400_000).toISOString().slice(0, 10));
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

  it('checkLabResult refuses a scorecard week after the calibration’s last day of data', () => {
    const input = labInputSchema.parse(golden('input.json'));
    const calibration = { id: input.calibrationId, dataThrough: input.dataThrough, championRunId: input.champion?.runId ?? null };
    const result = labResultSchema.parse(golden('result.json'));
    if (!result.ok || result.scorecard.comparison === null) return expect.unreachable('the golden result compares with a champion');
    const { backtest, comparison } = result.scorecard;
    // Every golden week starts on or before the last day (the last backtest week may be a partial one).
    expect([...backtest.series, ...comparison.series].every((row) => row.week <= input.dataThrough)).toBe(true);
    const last = (rows: readonly unknown[]): number => rows.length - 1;
    /** The golden result with its last backtest and comparison weeks starting on `week`. */
    const lastWeeksOn = (week: string): unknown => ({
      ...result,
      scorecard: {
        ...result.scorecard,
        backtest: { ...backtest, series: backtest.series.map((row, i) => (i === last(backtest.series) ? { ...row, week } : row)) },
        comparison: { ...comparison, series: comparison.series.map((row, i) => (i === last(comparison.series) ? { ...row, week } : row)) },
      },
    });
    const next = new Date(Date.parse(`${input.dataThrough}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const check = checkLabResult(lastWeeksOn(next), calibration, input.today);
    expect(check.ok ? [] : check.issues).toEqual([
      { path: `scorecard.backtest.series[${String(last(backtest.series))}].week`, code: 'after_data_through' },
      { path: `scorecard.comparison.series[${String(last(comparison.series))}].week`, code: 'after_data_through' },
    ]);
    expect(checkLabResult(lastWeeksOn(input.dataThrough), calibration, input.today)).toMatchObject({ ok: true });
  });

  it('a failure result parses with its code and refuses an unknown one', () => {
    const failed = { schema: 'townwise.lab-result/1', calibrationId: null, ok: false, code: 'invalid_input' };
    expect(labResultSchema.safeParse(failed).success).toBe(true);
    expect(labResultSchema.safeParse({ ...failed, code: 'out_of_memory' }).success).toBe(false);
    expect(labResultSchema.safeParse({ ...failed, extra: 1 }).success).toBe(false);
  });
});
