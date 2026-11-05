import { StyleSheet, Text } from 'react-native';

import { theme } from '../../theme';
import type { SalesDay } from './api';
import type { Series } from './sales';

// Native has no SVG (spec D21): Sales data keeps the chart's text summary and “Show the numbers”, and says where
// the chart is. SalesChart.web.tsx draws it.

export interface SalesChartProps { days: readonly SalesDay[]; series: Series }

export const SalesChart: (props: SalesChartProps) => React.JSX.Element = () => (
  <Text style={styles.line}>See the chart at townwise.tech.</Text>
);

const styles = StyleSheet.create({
  line: { ...theme.type.small, color: theme.color.text2 },
});
