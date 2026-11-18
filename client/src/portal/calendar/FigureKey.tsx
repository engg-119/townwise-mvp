import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { FIGURE_KEY, markedFigure } from './model';

// The key's two figure entries (D49, design decision 10), on web and native: a sample actual, solid, named “Actual
// guests”, and a sample forecast, lighter after its “~”, named “Forecast”. Home's month key (home/MonthKey.tsx) holds
// these entries beside its marks; the Calendar shows them under its month and week views. Hidden from screen readers:
// each day's label says “actual” or “forecast” after its figure.

/** The two entries, laid out by the key that holds them. `metric` names Home's net-sales actual. */
export function FigureKeyItems(props: { metric?: 'guests' | 'netSales' }): React.JSX.Element {
  return (
    <>
      <View style={styles.item}>
        <Text style={[styles.sample, styles.actual]}>94</Text>
        <Text style={styles.text}>{props.metric === 'netSales' ? 'Actual sales' : FIGURE_KEY.actual}</Text>
      </View>
      <View style={styles.item}>
        <Text style={[styles.sample, styles.forecast]}>{markedFigure('82', { kind: 'forecast' })}</Text>
        <Text style={styles.text}>{FIGURE_KEY.forecast}</Text>
      </View>
    </>
  );
}

/** The Calendar's key: the two figure entries alone. */
export function FigureKey(): React.JSX.Element {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="figure-key" style={styles.key}>
      <FigureKeyItems />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6 },
  item: { flexDirection: 'row', alignItems: 'baseline', columnGap: 6 },
  sample: { ...theme.type.mono, fontWeight: '500', fontVariant: ['tabular-nums'] },
  actual: { color: c.white },
  forecast: { color: c.text2 },
  text: { ...theme.type.mono, color: c.text2 },
});
