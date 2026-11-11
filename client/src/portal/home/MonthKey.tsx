import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

// The month grid's key (spec P11), shared by web and native: colour never stands alone, so each mark sits in its
// own corner and is named here. Hidden from screen readers: each day's label says its marks in words.

export const MARK = 4;

export function MonthKey(): React.JSX.Element {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.key}>
      <View style={styles.item}><View style={styles.swatch}><View style={styles.event} /></View><Text style={styles.text}>Town event or holiday</Text></View>
      <View style={styles.item}><View style={styles.swatch}><View style={styles.note} /></View><Text style={styles.text}>Your note</Text></View>
      <View style={styles.item}><View style={[styles.swatch, styles.week]} /><Text style={styles.text}>This week</Text></View>
      <View style={styles.item}><View style={[styles.swatch, styles.selected]} /><Text style={styles.text}>Selected day</Text></View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6 },
  item: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  swatch: { width: 12, height: 12, backgroundColor: c.raised, position: 'relative', borderWidth: 1, borderColor: c.raised },
  week: { borderColor: c.line },
  selected: { borderColor: c.mint },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
  text: { ...theme.type.mono, color: c.text2 },
});
