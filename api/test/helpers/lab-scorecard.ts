// Synthetic scorecards for the gate tests; the numbers mean nothing.
import type { LabScorecard, Metrics, Scorecard } from '../../src/lab/scorecard.ts';

export function metricsWith(overrides: Partial<Metrics> = {}): Metrics {
  return {
    weeklyWape: 0.2,
    dailyWape: 0.3,
    typicalWeek: 0.15,
    weeksOver20: 3,
    worstWeek: 0.4,
    coverage80: { inside: 10, weeks: 12 },
    dailyCoverage80: 0.8,
    weekdayBias: { Mon: 0.01, Tue: null, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 },
    weekdayBiasMeanAbs: 0.05,
    ...overrides,
  };
}

/**
 * A lab-input/3 scorecard (D42, D52): a model run by default, its `engines` figures its backtest's (the baseline's a
 * point worse) unless given, a weekly bias of 0, no longer-horizon reports, and the outlook horizons' reports (OUTLOOK,
 * the growth floor's ratios from a 91-day ratio of 1.2; helpers/lab.ts labResultFor's widening carries their anchors).
 */
export function scorecardWith(overrides: {
  engine?: LabScorecard['engine'];
  history?: Partial<Scorecard['history']>;
  backtest?: Partial<LabScorecard['backtest']>;
  comparison?: Scorecard['comparison'];
  engines?: LabScorecard['engines'];
} = {}): LabScorecard {
  const comparison: Scorecard['comparison'] =
    overrides.comparison !== undefined
      ? overrides.comparison
      : {
          championRunId: 'run-a',
          championDataThrough: '2026-01-01',
          from: '2026-01-05',
          to: '2026-03-29',
          weeks: 12,
          champion: metricsWith({ weeklyWape: 0.2 }),
          challenger: metricsWith({ weeklyWape: 0.19 }),
          series: [],
        };
  const engine = overrides.engine ?? 'model';
  const backtest: LabScorecard['backtest'] = {
    from: '2026-01-05',
    to: '2026-03-29',
    origins: [],
    weeks: 12,
    weeksWithRange: 12,
    metrics: metricsWith({ weeklyWape: 0.19 }),
    metrics7: metricsWith(),
    weekdayMedianWeeklyWape: 0.2,
    weeklyBias: 0,
    folds: [],
    series: [],
    ...overrides.backtest,
  };
  const own = { weeks: backtest.weeks, weeklyWape: backtest.metrics.weeklyWape, weeklyBias: backtest.weeklyBias, coverage80: backtest.metrics.coverage80 };
  const other = { ...own, weeklyWape: own.weeklyWape + 0.01 };
  return {
    horizonDays: 28,
    engine,
    history: { firstDate: '2024-10-01', lastDate: '2026-06-01', days: 600, spanDays: 608, ...overrides.history },
    backtest,
    comparison,
    engines: overrides.engines ?? (engine === 'model' ? { model: own, baseline: other } : { model: other, baseline: own }),
    horizon91: null,
    horizonReach: null,
    horizonOutlook: OUTLOOK.map((report) => ({ ...report, coverage80: { ...report.coverage80 } })),
  };
}

/** The outlook horizons' reports scorecardWith gives (D52): no year-ahead backtest, so the growth floor alone. */
export const OUTLOOK: LabScorecard['horizonOutlook'] = [
  { horizon: 182, weeks: 0, weeklyWape: null, coverage80: { inside: 0, weeks: 0 }, ratio: 1.2 * Math.sqrt(2), basis: 'growth' },
  { horizon: 365, weeks: 0, weeklyWape: null, coverage80: { inside: 0, weeks: 0 }, ratio: 1.2 * Math.sqrt(365 / 91), basis: 'growth' },
];

export function comparisonWith(
  champion: Partial<Metrics>,
  challenger: Partial<Metrics>,
  weeks = 12,
): NonNullable<Scorecard['comparison']> {
  return {
    championRunId: 'run-a',
    championDataThrough: '2026-01-01',
    from: '2026-01-05',
    to: '2026-03-29',
    weeks,
    champion: metricsWith(champion),
    challenger: metricsWith(challenger),
    series: [],
  };
}

/** `card` as a stored scorecard from before lab-input/2: no engine, engines, weekly bias or horizon reports. */
export function storedScorecard(card: LabScorecard = scorecardWith()): Scorecard {
  const { from, to, origins, weeks, weeksWithRange, metrics, metrics7, weekdayMedianWeeklyWape, folds, series } = card.backtest;
  return {
    horizonDays: card.horizonDays, history: card.history, comparison: card.comparison,
    backtest: { from, to, origins, weeks, weeksWithRange, metrics, metrics7, weekdayMedianWeeklyWape, folds, series },
  };
}
