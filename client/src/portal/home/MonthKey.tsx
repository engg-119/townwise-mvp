import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { FigureKeyItems } from '../calendar/FigureKey';

// The month grid's key (spec P11), shared by web and native: an actual's figure and a forecast's (D49, design
// decision 10, calendar/FigureKey.tsx), then the marks. Color never stands alone, so each mark sits in its own corner
// and is named here. Hidden from screen readers: each day's label says its figure's kind and its marks in words.

export const MARK = 4;

export function MonthKey(props: { metric?: 'guests' | 'netSales' }): React.JSX.Element {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="month-key" style={styles.key}>
      <FigureKeyItems {...(props.metric === undefined ? {} : { metric: props.metric })} />
      <View style={styles.item}><View style={styles.swatch}><View style={styles.event} /></View><Text style={styles.text}>Town event or holiday</Text></View>
      <View style={styles.item}><View style={styles.swatch}><View style={styles.note} /></View><Text style={styles.text}>Your note or rule</Text></View>
      <View style={styles.item}><View style={styles.swatch}><View style={styles.imported} /></View><Text style={styles.text}>Your calendar</Text></View>
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
  imported: { position: 'absolute', bottom: 0, right: 0, width: MARK + 2, height: MARK + 2, borderWidth: 1, borderColor: c.mint },
  text: { ...theme.type.mono, color: c.text2 },
});
