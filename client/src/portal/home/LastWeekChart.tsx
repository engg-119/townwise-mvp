import type { ChartTip } from '../analytics/barTips';
import type { ComparedDay } from '../analytics/week';
import type { Metric } from '../analytics/words';

// Last week's chart (home.md 2.4). Native has no SVG (D21): the card's text summary and its table carry the same
// numbers, so this draws nothing. LastWeekChart.web.tsx draws the pairs, and each forecast-only day in the forecast style.

/** A day with a published forecast and no guests stored (D42): the run's own middle and 80% range, in guests. */
export interface ForecastBar {
  date: string;
  low: number;
  mid: number;
  high: number;
}

export interface LastWeekChartProps {
  days: readonly ComparedDay[];
  metric: Metric;
  /** Forecast-only days, drawn outlined with their range and keyed "Forecast"; never summed with the stored days. */
  forecast: readonly ForecastBar[];
  /** Web: each day's hover words, in `days`' order (the same words as its row in Show the numbers). */
  tips: readonly ChartTip[];
  /** Web: a click on a day's slot opens it (in the Calendar). */
  onOpen: (date: string) => void;
}

export const LastWeekChart: (props: LastWeekChartProps) => React.JSX.Element | null = () => null;
