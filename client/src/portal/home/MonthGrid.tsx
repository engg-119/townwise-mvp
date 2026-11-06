import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { MonthCell } from '../analytics/week';

// This month as a grid (home.md 2.5), Monday first, one file for both platforms: each day's number, a white corner
// mark for a holiday or town event, a `text2` mark for one of your notes, and this week outlined with `line`. It is
// hidden from screen readers: the list under it carries the same facts in words. Colour never stands alone: the
// two marks sit in different corners, and the key under the grid names them.

const HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function MonthGrid(props: { rows: readonly (readonly (MonthCell | null)[])[] }): React.JSX.Element {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.grid}>
      <View style={styles.row}>
        {HEAD.map((day) => <Text key={day} style={styles.head}>{day}</Text>)}
      </View>
      {props.rows.map((row, index) => (
        <View key={index} style={styles.row}>
          {row.map((cell, col) => (cell === null ? <View key={col} style={styles.blank} /> : (
            <View key={cell.date} style={[styles.cell, cell.inWeek ? styles.week : null]}>
              <Text style={[styles.number, cell.isToday ? styles.today : null]}>{String(Number(cell.date.slice(8, 10)))}</Text>
              {cell.event ? <View style={styles.event} /> : null}
              {cell.note ? <View style={styles.note} /> : null}
            </View>
          )))}
        </View>
      ))}
      <View style={styles.key}>
        <View style={styles.keyItem}><View style={styles.swatch}><View style={styles.event} /></View><Text style={styles.keyText}>Town event or holiday</Text></View>
        <View style={styles.keyItem}><View style={styles.swatch}><View style={styles.note} /></View><Text style={styles.keyText}>Your note</Text></View>
        <View style={styles.keyItem}><View style={[styles.swatch, styles.week]} /><Text style={styles.keyText}>This week</Text></View>
      </View>
    </View>
  );
}

const c = theme.color;
const MARK = 4;

const styles = StyleSheet.create({
  grid: { gap: 3, maxWidth: 420, width: '100%' },
  row: { flexDirection: 'row', gap: 3 },
  head: { ...theme.type.mono, color: c.text3, flex: 1, textAlign: 'center' },
  blank: { flex: 1, aspectRatio: 1 },
  cell: { flex: 1, aspectRatio: 1, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised },
  week: { borderColor: c.line },
  number: { ...theme.type.mono, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, marginTop: theme.space[2] },
  keyItem: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  swatch: { width: 12, height: 12, backgroundColor: c.raised, position: 'relative', borderWidth: 1, borderColor: c.raised },
  keyText: { ...theme.type.mono, color: c.text2 },
});
