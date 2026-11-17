// The lab result as the callback receives it (D42, lab-input/2): its scorecard names the engine, both engines' figures,
// its weekly bias and the longer-horizon reports, which the gate reads, so a result without them is refused while a
// stored scorecard from before still parses (lab-scorecard.test.ts). checkLabResult also holds the engine the scorecard
// names to its run's model family and its params. The golden result is the lab's own (modeling/lab/tests/golden).
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { labInputSchema } from '../src/lab/input.ts';
import { checkLabResult, labResultSchema, type LabSuccess } from '../src/lab/result.ts';
import { labScorecardSchema, scorecardSchema } from '../src/lab/scorecard.ts';
import { storedScorecard } from './helpers/lab-scorecard.ts';

function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../modeling/lab/tests/golden/${name}`, import.meta.url), 'utf8'));
}

const input = labInputSchema.parse(golden('input.json'));
const calibration = { id: input.calibrationId, dataThrough: input.dataThrough, championRunId: input.champion?.runId ?? null };

function goldenResult(): LabSuccess {
  const result = labResultSchema.parse(golden('result.json'));
  if (!result.ok) throw new Error('the golden result is a success');
  return result;
}

function issuesOf(raw: unknown): { path: string; code: string }[] {
  const check = checkLabResult(raw, calibration, input.today);
  return check.ok ? [] : check.issues;
}

describe('labResultSchema (D42)', () => {
  it('parses the golden result with its engine, both engines, its weekly bias and the horizon reports', () => {
    const { scorecard } = goldenResult();
    expect(scorecard.engine).toBe('baseline');
    expect(scorecard.engines.baseline.coverage80).toEqual(scorecard.backtest.metrics.coverage80);
    expect(scorecard.engines.model?.weeks).toBe(scorecard.backtest.weeks);
    expect(typeof scorecard.backtest.weeklyBias).toBe('number');
    expect(scorecard.horizon91?.weeks).toBeGreaterThanOrEqual(8);
    expect(scorecard.horizonReach).not.toBeUndefined();
    expect(issuesOf(golden('result.json'))).toEqual([]);
  });

  it('refuses a result without any of the engine fields, which a stored scorecard may lack', () => {
    const result = goldenResult();
    const old = storedScorecard(result.scorecard);
    const { backtest } = old;
    expect(scorecardSchema.safeParse(old).success).toBe(true);
    expect(labScorecardSchema.safeParse(old).success).toBe(false);
    for (const without of [
      { ...result.scorecard, engine: undefined },
      { ...result.scorecard, engines: undefined },
      { ...result.scorecard, horizon91: undefined },
      { ...result.scorecard, horizonReach: undefined },
      { ...result.scorecard, backtest },
    ]) {
      expect(labResultSchema.safeParse({ ...result, scorecard: without }).success).toBe(false);
    }
    // Still strict: an unknown key is refused.
    expect(labScorecardSchema.safeParse({ ...result.scorecard, extra: 1 }).success).toBe(false);
  });

  it('holds the engine the scorecard names to the run’s model family, the params and its own figures', () => {
    const result = goldenResult();
    expect(result.run.model.family).toBe('seasonal_baseline');
    const mismatch = [{ path: 'scorecard.engine', code: 'engine_mismatch' }];
    const asModel = { ...result.scorecard, engine: 'model' as const };
    const modelRun = { ...result.run, model: { ...result.run.model, family: 'hybrid_linear_xgboost' } };
    expect(issuesOf({ ...result, scorecard: asModel })).toEqual(mismatch);
    expect(issuesOf({ ...result, run: modelRun })).toEqual(mismatch);
    // The scorecard and the run agree on the model, but the params are the baseline's
    expect(issuesOf({ ...result, scorecard: asModel, run: modelRun })).toEqual(mismatch);
    // The engine returned always ran, so its own figures are there; the model's may be null on a baseline result
    const noBaseline = { ...result.scorecard, engines: { model: result.scorecard.engines.model, baseline: null } };
    expect(labResultSchema.safeParse({ ...result, scorecard: noBaseline }).success).toBe(false);
    const modelNotRun = { ...result.scorecard, engines: { model: null, baseline: result.scorecard.engines.baseline } };
    expect(issuesOf({ ...result, scorecard: modelNotRun })).toEqual([]);
  });
});
