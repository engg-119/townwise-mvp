import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { useBreakpoint } from '../hooks';
import { MARK } from '../home/MonthKey';
import { CELL_GAP, cellSize, columnGrow, entryLines, selectedColumn, slotOf, WEEKDAY_ROW, type DayCell, type GridSlot, type MonthBounds } from './grid';
import { figureTone, markedFigure, statusTakesFigure, statusWord, topRightOf, type CalendarCell, type TooltipLines } from './model';

// The Calendar's month grid on native (P28, spec 16.3): always 42 days in 6 rows, Monday first, a Pressable per day.
// Every cell is a fixed height by width (grid.ts cellSize: 104, 64 or 52px), whatever it holds. A cell shows its day
// number, with "Booked" or, beside a forecast's figure, "forecast" at its right; then the figure (D49, design decision
// 10: an actual, the stored guests before today, solid `white`; a forecast, the published forecast's middle figure from
// today on with a mint "+70" when notes added guests, the run's figure for a past day with none stored, or a buyout's
// party, `text2` after a "~"), or on a closed or likely-closed day the status word in its place; then from 1024px up to three entry lines
// ("+N more" past them), below that corner marks (white for a holiday or town event, `text2` for a note, a mint
// outline for an event from the owner's calendar). Below 641px every status takes the figure's place and "+70" and the
// caption leave the cell. The days of the months either side are muted (no fill, a `border` outline, `text3`) and
// selected in place; a day outside the 25 months is a disabled element with its number only; a day whose reads are
// still in flight shows its number only. Today's week is outlined in `line`. The selected day (D64) has a 2px `mint`
// border over the `state` fill, and its weekday column grows to 1.3 times the others' in every row and the weekday head,
// easing over 150ms (at once under Reduce Motion), so the grid's height never moves; today keeps its own number. Each
// cell's label says everything it shows, and the selected one has its selected state. Web has its own file (CalendarGrid.web.tsx): one tab stop with the keys, and a hover
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

/**
 * Each weekday column's flex grow, the selected one's 1.3 (grid.ts columnGrow), easing to a new selection over 150ms;
 * set at once while Reduce Motion is on or not yet known.
 */
function useColumnGrow(selected: number): Animated.Value[] {
  const reduced = useReducedMotion();
  const [grow] = useState(() => Array.from({ length: 7 }, (_, column) => new Animated.Value(columnGrow(column, selected))));
  // The column the values were last sent to, so a render that keeps it (or Reduce Motion's answer) moves nothing.
  const shown = useRef(selected);
  useEffect(() => {
    if (shown.current === selected) return undefined;
    shown.current = selected;
    if (reduced !== false) {
      grow.forEach((value, column) => { value.setValue(columnGrow(column, selected)); });
      return undefined;
    }
    const easing = Easing.bezier(...theme.motion.easeInOut);
    const run = Animated.parallel(grow.map((value, column) => Animated.timing(value, {
      toValue: columnGrow(column, selected), duration: theme.motion.select, easing, useNativeDriver: false,
    })));
    run.start();
    return () => { run.stop(); };
  }, [grow, reduced, selected]);
  return grow;
}

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function Day(props: { cell: DayCell; selected: boolean; width: number; onSelect: (date: string) => void }): React.JSX.Element {
  const { cell } = props;
  const size = cellSize(props.width);
  const phone = props.width <= 640;
  const muted = cell.outside;
  const status = statusWord(cell.status);
  const statusInFigure = status !== null && statusTakesFigure(cell.status, phone);
  const topRight = phone || cell.pending ? null : topRightOf(cell);
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
              <Text style={[styles.figure, { fontSize: size.figure, lineHeight: size.figure + 4 }, figureTone(cell.figure) === 'text2' ? styles.forecast : null, muted ? styles.muted : null]}>
                {markedFigure(String(cell.figure.value), cell.figure)}
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
  const grow = useColumnGrow(selectedColumn(selected));
  const column = (at: number, child: React.ReactNode, key: string): React.JSX.Element => (
    <Animated.View key={key} testID={`calendar-column-${key}`} style={[styles.column, { flexGrow: grow[at] ?? 1 }]}>{child}</Animated.View>
  );
  return (
    <View accessibilityLabel={props.label} accessibilityState={{ busy: props.busy }} style={[styles.grid, props.busy ? styles.busy : null]}>
      <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.row}>
        {WEEKDAY_HEAD.map((day, at) => column(at, <Text style={styles.head}>{day}</Text>, day))}
      </View>
      {rows.map((row, index) => (
        <View key={index} style={styles.row}>
          {row.map((each, col) => {
            if (each === null) return column(col, <View style={{ height: size.height }} />, `blank-${String(index)}-${String(col)}`);
            const slot = slotOf(each);
            if (slot.kind === 'inert') {
              return column(col, (
                <Pressable
                  role="button"
                  disabled
                  accessibilityLabel={slot.label}
                  accessibilityState={{ disabled: true }}
                  style={[styles.cell, styles.outside, { height: size.height }]}
                >
                  <Text style={[styles.number, styles.muted]}>{dayNumber(slot.date)}</Text>
                </Pressable>
              ), slot.date);
            }
            return column(col, <Day cell={slot} selected={slot.date === selected} width={width} onSelect={props.onSelect} />, slot.date);
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
  // A weekday's column in every row: its share of the row grows for the selected day's weekday.
  column: { flexBasis: 0, flexShrink: 1, minWidth: 0 },
  head: { ...theme.type.mono, lineHeight: WEEKDAY_ROW, color: c.text3, textAlign: 'center' },
  cell: {
    minWidth: 0, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised, gap: 2, overflow: 'hidden',
  },
  outside: { backgroundColor: 'transparent', borderColor: c.border },
  week: { borderColor: c.line },
  // 2px, its padding 1px less, so nothing inside moves.
  selected: { borderColor: c.mint, borderWidth: 2, padding: 3, backgroundColor: c.state },
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
  forecast: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  caption: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3 },
  entries: { gap: 2, height: 46 },
  entry: { ...theme.type.mono, fontSize: 11, lineHeight: 14, color: c.text2 },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
  imported: { position: 'absolute', bottom: 0, right: 0, width: MARK + 2, height: MARK + 2, borderWidth: 1, borderColor: c.mint },
});
