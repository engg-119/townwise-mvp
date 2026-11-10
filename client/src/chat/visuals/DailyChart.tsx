import { StyleSheet, Text } from 'react-native';

import { theme } from '../../theme';
import type { Visual } from './schema';
import { NATIVE_CHART } from './words';

// Native has no SVG (spec D21): the visual keeps its title, summary and numbers, and says where the chart is.
// DailyChart.web.tsx draws it.

export interface DailyChartProps { visual: Extract<Visual, { kind: 'daily' }> }

export const DailyChart: (props: DailyChartProps) => React.JSX.Element = () => <Text style={styles.line}>{NATIVE_CHART}</Text>;

const styles = StyleSheet.create({
  line: { ...theme.type.small, color: theme.color.text2 },
});
