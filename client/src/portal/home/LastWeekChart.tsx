import type { ComparedDay } from '../analytics/week';
import type { Metric } from '../analytics/words';

// Last week's chart (home.md 2.4). Native has no SVG (D21): the card's text summary and its table carry the same
// numbers, so this draws nothing. LastWeekChart.web.tsx draws the pairs.

export interface LastWeekChartProps {
  days: readonly ComparedDay[];
  metric: Metric;
}

export const LastWeekChart: (props: LastWeekChartProps) => React.JSX.Element | null = () => null;
