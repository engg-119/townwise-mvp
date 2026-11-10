// What a calibration looks like in the TownwiseAI chat: chart-ready data and cards the app draws (forecast lab design
// call 10), and the three next steps each reply suggests. Pure. Only backtest weeks reach the chat, which are the
// owner's own history; no draft forecast day does.
import type { Metrics, Scorecard } from './scorecard.ts';

export type ChatComponent =
  | {
    type: 'line_band_chart';
    title: string;
    unit: 'guests';
    rows: { x: string; actual: number | null; mid: number; low: number | null; high: number | null; compare: number | null }[];
    series: { key: 'actual' | 'mid' | 'compare'; label: string }[];
    band: { label: string } | null;
  }
  | {
    type: 'metric_cards';
    cards: {
      key: string; label: string; value: number; unit: 'pct' | 'count'; of: number | null; compare: number | null;
      better: 'lower' | 'closer_to_80';
    }[];
  }
  | {
    type: 'comparison_table';
    columns: ['', 'Current forecast', 'New calibration'];
    rows: { label: string; current: string; candidate: string }[];
  };

type MetricCard = Extract<ChatComponent, { type: 'metric_cards' }>['cards'][number];
type Comparison = NonNullable<Scorecard['comparison']>;

export type NextStepsKind = 'started' | 'published' | 'draft' | 'compared';

export const NEXT_STEPS: Readonly<Record<NextStepsKind, readonly [string, string, string]>> = {
  started: ['How is the calibration going?', 'What does a calibration check before it’s published?', 'Show this week’s forecast'],
  published: ['Compare it with the old forecast', 'Which weeks did it miss most?', 'Show next week’s forecast'],
  draft: ['Why wasn’t it published?', 'Compare it with the current forecast', 'Calibrate again with a change in our weekly pattern'],
  compared: ['Which weeks did it miss most?', 'Show next week’s forecast', 'What would make it better?'],
};

const CHART_TITLE = 'Held-out weeks: guests and the forecast’s 80% range';
const BAND = { label: '80% range' } as const;

/** A fraction as a percentage with one decimal. */
function pct(value: number): number {
  return Math.round(value * 1000) / 10;
}

function pctWords(value: number): string {
  return `${pct(value).toFixed(1)}%`;
}

/** Guests: the low end rounds down, the high end up, the middle to the nearest (the callers round). */
function chartOf(rows: Extract<ChatComponent, { type: 'line_band_chart' }>['rows'], compare: boolean): ChatComponent {
  return {
    type: 'line_band_chart', title: CHART_TITLE, unit: 'guests', rows,
    series: [
      { key: 'actual', label: 'Actual' },
      { key: 'mid', label: 'Forecast' },
      ...(compare ? [{ key: 'compare' as const, label: 'Current forecast' }] : []),
    ],
    band: rows.some((row) => row.low !== null && row.high !== null) ? BAND : null,
  };
}

/** The calibration's own backtest weeks: the actual guests, its forecast and its 80% range. */
export function backtestChart(scorecard: Scorecard): ChatComponent {
  return chartOf(scorecard.backtest.series.map((row) => ({
    x: row.week, actual: row.actual, mid: Math.round(row.mid),
    low: row.low === null ? null : Math.floor(row.low), high: row.high === null ? null : Math.ceil(row.high), compare: null,
  })), false);
}

/** The held-out weeks both models were scored on: the calibration with its range, and the current forecast. */
export function comparisonChart(comparison: Comparison): ChatComponent {
  return chartOf(comparison.series.map((row) => ({
    x: row.week, actual: row.actual, mid: Math.round(row.challenger),
    low: row.challengerLow === null ? null : Math.floor(row.challengerLow),
    high: row.challengerHigh === null ? null : Math.ceil(row.challengerHigh),
    compare: Math.round(row.champion),
  })), true);
}

/** The six metrics as cards, each beside the current forecast's when there is one. */
export function metricCards(metrics: Metrics, compare: Metrics | null): ChatComponent {
  const pctCard = (key: string, label: string, pick: (m: Metrics) => number): MetricCard => ({ key, label, value: pct(pick(metrics)), unit: 'pct', of: null, compare: compare === null ? null : pct(pick(compare)), better: 'lower' });
  return {
    type: 'metric_cards',
    cards: [
      pctCard('weeklyWape', 'Weekly error (WAPE)', (m) => m.weeklyWape),
      pctCard('typicalWeek', 'Typical week off by', (m) => m.typicalWeek),
      {
        key: 'weeksOver20', label: 'Weeks over 20% off', value: metrics.weeksOver20, unit: 'count', of: null,
        compare: compare?.weeksOver20 ?? null, better: 'lower',
      },
      pctCard('worstWeek', 'Worst week', (m) => m.worstWeek),
      {
        key: 'coverage80', label: '80% range held', value: metrics.coverage80.inside, unit: 'count', of: metrics.coverage80.weeks,
        compare: compare?.coverage80.inside ?? null, better: 'closer_to_80',
      },
      pctCard('weekdayBias', 'Weekday bias', (m) => m.weekdayBiasMeanAbs),
    ],
  };
}

/** The same six, as words: the current forecast's against the calibration's. */
export function comparisonTable(comparison: Comparison): ChatComponent {
  const { champion, challenger } = comparison;
  const held = (m: Metrics): string => `${m.coverage80.inside} of ${m.coverage80.weeks} weeks`;
  return {
    type: 'comparison_table',
    columns: ['', 'Current forecast', 'New calibration'],
    rows: [
      { label: 'Weekly error (WAPE)', current: pctWords(champion.weeklyWape), candidate: pctWords(challenger.weeklyWape) },
      { label: 'Typical week off by', current: pctWords(champion.typicalWeek), candidate: pctWords(challenger.typicalWeek) },
      { label: 'Weeks over 20% off', current: String(champion.weeksOver20), candidate: String(challenger.weeksOver20) },
      { label: 'Worst week', current: pctWords(champion.worstWeek), candidate: pctWords(challenger.worstWeek) },
      { label: '80% range held', current: held(champion), candidate: held(challenger) },
      { label: 'Weekday bias', current: pctWords(champion.weekdayBiasMeanAbs), candidate: pctWords(challenger.weekdayBiasMeanAbs) },
    ],
  };
}
