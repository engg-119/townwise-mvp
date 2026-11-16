import { StyleSheet, Text } from 'react-native';

import { theme } from '../../theme';
import type { MeasuredProfile } from '../towns';

// Native has no SVG (spec D21): the profile keeps its text summary and “Show the numbers” table, and says where
// the chart is. TownChart.web.tsx draws it.
export const TownChart: (props: { profile: MeasuredProfile }) => React.JSX.Element = () => (
  <Text style={styles.line}>See the chart at townwise.tech.</Text>
);

const styles = StyleSheet.create({
  line: { ...theme.type.small, color: theme.color.text2 },
});
