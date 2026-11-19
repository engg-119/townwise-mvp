import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../../theme';

// The event month grid's key (D62), web and native: today's number and the selected day's outline, as Home's month
// key names them (home/MonthKey.tsx). Hidden from screen readers: each day's label says “Today” and the selection is
// the cell's selected state.

export function EventMonthKey(): React.JSX.Element {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="event-month-key" style={styles.key}>
      <View style={styles.item}><View style={[styles.swatch, styles.today]} /><Text style={styles.text}>Today</Text></View>
      <View style={styles.item}><View style={[styles.swatch, styles.selected]} /><Text style={styles.text}>Selected day</Text></View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6 },
  item: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  swatch: { width: 12, height: 12, backgroundColor: c.raised, borderWidth: 1, borderColor: c.raised },
  today: { backgroundColor: c.cta, borderColor: c.cta },
  selected: { borderColor: c.mint },
  text: { ...theme.type.mono, color: c.text2 },
});
