import type { OverviewDay } from './schemas';

// The Overview's activity by day (P32, design decision 7). Native has no SVG (D21), and the console is web only anyway:
// the summary line and the "Show each day" table beside it carry the same numbers, so this draws nothing.
// ActivityChart.web.tsx draws the bars.

export interface ActivityChartProps {
  series: readonly OverviewDay[];
}

export const ActivityChart: (props: ActivityChartProps) => React.JSX.Element | null = () => null;
