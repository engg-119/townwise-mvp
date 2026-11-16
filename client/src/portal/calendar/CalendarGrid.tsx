import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { useBreakpoint } from '../hooks';
import { MARK } from '../home/MonthKey';
import { CELL_GAP, cellSize, entryLines, slotOf, WEEKDAY_ROW, type DayCell, type GridSlot, type MonthBounds } from './grid';
import { captionOf, statusWord, type CalendarCell, type TooltipLines } from './model';

// The Calendar's month grid on native (P28, spec 16.3): always 42 days in 6 rows, Monday first, a Pressable per day.
// Every cell is a fixed height by width (grid.ts cellSize: 104, 64 or 52px), whatever it holds. A cell shows its day
// number, with "Booked" or, under a past figure, "guests" at its right; then the figure (the published forecast's
// middle figure from today on, with a mint "+70" when notes added guests; stored guests before today; a buyout's
// party), or on a closed or likely-closed day the status word in its place; then from 1024px up to three entry lines
// ("+N more" past them), below that corner marks (white for a holiday or town event, `text2` for a note, a mint
// outline for an event from the owner's calendar). Below 641px every status takes the figure's place and "+70" and the
// caption leave the cell. The days of the months either side are muted (no fill, a `border` outline, `text3`) and
// selected in place; a day outside the 25 months is a disabled element with its number only; a day whose reads are
// still in flight shows its number only. Today's week is outlined in `line`, the selected day in `mint`. Each cell's
// label says everything it shows. Web has its own file (CalendarGrid.web.tsx): one tab stop with the keys, and a hover
// tooltip.

export interface CalendarGridProps {
  /** The grid's weeks (grid.ts buildGrid); a plain CalendarCell is an in-month day, null an empty cell. */
  rows: readonly (readonly (CalendarCell | GridSlot | null)[])[];
  /** The selected day. */
  selected: string;
  /** The grid's month ('YYYY-MM'), which Ctrl+Home, Ctrl+End, PageUp and PageDown step from (web). */
  month: string;
  /** The 25 months the page shows: a key past them is consumed (web). */
  bounds: MonthBounds;
  /**
   * `moved`: a key moved the selection (web), so the page leaves the scroll where the grid is. `month`: the month the
   * grid then shows, after PageUp or PageDown (also when the day stays the same); null otherwise.
   */
  onSelect: (date: string, moved?: boolean, month?: string | null) => void;
  /** Dimmed while the month or the forecast reads again. */
  busy: boolean;
  /** "November 2026": the grid's name. */
  label: string;
  /** Web only: the hover tooltip's lines for a day; null for none. */
  tooltip: (date: string) => TooltipLines | null;
}

const WEEKDAY_HEAD = WEEK_ORDER.map((day) => (WEEKDAY_NAMES[day] ?? '').slice(0, 3));

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function Day(props: { cell: DayCell; selected: boolean; width: number; onSelect: (date: string) => void }): React.JSX.Element {
  const { cell } = props;
  const size = cellSize(props.width);
  const phone = props.width <= 640;
  const muted = cell.outside;
  const status = statusWord(cell.status);
  const statusInFigure = status !== null && (phone || cell.status !== 'booked');
  const topRight = phone || cell.pending ? null : cell.status === 'booked' ? status : captionOf(cell);
  const entries = entryLines(cell);
  return (
    <Pressable
      role="button"
      accessibilityLabel={cell.label}
      accessibilityState={{ selected: props.selected }}
      onPress={() => { props.onSelect(cell.date); }}
      style={[
        styles.cell, { height: size.height }, muted ? styles.outside : null, cell.inWeek ? styles.week : null, props.selected ? styles.selected : null,
      ]}
    >
      <View style={styles.top}>
        <Text style={[styles.number, muted ? styles.muted : null, cell.isToday ? styles.today : null]}>{dayNumber(cell.date)}</Text>
        {topRight === null ? null : <Text style={[styles.status, muted ? styles.muted : null]}>{topRight}</Text>}
      </View>
      {cell.pending ? null : (
        <View style={[styles.middle, size.lines > 0 ? styles.middleWide : null]}>
          {statusInFigure ? (
            <Text style={[styles.status, styles.centered, phone ? styles.statusPhone : null, muted ? styles.muted : null]}>{status.split(' ').join('\n')}</Text>
          ) : cell.figure === null ? null : (
            <>
              <Text style={[styles.figure, { fontSize: size.figure, lineHeight: size.figure + 4 }, cell.figure.kind === 'actual' ? styles.past : null, muted ? styles.muted : null]}>
                {String(cell.figure.value)}
              </Text>
              {cell.noteGuests > 0 && !phone ? <Text style={styles.added}>{`+${String(cell.noteGuests)}`}</Text> : null}
            </>
          )}
        </View>
      )}
      {cell.pending ? null : size.lines > 0 ? (
        <View style={styles.entries}>
          {entries.lines.map((entry, at) => <Text key={at} numberOfLines={1} style={[styles.entry, muted ? styles.muted : null]}>{entry}</Text>)}
          {entries.more === null ? null : <Text numberOfLines={1} style={styles.caption}>{entries.more}</Text>}
        </View>
      ) : (
        <>
          {cell.marks.event ? <View style={styles.event} /> : null}
          {cell.marks.note ? <View style={styles.note} /> : null}
          {cell.marks.imported ? <View style={styles.imported} /> : null}
        </>
      )}
    </Pressable>
  );
}

export function CalendarGrid(props: CalendarGridProps): React.JSX.Element {
  const { rows, selected } = props;
  const { width } = useBreakpoint();
  const size = cellSize(width);
  return (
    <View accessibilityLabel={props.label} accessibilityState={{ busy: props.busy }} style={[styles.grid, props.busy ? styles.busy : null]}>
      <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.row}>
        {WEEKDAY_HEAD.map((day) => <Text key={day} style={styles.head}>{day}</Text>)}
      </View>
      {rows.map((row, index) => (
        <View key={index} style={styles.row}>
          {row.map((each, col) => {
            if (each === null) return <View key={col} style={[styles.blank, { height: size.height }]} />;
            const slot = slotOf(each);
            if (slot.kind === 'inert') {
              return (
                <Pressable
                  key={slot.date}
                  role="button"
                  disabled
                  accessibilityLabel={slot.label}
                  accessibilityState={{ disabled: true }}
                  style={[styles.cell, styles.outside, { height: size.height }]}
                >
                  <Text style={[styles.number, styles.muted]}>{dayNumber(slot.date)}</Text>
                </Pressable>
              );
            }
            return <Day key={slot.date} cell={slot} selected={slot.date === selected} width={width} onSelect={props.onSelect} />;
          })}
        </View>
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  grid: { gap: CELL_GAP, width: '100%' },
  busy: { opacity: 0.6 },
  row: { flexDirection: 'row', gap: CELL_GAP },
  head: { ...theme.type.mono, lineHeight: WEEKDAY_ROW, color: c.text3, flex: 1, textAlign: 'center' },
  blank: { flex: 1 },
  cell: {
    flex: 1, minWidth: 0, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised, gap: 2, overflow: 'hidden',
  },
  outside: { backgroundColor: 'transparent', borderColor: c.border },
  week: { borderColor: c.line },
  selected: { borderColor: c.mint },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', columnGap: 4, height: 16 },
  number: { ...theme.type.mono, fontSize: 13, color: c.text2, fontVariant: ['tabular-nums'] },
  muted: { color: c.text3 },
  today: { color: c.white, fontWeight: '600' },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 12, color: c.text2, textTransform: 'uppercase' },
  statusPhone: { fontSize: 9, lineHeight: 11 },
  centered: { textAlign: 'center' },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', columnGap: 4 },
  middleWide: { height: 26 },
  figure: { ...theme.type.monoValue, color: c.white, fontVariant: ['tabular-nums'] },
  past: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  caption: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3 },
  entries: { gap: 2, height: 46 },
  entry: { ...theme.type.mono, fontSize: 11, lineHeight: 14, color: c.text2 },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
  imported: { position: 'absolute', bottom: 0, right: 0, width: MARK + 2, height: MARK + 2, borderWidth: 1, borderColor: c.mint },
});
