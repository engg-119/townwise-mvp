// The lab result as the callback receives it (D42, lab-input/4): its scorecard names the engine, both engines' figures,
// its weekly bias, the longer-horizon reports, which the gate reads, and both outlook horizons' reports (D52), so a
// result without them is refused while a stored scorecard from before still parses (lab-scorecard.test.ts).
// checkLabResult also holds the engine the scorecard names to its run's model family and its params, and checks the
// outlook for sanity. The golden result is the lab's own (modeling/lab/tests/golden), a year-long baseline run.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { tierEnd } from '../src/forecasts/tiers.ts';
import { labInputSchema } from '../src/lab/input.ts';
import { checkLabResult, labResultSchema, MAX_BACKTEST_DAYS, type LabSuccess } from '../src/lab/result.ts';
import { labScorecardSchema, scorecardSchema } from '../src/lab/scorecard.ts';
import { storedScorecard } from './helpers/lab-scorecard.ts';

function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../modeling/lab/tests/golden/${name}`, import.meta.url), 'utf8'));
}

const input = labInputSchema.parse(golden('input.json'));
const calibration = {
  id: input.calibrationId, dataThrough: input.dataThrough, championRunId: input.champion?.runId ?? null, termsThrough: input.termsThrough,
};

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
    expect(scorecard.horizonOutlook.map((report) => report.horizon)).toEqual([182, 365]);
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
      // Release B (D52): both outlook horizons, 182 then 365
      { ...result.scorecard, horizonOutlook: undefined },
      { ...result.scorecard, horizonOutlook: result.scorecard.horizonOutlook.slice(0, 1) },
      { ...result.scorecard, horizonOutlook: [...result.scorecard.horizonOutlook].reverse() },
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
  function reaching(last: string, result: LabSuccess = goldenResult()): LabSuccess {
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
  const tier = [{ fromLead: 29, ratio: 1 }, { fromLead: 92, ratio: 1.1 }];
  const anchors = (r182: number, r365: number) => [{ fromLead: 183, ratio: r182, horizon: 182 }, { fromLead: 365, ratio: r365, horizon: 365 }];
  /** The golden result with `widening` in its params and `horizonOutlook` in its scorecard. */
  function widened(widening: unknown[], horizonOutlook: unknown[] = outlook([1.6, 2.2])): unknown {
    const result = goldenResult();
    return { ...result, params: { ...result.params, widening }, scorecard: { ...result.scorecard, horizonOutlook } };
  }
  /** `result` as the trained model's: its run's family, its scorecard's engine and model params, which D42 holds together. */
  function asModel(result: LabSuccess): LabSuccess {
    const { regimeStart, widenK, weeklyLogRange, widening, horizonDays, minPastWeeks, floor } = result.params;
    return {
      ...result,
      scorecard: { ...result.scorecard, engine: 'model' },
      run: { ...result.run, model: { ...result.run.model, family: 'hybrid_linear_xgboost' } },
      params: {
        target: 'guests', baseCols: ['dow_Monday'], eventCols: [], regimeStart, widenK, weeklyLogRange, widening, horizonDays, minPastWeeks, floor,
        xgb: {
          objective: 'reg:quantileerror', n_estimators: 400, learning_rate: 0.05, max_depth: 4, min_child_weight: 1, subsample: 0.8,
          colsample_bytree: 0.8, reg_lambda: 1, random_state: 0, n_jobs: 1,
        },
        holidayLambdas: { hol_big_night: 1, hol_halloween: 1 }, holidayEffects: { hol_big_night: 1.1, hol_halloween: 1 }, refitEveryMonths: 3,
      },
    };
  }

  it('passes today’s golden result, a year-long run, and a run reaching a year from its made-at date within 400 days of its data', () => {
    const result = goldenResult();
    expect(result.run.days.at(-1)?.date).toBe(plus(result.run.madeAt, 365));
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
      const lagging = reaching(plus(result.run.dataThrough, 400));
      return { ...lagging, run: { ...lagging.run, madeAt: plus(result.run.dataThrough, lag) } };
    };
    const asOf = (lag: number) => checkLabResult(madeLate(lag), calibration, plus(result.run.dataThrough, lag));
    expect(asOf(49)).toMatchObject({ ok: true });
    // 30 days behind, the same last day is past its today plus 365.
    expect(asOf(30)).toMatchObject({ ok: false, issues: [{ path: 'run.days', code: 'outlook_too_far' }] });
  });

  it('refuses a model run whose outlook passes the town’s last researched term with outlook_past_terms, never its forecast tier', () => {
    const result = goldenResult();
    const tierLast = tierEnd(result.run);
    const issuesWith = (raw: unknown, termsThrough: string | null) => {
      const check = checkLabResult(raw, { ...calibration, termsThrough }, input.today);
      return check.ok ? [] : check.issues;
    };
    const refused = [{ path: 'run.days', code: 'outlook_past_terms' }];
    const terms = plus(tierLast, 120);
    expect(issuesWith(asModel(reaching(plus(tierLast, 200))), terms)).toEqual(refused);
    expect(issuesWith(asModel(reaching(terms)), terms)).toEqual([]);
    // A last researched term before the forecast tier ends cuts the outlook only: the tier is never refused for it
    expect(issuesWith(asModel(reaching(tierLast)), plus(tierLast, -40))).toEqual([]);
    expect(issuesWith(asModel(reaching(plus(tierLast, 1))), plus(tierLast, -40))).toEqual(refused);
    // A town with no researched terms, and the baseline, whose run is never cut
    expect(issuesWith(asModel(result), null)).toEqual([]);
    expect(issuesWith(reaching(plus(tierLast, 200)), terms)).toEqual([]);
    expect(issuesWith(result, plus(tierLast, -40))).toEqual([]);
  });

  it('refuses widening whose leads do not increase, or whose ratios fall under 1 or decrease, with widening_out_of_order', () => {
    const refused = [{ path: 'params.widening', code: 'widening_out_of_order' }];
    const outlookAnchors = anchors(1.6, 2.2);
    expect(issuesOf(widened([...tier, ...outlookAnchors]))).toEqual([]);
    expect(issuesOf(widened([{ fromLead: 29, ratio: 1 }, { fromLead: 29, ratio: 1.1 }, ...outlookAnchors]))).toEqual(refused);
    expect(issuesOf(widened([{ fromLead: 92, ratio: 1.1 }, { fromLead: 29, ratio: 1.2 }, ...outlookAnchors]))).toEqual(refused);
    expect(issuesOf(widened([{ fromLead: 29, ratio: 0.9 }, ...outlookAnchors]))).toEqual(refused);
    expect(issuesOf(widened([{ fromLead: 29, ratio: 1.2 }, { fromLead: 92, ratio: 1.1 }, ...outlookAnchors]))).toEqual(refused);
  });

  it('holds the outlook anchors to horizonOutlook’s ratios: a narrowing outlook is refused', () => {
    const refused = [{ path: 'params.widening', code: 'widening_out_of_order' }];
    expect(issuesOf(widened([...tier, ...anchors(1.6, 2.2)], outlook([1.6, 2.2])))).toEqual([]);
    // The 365-day anchor lower than the 182-day one
    expect(issuesOf(widened([...tier, ...anchors(1.6, 1.5)], outlook([1.6, 1.5])))).toEqual(refused);
    // Anchors that differ from the reports, or are missing
    expect(issuesOf(widened([...tier, ...anchors(1.6, 2.2)], outlook([1.6, 2.3])))).toEqual(refused);
    expect(issuesOf(widened(tier, outlook([1.6, 2.2])))).toEqual(refused);
    // Up to 8 entries
    const many = [...tier, ...anchors(1.6, 2.2), { fromLead: 380, ratio: 2.3 }, { fromLead: 390, ratio: 2.4 }, { fromLead: 400, ratio: 3 }];
    expect(labResultSchema.safeParse(widened([...many, { fromLead: 401, ratio: 3 }])).success).toBe(true);
    expect(labResultSchema.safeParse(widened([...many, { fromLead: 401, ratio: 3 }, { fromLead: 402, ratio: 3 }])).success).toBe(false);
  });
});

describe('backtestDays (D72)', () => {
  /** The golden result as JSON with `backtestDays` replaced (or left out, with undefined). */
  function withDays(days: unknown[] | undefined): Record<string, unknown> {
    const raw = structuredClone(golden('result.json')) as Record<string, unknown>;
    if (days === undefined) delete raw.backtestDays;
    else raw.backtestDays = days;
    return raw;
  }
  const day = (date: string, more: Record<string, unknown> = {}) => ({
    date, engine: 'baseline', dataThrough: '2025-08-31', low: 40, mid: 50, high: 62, ...more,
  });

  it('the golden result carries them, ascending and each before the run’s last day of data, and passes', () => {
    const result = goldenResult();
    expect(result.backtestDays.length).toBeGreaterThan(300);
    const dates = result.backtestDays.map((each) => each.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
    expect(result.backtestDays.every((each) => each.dataThrough < each.date && each.date <= result.run.dataThrough)).toBe(true);
    expect(issuesOf(golden('result.json'))).toEqual([]);
  });

  it('a result from a lab before v14, without the field, still parses and passes, with none', () => {
    const parsed = labResultSchema.parse(withDays(undefined));
    if (!parsed.ok) return expect.unreachable('a success');
    expect(parsed.backtestDays).toEqual([]);
    expect(issuesOf(withDays(undefined))).toEqual([]);
    expect(issuesOf(withDays([]))).toEqual([]);
  });

  it('refuses dates out of order or repeated, a day forecast from data that reached it, and a day after the run’s data', () => {
    const { run } = goldenResult();
    expect(run.dataThrough).toBe('2025-10-21');
    expect(issuesOf(withDays([day('2025-09-02'), day('2025-09-01')]))).toEqual([{ path: 'backtestDays[1].date', code: 'dates_out_of_order' }]);
    expect(issuesOf(withDays([day('2025-09-02'), day('2025-09-02')]))).toEqual([{ path: 'backtestDays[1].date', code: 'dates_out_of_order' }]);
    expect(issuesOf(withDays([day('2025-08-31')]))).toEqual([{ path: 'backtestDays[0].date', code: 'not_after_data' }]);
    expect(issuesOf(withDays([day('2025-09-01', { dataThrough: '2025-09-02' })]))).toEqual([{ path: 'backtestDays[0].date', code: 'not_after_data' }]);
    expect(issuesOf(withDays([day('2025-10-21', { dataThrough: '2025-10-01' })]))).toEqual([]);
    expect(issuesOf(withDays([day('2025-10-22', { dataThrough: '2025-10-01' })]))).toEqual([{ path: 'backtestDays[0].date', code: 'after_data_through' }]);
  });

  it('refuses a range out of order', () => {
    expect(issuesOf(withDays([day('2025-09-01', { low: 51 })]))).toEqual([{ path: 'backtestDays[0].mid', code: 'below_low' }]);
    expect(issuesOf(withDays([day('2025-09-01', { high: 49 })]))).toEqual([{ path: 'backtestDays[0].high', code: 'below_mid' }]);
    expect(issuesOf(withDays([day('2025-09-01', { low: 50, mid: 50, high: 50 })]))).toEqual([]);
  });

  it('refuses a fraction, a negative, another engine, a bad date, an extra key and more than 450 days, by the schema', () => {
    for (const bad of [
      day('2025-09-01', { mid: 50.5 }), day('2025-09-01', { low: -1 }), day('2025-09-01', { engine: 'hybrid' }), day('2025-02-30'),
      day('2025-09-01', { dataThrough: '2025-8-31' }), day('2025-09-01', { label: 'x' }), { ...day('2025-09-01'), high: undefined },
    ]) {
      expect(labResultSchema.safeParse(withDays([bad])).success).toBe(false);
      expect(issuesOf(withDays([bad])).length).toBeGreaterThan(0);
    }
    const plus = (from: string, days: number) => new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const many = (n: number) => Array.from({ length: n }, (_, i) => day(plus('2024-07-01', i), { dataThrough: '2024-06-30' }));
    expect(MAX_BACKTEST_DAYS).toBe(450);
    expect(issuesOf(withDays(many(450)))).toEqual([]);
    expect(labResultSchema.safeParse(withDays(many(451))).success).toBe(false);
  });
});
