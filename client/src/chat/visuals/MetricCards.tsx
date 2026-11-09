import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { Visual } from './schema';
import { metricCards } from './words';

// Small metric cards (a total, a daily average, the days with data and a change): square, `panel`, a 1px border.

const C = theme.color;

export function MetricCards(props: { visual: Extract<Visual, { kind: 'metrics' }> }): React.JSX.Element {
  return (
    <View style={styles.row}>
      {metricCards(props.visual).map((card) => (
        <View key={card.label} style={styles.card}>
          <Text style={styles.label}>{card.label}</Text>
          <Text style={styles.value}>{card.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  card: { flexGrow: 1, flexBasis: 140, minWidth: 140, gap: theme.space[1], padding: theme.space[3], backgroundColor: C.panel, borderWidth: 1, borderColor: C.border },
  label: { ...theme.type.small, color: C.text2 },
  value: { ...theme.type.monoUi, fontWeight: '500', color: C.white, fontVariant: ['tabular-nums'] },
});
