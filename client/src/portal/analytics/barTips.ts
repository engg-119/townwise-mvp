import type { Bar } from './AnalyticsCharts';

// A bar that brings its own hover words (a fuller label than the one under the chart, the days behind its figure).
// BarChart's props stay as they were: a plain Bar is assignable here, and a bar without `tip` hovers as its label
// and value. `tip: null` turns the hover off for that bar.

export interface ChartTip {
  title: string;
  lines: readonly string[];
}

export interface TipBar extends Bar {
  tip?: ChartTip | null;
}
