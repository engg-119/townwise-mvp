// How a run was trained, as staff read it (lab/training.ts, spec D50), without Docker: an imported run's few facts, a
// lab model run's method, folds and learning curve, a baseline run's rule, and no guest figure in any of them. Also
// the scorecard's `learning` field: optional, strict, its two curves the same length. Synthetic records.
import { describe, expect, it } from 'vitest';

import { labScorecardSchema, scorecardSchema, type Learning } from '../src/lab/scorecard.ts';
import { runTrainingView } from '../src/lab/training.ts';
import type { ForecastRunRecord } from '../src/stores/forecasts.ts';
import { scorecardWith } from './helpers/lab-scorecard.ts';

const LEARNING: Learning = {
  trainThrough: '2025-12-31', from: '2026-01-01', to: '2026-06-01', trainDays: 430, validDays: 140, metric: 'mae_log',
  train: [0.2, 0.15, 0.12], valid: [0.21, 0.18, 0.19],
};

const MODEL_PARAMS = {
  target: 'guests', baseCols: ['weekday', 'recent_level', 'term'], eventCols: ['ev_test-town:home-football', 'private_event', 'week_of_term', 'weekday'],
  regimeStart: null,
  xgb: {
    objective: 'reg:absoluteerror', n_estimators: 400, learning_rate: 0.03, max_depth: 3, min_child_weight: 5, subsample: 0.8,
    colsample_bytree: 0.8, reg_lambda: 5, random_state: 0, n_jobs: 1,
  },
  holidayLambdas: { hol_big_night: 3, hol_halloween: 3 }, holidayEffects: { hol_big_night: 1.4, hol_halloween: 0.9 }, widenK: 1.2,
  weeklyLogRange: { lo: -0.1, hi: 0.1 }, refitEveryMonths: 3, horizonDays: 28, minPastWeeks: 8, floor: 1,
};

const BASELINE_PARAMS = {
  target: 'guests', engine: 'baseline', regimeStart: null, levelDays: 364, levelMinDays: 28, shapeClamp: { min: 0.5, max: 2 },
  calendarEffects: {}, dailyLogRange: { lo: -0.2, hi: 0.2 }, widenK: 1.1, weeklyLogRange: { lo: -0.1, hi: 0.1 }, widening: [],
  horizonDays: 28, minPastWeeks: 8, floor: 1,
};

function run(fields: Partial<ForecastRunRecord> = {}): ForecastRunRecord {
  return {
    id: 'r1', locationId: 'l1', metric: 'guests',
    model: { family: 'hybrid_linear_xgboost', version: 'v3', notebookCommit: 'abc1234' },
    trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-06-01', madeAt: '2026-06-02', frozen: false,
    interval: { level: 0.8, widened: true },
    backtest: { from: '2026-01-05', to: '2026-05-31', weeks: 21, weeklyTypicalErrorPct: 7.5, weeksOver20Pct: 1, weeklyRangePct: { below: 12, above: 15 } },
    range: { from: '2026-06-02', to: '2026-06-29' }, dayCount: 28, weekCount: 4, status: 'draft', importedBy: null,
    importedAt: new Date('2026-06-02T08:00:00.000Z'), publishedAt: null, withdrawnAt: null, lab: null, ...fields,
  };
}

function labRun(params: unknown, paramsJson = JSON.stringify(params)): ForecastRunRecord {
  return run({
    trainingSource: 'townwise_lab',
    lab: { calibrationId: 'c1', codeVersion: 'f'.repeat(40), imageDigest: 'sha256:abc', inputSha256: 'a'.repeat(64), paramsJson },
  });
}

describe('runTrainingView', () => {
  it('gives an imported run what its file held: the commit, the days and its backtest summary, nothing else', () => {
    const view = runTrainingView(run(), null);
    expect(view).toEqual({
      code: { commit: 'abc1234', imageDigest: null },
      history: { from: '2025-01-01', to: '2026-06-01', days: null },
      method: null,
      backtest: run().backtest,
      validation: null,
      learning: null,
    });
  });

  it('gives a lab model run its inputs, tree settings, backtest, folds and learning curve', () => {
    const card = scorecardWith({
      backtest: { folds: [{ trainThrough: '2025-12-31', from: '2026-01-01', to: '2026-06-01', weeks: 21, weeklyWape: 0.0912, weeksOver20: 2 }] },
    });
    const view = runTrainingView(labRun(MODEL_PARAMS), { scorecardJson: JSON.stringify({ ...card, learning: LEARNING }) });
    expect(view.code).toEqual({ commit: 'f'.repeat(40), imageDigest: 'sha256:abc' });
    expect(view.history.days).toBe(600);
    expect(view.method).toEqual({
      kind: 'model', baseInputs: MODEL_PARAMS.baseCols, eventInputs: MODEL_PARAMS.eventCols,
      trees: { objective: 'reg:absoluteerror', rounds: 400, learningRate: 0.03, maxDepth: 3, minChildWeight: 5, subsample: 0.8, columnSample: 0.8, l2: 5 },
      refitEveryMonths: 3, regimeStart: null,
    });
    expect(view.validation).toMatchObject({
      weeks: 12, weeklyWapePct: 19, dailyWapePct: 30, worstWeekPct: 40, weeksOver20: 3, coverage: { inside: 10, weeks: 12 },
      weekdayMedianWeeklyWapePct: 20, engines: { modelWeeklyWapePct: 19, baselineWeeklyWapePct: 20 },
      folds: [{ trainThrough: '2025-12-31', from: '2026-01-01', to: '2026-06-01', weeks: 21, weeklyWapePct: 9.1, weeksOver20: 2 }],
    });
    expect(view.learning).toEqual(LEARNING);
  });

  it('never carries the scorecard’s weekly series, which holds actual guests (D7)', () => {
    const card = scorecardWith({ backtest: { series: [{ week: '2026-01-05', actual: 987_654, mid: 876_543.5, low: null, high: null }] } });
    const text = JSON.stringify(runTrainingView(labRun(MODEL_PARAMS), { scorecardJson: JSON.stringify(card) }));
    expect(text).not.toContain('987654');
    expect(text).not.toContain('876543');
    expect(text).not.toContain('series');
  });

  it('gives a baseline run its rule and no curve; a run from before the lab recorded one has none either', () => {
    const view = runTrainingView(labRun(BASELINE_PARAMS), { scorecardJson: JSON.stringify(scorecardWith({ engine: 'baseline' })) });
    expect(view.method).toEqual({ kind: 'baseline', levelDays: 364, levelMinDays: 28, regimeStart: null });
    expect(view.learning).toBeNull();
    expect(view.validation?.engines).toEqual({ modelWeeklyWapePct: 20, baselineWeeklyWapePct: 19 });
  });

  it('reads as an imported run when the calibration is gone, its scorecard no longer parses, or its params don’t', () => {
    expect(runTrainingView(labRun(MODEL_PARAMS), null)).toMatchObject({ validation: null, learning: null, method: { kind: 'model' } });
    expect(runTrainingView(labRun(MODEL_PARAMS), { scorecardJson: '{"horizonDays":7}' })).toMatchObject({ validation: null, learning: null });
    expect(runTrainingView(labRun({ target: 'guests' }), null).method).toBeNull();
    expect(runTrainingView(labRun(null, 'not json'), null).method).toBeNull();
  });
});

describe('the scorecard’s learning', () => {
  it('is optional and may be null, on a stored scorecard and on one a result is posted with', () => {
    const card = scorecardWith();
    for (const schema of [scorecardSchema, labScorecardSchema]) {
      expect(schema.safeParse(card).success).toBe(true);
      expect(schema.safeParse({ ...card, learning: null }).success).toBe(true);
      expect(schema.safeParse({ ...card, learning: LEARNING }).success).toBe(true);
    }
  });

  it('refuses curves of different lengths, an empty curve, a negative loss, another metric and an unknown key', () => {
    const card = scorecardWith();
    const bad = [
      { ...LEARNING, valid: [0.2, 0.1] },
      { ...LEARNING, train: [], valid: [] },
      { ...LEARNING, train: [0.2, -0.1, 0.1] },
      { ...LEARNING, metric: 'rmse' },
      { ...LEARNING, guests: 120 },
    ];
    for (const learning of bad) expect(labScorecardSchema.safeParse({ ...card, learning }).success).toBe(false);
  });
});
