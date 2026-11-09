// Synthetic scorecards for the gate tests; the numbers mean nothing.
import type { Metrics, Scorecard } from '../src/lab/scorecard.ts';

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

export function scorecardWith(overrides: {
  history?: Partial<Scorecard['history']>;
  backtest?: Partial<Scorecard['backtest']>;
  comparison?: Scorecard['comparison'];
} = {}): Scorecard {
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
  return {
    horizonDays: 28,
    history: { firstDate: '2025-01-01', lastDate: '2026-06-01', days: 500, spanDays: 500, ...overrides.history },
    backtest: {
      from: '2026-01-05',
      to: '2026-03-29',
      origins: [],
      weeks: 12,
      weeksWithRange: 12,
      metrics: metricsWith({ weeklyWape: 0.19 }),
      metrics7: metricsWith(),
      weekdayMedianWeeklyWape: 0.2,
      folds: [],
      series: [],
      ...overrides.backtest,
    },
    comparison,
  };
}

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
