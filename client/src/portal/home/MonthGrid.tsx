import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { narrowCaption, WIDE_CELL_HEIGHT, WIDE_ROWS, wideCell, type MonthCell } from '../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { figureTone, statusWord, type TooltipLines } from '../calendar/model';
import { useBreakpoint } from '../hooks';
import { MARK, MonthKey } from './MonthKey';

// This month as a grid (spec P11), Monday first: each day's number, its figure (stored before today, solid `white`; a
// forecast, lighter after a "~" with "forecast" under it, D49 decision 10: the published forecast's middle figure from
// today on with a mint "+70" when notes added guests, the run's figure for a past day with none stored, a buyout's party), "Closed",
// "Likely closed" (a past day with near-empty guests, spec D32) or "Booked" (in at most two lines, the type shrinking to
// fit a narrow cell), the Calendar's caption under a figure ("forecast" on a past day with only the run's figure, D49;
// none for a forecast on a phone, where the "~" marks it, UI review S4), else a white corner mark for a holiday or town
// event, a `text2` mark for one of your notes or rules, a mint outline for an event of your calendars. A cell at least
// 88px wide (`wide`, 96px tall) lays out as the Calendar's does, in rows of fixed height (analytics/week.ts WIDE_ROWS,
// UI review B1): the day with the status or caption, the figure with its "+40" or the status in its place, then the
// entry lines its budget holds. This week is outlined
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
  /** Cells are at least 88px wide (the grid's measured width): each shows up to two entry lines, 96px tall. */
  wide?: boolean;
  /** Under the key: "Open the calendar" (D49). */
  footer?: React.ReactNode;
  /** Home's metric, which names the key's actual (“Actual sales” in net sales). */
  metric?: 'guests' | 'netSales';
}

const WEEKDAY_HEAD = WEEK_ORDER.map((day) => (WEEKDAY_NAMES[day] ?? '').slice(0, 3));

export function MonthGrid(props: MonthGridProps): React.JSX.Element {
  const { rows, selected } = props;
  const wide = props.wide === true;
  const { phone } = useBreakpoint();
  // 13px on a phone: “~104” at 15px is wider than a 42px cell (UI review S4).
  const figureSize = phone ? 13 : 18;
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
                style={[styles.cell, wide ? styles.wide : null, cell.inWeek ? styles.week : null, cell.date === selected ? styles.selected : null]}
              >
                {wide ? <WideDay cell={cell} figureSize={figureSize} /> : (
                  <>
                    <Text style={[styles.number, cell.isToday ? styles.today : null]}>{String(Number(cell.date.slice(8, 10)))}</Text>
                    {cell.status === null ? null : (
                      // A narrow cell holds about 30px of text, less than “LIKELY” at 10px: the type shrinks so no word breaks.
                      <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7} style={styles.status}>{statusWord(cell.status)}</Text>
                    )}
                    {cell.figure === null ? null : (
                      <View style={styles.middle}>
                        <Figure cell={cell} size={figureSize} />
                        {cell.noteGuests > 0 ? <Text style={styles.added}>{`+${String(cell.noteGuests)}`}</Text> : null}
                        {narrowCaption(cell, phone) === null ? null : <Text style={styles.caption}>{narrowCaption(cell, phone)}</Text>}
                      </View>
                    )}
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
      <MonthKey {...(props.metric === undefined ? {} : { metric: props.metric })} />
      {props.footer}
    </View>
  );
}

function Figure(props: { cell: MonthCell; size: number }): React.JSX.Element | null {
  const { cell, size } = props;
  if (cell.figure === null) return null;
  return (
    <Text style={[styles.figure, { fontSize: size, lineHeight: size + 4 }, figureTone(cell.figure) === 'text2' ? styles.forecast : null]}>
      {cell.figureText}
    </Text>
  );
}

/** A wide cell's rows (analytics/week.ts wideCell), each at its fixed height; entry lines cut to one line each, the cell's label saying them all. */
function WideDay(props: { cell: MonthCell; figureSize: number }): React.JSX.Element {
  const { cell } = props;
  const parts = wideCell(cell);
  return (
    <>
      <View style={styles.top}>
        <Text style={[styles.number, cell.isToday ? styles.today : null]}>{String(Number(cell.date.slice(8, 10)))}</Text>
        {parts.topRight === null ? null : <Text numberOfLines={1} style={styles.topRight}>{parts.topRight}</Text>}
      </View>
      <View style={styles.figureRow}>
        {parts.middle === 'status' ? (
          <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.status, styles.wideStatus]}>{statusWord(cell.status)}</Text>
        ) : parts.middle === 'figure' ? (
          <>
            <Figure cell={cell} size={props.figureSize} />
            {cell.noteGuests > 0 ? <Text style={styles.added}>{`+${String(cell.noteGuests)}`}</Text> : null}
          </>
        ) : null}
      </View>
      <View style={styles.entries}>
        {parts.lines.map((entry, at) => <Text key={at} numberOfLines={1} style={styles.entry}>{entry}</Text>)}
        {parts.more === null ? null : <Text numberOfLines={1} style={[styles.entry, styles.more]}>{parts.more}</Text>}
      </View>
    </>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[3], width: '100%' },
  grid: { gap: 3 },
  row: { flexDirection: 'row', gap: 3 },
  head: { ...theme.type.mono, color: c.text3, flex: 1, textAlign: 'center' },
  blank: { flex: 1, minHeight: 52 },
  cell: { flex: 1, minWidth: 0, minHeight: 52, backgroundColor: c.raised, padding: 4, position: 'relative', borderWidth: 1, borderColor: c.raised, gap: WIDE_ROWS.gap },
  wide: { height: WIDE_CELL_HEIGHT, overflow: 'hidden' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', columnGap: 4, height: WIDE_ROWS.top, minWidth: 0 },
  topRight: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2, textTransform: 'uppercase', flexShrink: 1 },
  figureRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', columnGap: 4, height: WIDE_ROWS.figure, minWidth: 0 },
  wideStatus: { lineHeight: 12, textAlign: 'center' },
  entries: { gap: WIDE_ROWS.entryGap, minWidth: 0 },
  entry: { ...theme.type.small, fontSize: 11, lineHeight: WIDE_ROWS.entry, color: c.text2 },
  more: { color: c.text3 },
  caption: { ...theme.type.mono, fontSize: 10, lineHeight: 12, color: c.text3 },
  week: { borderColor: c.line },
  selected: { borderColor: c.mint },
  number: { ...theme.type.mono, fontSize: 13, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2, textTransform: 'uppercase' },
  middle: { alignItems: 'center' },
  figure: { ...theme.type.monoValue, color: c.white, fontVariant: ['tabular-nums'] },
  forecast: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  event: { position: 'absolute', top: 0, right: 0, width: MARK, height: MARK, backgroundColor: c.white },
  note: { position: 'absolute', bottom: 0, left: 0, width: MARK, height: MARK, backgroundColor: c.text2 },
  imported: { position: 'absolute', bottom: 0, right: 0, width: MARK + 2, height: MARK + 2, borderWidth: 1, borderColor: c.mint },
});
