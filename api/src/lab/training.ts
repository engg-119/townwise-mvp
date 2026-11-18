// What staff read of how one forecast run was trained (P21 Forecasts, spec D50): the code and the days it learned
// from, its method and settings, its backtest and, for a model run the lab made, how its trees learned round by round.
// Percentages, counts, dates, settings and loss ratios only (spec D7: no guest figure outside view-as), so the
// scorecard's weekly series, which holds actual guests, never passes through here. An imported run carries only what
// its file held: no method, no folds and no curve. Pure.
import type { CalibrationRecord } from '../stores/calibrations.ts';
import type { ForecastRunRecord } from '../stores/forecasts.ts';
import { labParamsSchema } from './result.ts';
import type { Learning } from './scorecard.ts';
import { pct, scorecardOf } from './views.ts';

export type TrainingMethod =
  | {
    kind: 'model';
    /** The linear baselines' inputs, then the trees' (calendar groups, never an owner's own entry by name). */
    baseInputs: string[];
    eventInputs: string[];
    trees: {
      objective: string; rounds: number; learningRate: number; maxDepth: number; minChildWeight: number;
      subsample: number; columnSample: number; l2: number;
    };
    refitEveryMonths: number;
    regimeStart: string | null;
  }
  | { kind: 'baseline'; levelDays: number; levelMinDays: number; regimeStart: string | null };

export interface TrainingFold {
  trainThrough: string;
  from: string;
  to: string;
  weeks: number;
  weeklyWapePct: number;
  weeksOver20: number;
}

export interface TrainingValidation {
  from: string;
  to: string;
  weeks: number;
  weeklyWapePct: number;
  dailyWapePct: number;
  worstWeekPct: number;
  weeksOver20: number;
  coverage: { inside: number; weeks: number };
  /** The same weeks forecast by each weekday's median: what the run has to beat. */
  weekdayMedianWeeklyWapePct: number;
  /** Each engine on the same weeks; null where the lab did not report it (the model under 595 days). */
  engines: { modelWeeklyWapePct: number | null; baselineWeeklyWapePct: number } | null;
  folds: TrainingFold[];
}

export interface RunTrainingView {
  /** The commit of the code that made the run, and for a lab run the image it ran in. */
  code: { commit: string; imageDigest: string | null };
  history: { from: string; to: string; days: number | null };
  method: TrainingMethod | null;
  /** The run file's own backtest summary: every run may carry one. */
  backtest: ForecastRunRecord['backtest'];
  validation: TrainingValidation | null;
  learning: Learning | null;
}

function methodOf(paramsJson: string): TrainingMethod | null {
  let raw: unknown;
  try {
    raw = JSON.parse(paramsJson);
  } catch {
    return null;
  }
  const parsed = labParamsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const params = parsed.data;
  if ('engine' in params) {
    return { kind: 'baseline', levelDays: params.levelDays, levelMinDays: params.levelMinDays, regimeStart: params.regimeStart };
  }
  return {
    kind: 'model',
    baseInputs: params.baseCols,
    eventInputs: params.eventCols,
    trees: {
      objective: params.xgb.objective, rounds: params.xgb.n_estimators, learningRate: params.xgb.learning_rate,
      maxDepth: params.xgb.max_depth, minChildWeight: params.xgb.min_child_weight, subsample: params.xgb.subsample,
      columnSample: params.xgb.colsample_bytree, l2: params.xgb.reg_lambda,
    },
    refitEveryMonths: params.refitEveryMonths,
    regimeStart: params.regimeStart,
  };
}

/** `calibration` is the one that made a lab run (run.lab.calibrationId); null for an imported run, or once it is gone. */
export function runTrainingView(run: ForecastRunRecord, calibration: Pick<CalibrationRecord, 'scorecardJson'> | null): RunTrainingView {
  const scorecard = calibration === null ? null : scorecardOf(calibration.scorecardJson);
  const backtest = scorecard?.backtest ?? null;
  return {
    code: { commit: run.lab?.codeVersion ?? run.model.notebookCommit, imageDigest: run.lab?.imageDigest ?? null },
    history: { from: run.trainedFrom, to: run.dataThrough, days: scorecard?.history.days ?? null },
    method: run.lab === null ? null : methodOf(run.lab.paramsJson),
    backtest: run.backtest,
    validation: scorecard === null || backtest === null ? null : {
      from: backtest.from,
      to: backtest.to,
      weeks: backtest.weeks,
      weeklyWapePct: pct(backtest.metrics.weeklyWape),
      dailyWapePct: pct(backtest.metrics.dailyWape),
      worstWeekPct: pct(backtest.metrics.worstWeek),
      weeksOver20: backtest.metrics.weeksOver20,
      coverage: { inside: backtest.metrics.coverage80.inside, weeks: backtest.metrics.coverage80.weeks },
      weekdayMedianWeeklyWapePct: pct(backtest.weekdayMedianWeeklyWape),
      engines: scorecard.engines === undefined ? null : {
        modelWeeklyWapePct: scorecard.engines.model === null ? null : pct(scorecard.engines.model.weeklyWape),
        baselineWeeklyWapePct: pct(scorecard.engines.baseline.weeklyWape),
      },
      folds: backtest.folds.map((fold) => ({
        trainThrough: fold.trainThrough, from: fold.from, to: fold.to, weeks: fold.weeks,
        weeklyWapePct: pct(fold.weeklyWape), weeksOver20: fold.weeksOver20,
      })),
    },
    learning: scorecard?.learning ?? null,
  };
}
