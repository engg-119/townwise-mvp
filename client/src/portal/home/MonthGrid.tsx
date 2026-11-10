import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { MonthCell } from '../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { MARK, MonthKey } from './MonthKey';

// This month as a grid (spec P11), Monday first: each day's number, a white corner mark for a holiday or town event,
// a `text2` mark for one of your notes, this week outlined with `line`, and the selected day outlined in `mint`.
// Each day is a button that selects it, so its detail shows under the grid; its label says everything the cell
// shows. Web has its own file (MonthGrid.web.tsx): one tab stop with arrow keys, and a pointer previews a day.

export interface MonthGridProps {
  rows: readonly (readonly (MonthCell | null)[])[];
  /** The day whose detail shows. */
  selected: string;
  onSelect: (date: string) => void;
  /** Web only: a pointer over a day previews it, and leaving the grid restores the selection (null). */
  onPreview: (date: string | null) => void;
  /** "November 2026": the grid's name. */
  label: string;
}

const WEEKDAY_HEAD = WEEK_ORDER.map((day) => (WEEKDAY_NAMES[day] ?? '').slice(0, 3));

export function MonthGrid(props: MonthGridProps): React.JSX.Element {
  const { rows, selected } = props;
  return (
    <View style={styles.root}>
      <View accessibilityLabel={props.label} style={styles.grid}>
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.row}>
          {WEEKDAY_HEAD.map((day) => <Text key={day} style={styles.head}>{day}</Text>)}
        </View>
        {rows.map((row, index) => (
          <View key={index} style={styles.row}>
            {row.map((cell, col) => (cell === null ? <View key={col} style={styles.blank} /> : (
              <Pressable
                key={cell.date}
                role="button"
                accessibilityLabel={cell.label}
                accessibilityState={{ selected: cell.date === selected }}
                onPress={() => { props.onSelect(cell.date); }}
                style={[styles.cell, cell.inWeek ? styles.week : null, cell.date === selected ? styles.selected : null]}
              >
                <Text style={[styles.number, cell.isToday ? styles.today : null]}>{String(Number(cell.date.slice(8, 10)))}</Text>
                {cell.event ? <View style={styles.event} /> : null}
                {cell.note ? <View style={styles.note} /> : null}
              </Pressable>
            )))}
          </View>
        ))}
      </View>
      <MonthKey />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[3], width: '100%' },
  grid: { gap: 3 },
  row: { flexDirection: 'row', gap: 3 },
  head: { ...theme.type.mono, color: c.text3, flex: 1, textAlign: 'center' },
  blank: { flex: 1, minHeight: 44 },
  cell: { flex: 1, minHeight: 44, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised },
  week: { borderColor: c.line },
  selected: { borderColor: c.mint },
  number: { ...theme.type.mono, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
});
