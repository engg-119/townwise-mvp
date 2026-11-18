import type { Learning } from './forecasts';

// A model run's learning curve (spec D50). Native has no SVG (D21): the words beside it (learningWords) carry the
// same numbers, so this draws nothing. LearningChart.web.tsx draws the two lines.

export interface LearningChartProps {
  learning: Learning;
}

export const LearningChart: (props: LearningChartProps) => React.JSX.Element | null = () => null;
