import type { Metric } from './words';

// Analytics' charts (home.md 4.6). Native has no SVG (D21): every section keeps its text summary, its basis line
// and its table, so each chart here draws nothing. AnalyticsCharts.web.tsx draws them.

export interface Bar {
  label: string;
  /** Null draws no bar (no data, or too few days). */
  value: number | null;
}

export interface BarChartProps { bars: readonly Bar[]; metric: Metric }

export interface YearLine {
  year: number;
  /** Months 1 to 12; null where the month has no value. */
  points: readonly ({ value: number; complete: boolean } | null)[];
}

export interface LineChartProps { lines: readonly YearLine[]; metric: Metric }

/** An effect as a fraction (0.27 is 27% more than usual), drawn from 50% fewer to 50% more. */
export interface EffectBarProps { effect: number }

export const BarChart: (props: BarChartProps) => React.JSX.Element | null = () => null;
export const HorizontalBars: (props: BarChartProps) => React.JSX.Element | null = () => null;
export const LineChart: (props: LineChartProps) => React.JSX.Element | null = () => null;
export const EffectBar: (props: EffectBarProps) => React.JSX.Element | null = () => null;
