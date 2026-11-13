import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { useBreakpoint } from '../hooks';
import { MARK } from '../home/MonthKey';
import { captionOf, cellSizes, statusWord, type CalendarCell, type TooltipLines } from './model';

// The Calendar's month grid on native (P27, spec 16.3): a Pressable per day, Monday first. A cell shows
// its day number, "Closed" or "Booked", the figure (the published forecast's middle figure from today on, with a
// mint "+70" when notes added guests; stored guests before today; a buyout's party over "booked"), and from 1024px
// up to two chips of the day's entries, below that corner marks (white for a holiday or town event, `text2` for a
// note, a mint outline for an event from the owner's calendar). Today's week is outlined in `line`, the selected day
// in `mint`. Each cell's label says everything it shows. Web has its own file (CalendarGrid.web.tsx): one tab stop
// with the arrow keys, and a hover tooltip.

export interface CalendarGridProps {
  rows: readonly (readonly (CalendarCell | null)[])[];
  /** The selected day. */
  selected: string;
  /** `moved`: an arrow key moved the selection (web), so the page leaves the scroll where the grid is. */
  onSelect: (date: string, moved?: boolean) => void;
  /** Dimmed while the month or the forecast reads again. */
  busy: boolean;
  /** "November 2026": the grid's name. */
  label: string;
  /** Web only: the hover tooltip's lines for a day; null for none. */
  tooltip: (date: string) => TooltipLines | null;
}

const WEEKDAY_HEAD = WEEK_ORDER.map((day) => (WEEKDAY_NAMES[day] ?? '').slice(0, 3));

export function CalendarGrid(props: CalendarGridProps): React.JSX.Element {
  const { rows, selected } = props;
  const { width } = useBreakpoint();
  const size = cellSizes(width);
  return (
    <View accessibilityLabel={props.label} accessibilityState={{ busy: props.busy }} style={[styles.grid, props.busy ? styles.busy : null]}>
      <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.row}>
        {WEEKDAY_HEAD.map((day) => <Text key={day} style={styles.head}>{day}</Text>)}
      </View>
      {rows.map((row, index) => (
        <View key={index} style={styles.row}>
          {row.map((cell, col) => (cell === null ? <View key={col} style={[styles.blank, { minHeight: size.minHeight }]} /> : (
            <Pressable
              key={cell.date}
              role="button"
              accessibilityLabel={cell.label}
              accessibilityState={{ selected: cell.date === selected }}
              onPress={() => { props.onSelect(cell.date); }}
              style={[styles.cell, { minHeight: size.minHeight }, cell.inWeek ? styles.week : null, cell.date === selected ? styles.selected : null]}
            >
              <View style={styles.top}>
                <Text style={[styles.number, cell.isToday ? styles.today : null]}>{String(Number(cell.date.slice(8, 10)))}</Text>
                {statusWord(cell.status) === null ? null : <Text style={styles.status}>{statusWord(cell.status)}</Text>}
              </View>
              {cell.figure === null ? null : (
                <View style={styles.middle}>
                  <Text style={[styles.figure, { fontSize: size.figure, lineHeight: size.figure + 4 }, cell.figure.kind === 'actual' ? styles.past : null]}>
                    {String(cell.figure.value)}
                  </Text>
                  {cell.noteGuests > 0 ? <Text style={styles.added}>{`+${String(cell.noteGuests)}`}</Text> : null}
                  {captionOf(cell) === null ? null : <Text style={styles.caption}>{captionOf(cell)}</Text>}
                </View>
              )}
              {size.chips ? (
                <View style={styles.chips}>
                  {cell.chips.map((chip, at) => <Text key={at} numberOfLines={1} style={styles.chip}>{chip}</Text>)}
                  {cell.more > 0 ? <Text style={styles.caption}>{`+${String(cell.more)} more`}</Text> : null}
                </View>
              ) : (
                <>
                  {cell.marks.event ? <View style={styles.event} /> : null}
                  {cell.marks.note ? <View style={styles.note} /> : null}
                  {cell.marks.imported ? <View style={styles.imported} /> : null}
                </>
              )}
            </Pressable>
          )))}
        </View>
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  grid: { gap: 3, width: '100%' },
  busy: { opacity: 0.6 },
  row: { flexDirection: 'row', gap: 3 },
  head: { ...theme.type.mono, color: c.text3, flex: 1, textAlign: 'center' },
  blank: { flex: 1 },
  cell: { flex: 1, minWidth: 0, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised, gap: 2 },
  week: { borderColor: c.line },
  selected: { borderColor: c.mint },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', columnGap: 4 },
  number: { ...theme.type.mono, fontSize: 13, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2, textTransform: 'uppercase' },
  middle: { alignItems: 'center' },
  figure: { ...theme.type.monoValue, color: c.white, fontVariant: ['tabular-nums'] },
  past: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  caption: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3 },
  chips: { gap: 2, marginTop: 'auto' },
  chip: { ...theme.type.mono, fontSize: 11, lineHeight: 14, color: c.text2 },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
  imported: { position: 'absolute', bottom: 0, right: 0, width: MARK + 2, height: MARK + 2, borderWidth: 1, borderColor: c.mint },
});
