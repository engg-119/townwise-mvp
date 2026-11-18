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

describe('checkLabResult’s outlook sanity checks (D52)', () => {
  const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  /** The golden result with its run's days running through `last` (each a copy of its first day). */
  function reaching(last: string): unknown {
    const result = goldenResult();
    const [first] = result.run.days;
    if (first === undefined) throw new Error('the golden run has days');
    const days = [];
    for (let date = first.date; date <= last; date = plus(date, 1)) days.push({ ...first, date });
    return { ...result, run: { ...result.run, days, weeks: [] } };
  }
  const outlook = (ratios: [number, number]) => [
    { horizon: 182, weeks: 15, weeklyWape: 0.14, coverage80: { inside: 11, weeks: 15 }, ratio: ratios[0], basis: 'growth_or_backtest' },
    { horizon: 365, weeks: 0, weeklyWape: null, coverage80: { inside: 0, weeks: 0 }, ratio: ratios[1], basis: 'growth' },
  ];
  /** The golden result with `widening` in its params and, when given, `horizonOutlook` in its scorecard. */
  function widened(widening: unknown[], horizonOutlook?: unknown[]): unknown {
    const result = goldenResult();
    return {
      ...result, params: { ...result.params, widening },
      scorecard: horizonOutlook === undefined ? result.scorecard : { ...result.scorecard, horizonOutlook },
    };
  }

  it('passes today’s golden result, and a run reaching a year from its made-at date within 400 days of its data', () => {
    const result = goldenResult();
    expect(issuesOf(golden('result.json'))).toEqual([]);
    const year = plus(result.run.madeAt, 365);
    expect(year <= plus(result.run.dataThrough, 400)).toBe(true);
    expect(issuesOf(reaching(year))).toEqual([]);
  });

  it('refuses a run that ends after min(madeAt + 365, dataThrough + 400) with outlook_too_far', () => {
    const result = goldenResult();
    expect(issuesOf(reaching(plus(result.run.madeAt, 366)))).toEqual([{ path: 'run.days', code: 'outlook_too_far' }]);
    // Sales lagging 49 days: the run may reach 400 days after the data (351 after its today), the run file's own limit.
    const madeLate = (lag: number): unknown => {
      const lagging = reaching(plus(result.run.dataThrough, 400)) as LabSuccess;
      return { ...lagging, run: { ...lagging.run, madeAt: plus(result.run.dataThrough, lag) } };
    };
    const asOf = (lag: number) => checkLabResult(madeLate(lag), calibration, plus(result.run.dataThrough, lag));
    expect(asOf(49)).toMatchObject({ ok: true });
    // 30 days behind, the same last day is past its today plus 365.
    expect(asOf(30)).toMatchObject({ ok: false, issues: [{ path: 'run.days', code: 'outlook_too_far' }] });
  });

  it('refuses widening whose leads do not increase, or whose ratios fall under 1 or decrease, with widening_out_of_order', () => {
    const refused = [{ path: 'params.widening', code: 'widening_out_of_order' }];
    const forecastTier = [{ fromLead: 29, ratio: 1 }, { fromLead: 92, ratio: 1.1 }];
    expect(issuesOf(widened(forecastTier))).toEqual([]);
    expect(issuesOf(widened([{ fromLead: 29, ratio: 1 }, { fromLead: 29, ratio: 1.1 }]))).toEqual(refused);
    expect(issuesOf(widened([{ fromLead: 92, ratio: 1.1 }, { fromLead: 29, ratio: 1.2 }]))).toEqual(refused);
    expect(issuesOf(widened([{ fromLead: 29, ratio: 0.9 }]))).toEqual(refused);
    expect(issuesOf(widened([{ fromLead: 29, ratio: 1.2 }, { fromLead: 92, ratio: 1.1 }]))).toEqual(refused);
  });

  it('holds the outlook anchors to horizonOutlook’s ratios when it is reported: a narrowing outlook is refused', () => {
    const refused = [{ path: 'params.widening', code: 'widening_out_of_order' }];
    const tier = [{ fromLead: 29, ratio: 1 }, { fromLead: 92, ratio: 1.1 }];
    const anchors = (r182: number, r365: number) => [...tier, { fromLead: 183, ratio: r182, horizon: 182 }, { fromLead: 366, ratio: r365, horizon: 365 }];
    expect(issuesOf(widened(anchors(1.6, 2.2), outlook([1.6, 2.2])))).toEqual([]);
    // Up to 8 entries; anchors with no report (release A) are held only to their order
    expect(issuesOf(widened(anchors(1.6, 2.2)))).toEqual([]);
    // The 365-day anchor lower than the 182-day one
    expect(issuesOf(widened(anchors(1.6, 1.5), outlook([1.6, 1.5])))).toEqual(refused);
    // Anchors that differ from the reports, or are missing
    expect(issuesOf(widened(anchors(1.6, 2.2), outlook([1.6, 2.3])))).toEqual(refused);
    expect(issuesOf(widened(tier, outlook([1.6, 2.2])))).toEqual(refused);
    expect(labResultSchema.safeParse(widened([...anchors(1.6, 2.2), ...anchors(2.3, 2.4).slice(2), { fromLead: 400, ratio: 3 }, { fromLead: 401, ratio: 3 }])).success)
      .toBe(true);
    expect(labResultSchema.safeParse(widened([...anchors(1.6, 2.2), ...anchors(2.3, 2.4), { fromLead: 400, ratio: 3 }])).success).toBe(false);
  });
});
