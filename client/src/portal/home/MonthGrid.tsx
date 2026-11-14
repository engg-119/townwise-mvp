import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { monthStatusWord, type MonthCell } from '../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import type { TooltipLines } from '../calendar/model';
import { useBreakpoint } from '../hooks';
import { MARK, MonthKey } from './MonthKey';

// This month as a grid (spec P11), Monday first: each day's number, its figure (stored before today, the published
// forecast's middle figure from today on with a mint "+70" when notes added guests, a buyout's party), "Closed",
// "Likely closed" (a past day with near-empty guests, spec D32) or "Booked" (in at most two lines, the type shrinking to
// fit a narrow cell), a white corner mark for a holiday or town event, a `text2` mark for one of your notes, this week outlined
// with `line`, and the selected day outlined in `mint`. Each day is a button that opens it in the Calendar (spec
// 16.3 P11); its label says everything the cell shows. Web has its own file (MonthGrid.web.tsx): one tab
// stop with arrow keys that select a day for the detail, a pointer that previews a day and shows its tooltip, and a
// click or Enter that opens it.

export interface MonthGridProps {
  rows: readonly (readonly (MonthCell | null)[])[];
  /** The day whose detail shows. */
  selected: string;
  onSelect: (date: string) => void;
  /** Web only: a pointer over a day previews it, and leaving the grid restores the selection (null). */
  onPreview: (date: string | null) => void;
  /** Opens the day in the Calendar: a tap, a click or Enter. */
  onOpen: (date: string) => void;
  /** Web only: the hover tooltip's lines for a day; null for none. */
  tooltip: (date: string) => TooltipLines | null;
  /** "November 2026": the grid's name. */
  label: string;
}

const WEEKDAY_HEAD = WEEK_ORDER.map((day) => (WEEKDAY_NAMES[day] ?? '').slice(0, 3));

export function MonthGrid(props: MonthGridProps): React.JSX.Element {
  const { rows, selected } = props;
  const { phone } = useBreakpoint();
  const figureSize = phone ? 15 : 18;
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
                onPress={() => { props.onOpen(cell.date); }}
                style={[styles.cell, cell.inWeek ? styles.week : null, cell.date === selected ? styles.selected : null]}
              >
                <Text style={[styles.number, cell.isToday ? styles.today : null]}>{String(Number(cell.date.slice(8, 10)))}</Text>
                {cell.status === null ? null : (
                  // A narrow cell holds about 30px of text, less than “LIKELY” at 10px: the type shrinks so no word breaks.
                  <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7} style={styles.status}>{monthStatusWord(cell)}</Text>
                )}
                {cell.figure === null ? null : (
                  <View style={styles.middle}>
                    <Text style={[styles.figure, { fontSize: figureSize, lineHeight: figureSize + 4 }, cell.figure.kind === 'actual' ? styles.past : null]}>
                      {cell.figure.text}
                    </Text>
                    {cell.noteGuests > 0 ? <Text style={styles.added}>{`+${String(cell.noteGuests)}`}</Text> : null}
                  </View>
                )}
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
  blank: { flex: 1, minHeight: 52 },
  cell: { flex: 1, minWidth: 0, minHeight: 52, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised, gap: 2 },
  week: { borderColor: c.line },
  selected: { borderColor: c.mint },
  number: { ...theme.type.mono, fontSize: 13, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2, textTransform: 'uppercase' },
  middle: { alignItems: 'center' },
  figure: { ...theme.type.monoValue, color: c.white, fontVariant: ['tabular-nums'] },
  past: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
});
