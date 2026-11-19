import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../../theme';
import { WIDE_CELL_HEIGHT, WIDE_ROWS } from '../../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../../analytics/words';
import { cellLines, TITLE_MIN_SHARE, type EventDay, type MonthEntry } from './eventDays';
import { EventMonthKey } from './EventMonthKey';

// A calendar's events as a month grid on its page in Your data (D62), in the visual language of Home's month grid
// (home/MonthGrid.tsx, wide cells): Monday first, each day a `raised` cell 96px tall with its number (today filled as
// Home fills it) and its events' lines, a start time, a booking label's tag on a file calendar and the title cut to one
// line (keeping TITLE_MIN_SHARE of it), “+n more” past the cell's budget (eventDays.ts). The selected day is outlined
// in `mint`. Each day is a button whose label says the date and every event in full; a tap selects it, and the page
// lists that day's events under the grid. Web has its own file (EventMonth.web.tsx): one tab stop with arrow keys, and
// a tooltip on hover.

export interface EventMonthProps {
  rows: readonly (readonly (EventDay | null)[])[];
  selected: string;
  onSelect: (date: string) => void;
  /** “Master calendar, November 2026”: the grid's name. */
  label: string;
  /** The month is still being read: the grid dims. */
  busy?: boolean;
}

const WEEKDAY_HEAD = WEEK_ORDER.map((day) => (WEEKDAY_NAMES[day] ?? '').slice(0, 3));

function Line(props: { entry: MonthEntry }): React.JSX.Element {
  const { entry } = props;
  return (
    <View style={styles.line}>
      {entry.time === null ? null : <Text numberOfLines={1} style={styles.time}>{entry.time}</Text>}
      {entry.tag === null ? null : <Text numberOfLines={1} style={styles.tag}>{entry.tag}</Text>}
      <Text numberOfLines={1} style={[styles.entry, styles.title]}>{entry.title}</Text>
    </View>
  );
}

export function EventMonth(props: EventMonthProps): React.JSX.Element {
  const { rows, selected } = props;
  return (
    <View style={[styles.root, props.busy === true ? styles.busy : null]}>
      <View accessibilityLabel={props.label} style={styles.grid}>
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.row}>
          {WEEKDAY_HEAD.map((day) => <Text key={day} style={styles.head}>{day}</Text>)}
        </View>
        {rows.map((row, index) => (
          <View key={index} style={styles.row}>
            {row.map((day, col) => {
              if (day === null) return <View key={col} style={styles.blank} />;
              const { lines, more } = cellLines(day.entries);
              return (
                <Pressable
                  key={day.date}
                  role="button"
                  accessibilityLabel={day.label}
                  accessibilityState={{ selected: day.date === selected }}
                  onPress={() => { props.onSelect(day.date); }}
                  style={[styles.cell, day.date === selected ? styles.selected : null]}
                >
                  <View style={styles.top}>
                    <Text style={[styles.number, day.isToday ? styles.today : null]}>{String(Number(day.date.slice(8, 10)))}</Text>
                  </View>
                  <View style={styles.entries}>
                    {lines.map((entry) => <Line key={entry.key} entry={entry} />)}
                    {more === null ? null : <Text numberOfLines={1} style={[styles.entry, styles.more]}>{more}</Text>}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      <EventMonthKey />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[3], width: '100%' },
  busy: { opacity: 0.6 },
  grid: { gap: 3 },
  row: { flexDirection: 'row', gap: 3 },
  head: { ...theme.type.mono, color: c.text3, flex: 1, textAlign: 'center' },
  blank: { flex: 1, height: WIDE_CELL_HEIGHT },
  cell: {
    flex: 1, minWidth: 0, height: WIDE_CELL_HEIGHT, overflow: 'hidden', backgroundColor: c.raised, padding: 4,
    borderWidth: 1, borderColor: c.raised, gap: WIDE_ROWS.gap,
  },
  selected: { borderColor: c.mint },
  top: { flexDirection: 'row', alignItems: 'center', height: WIDE_ROWS.top },
  number: { ...theme.type.mono, fontSize: 13, color: c.text2, fontVariant: ['tabular-nums'] },
  // Filled in the primary button's colors so today reads apart from the selected day's mint outline (as on Home).
  today: { color: c.onCta, backgroundColor: c.cta, fontWeight: '600', paddingHorizontal: 5, borderRadius: 2, overflow: 'hidden', alignSelf: 'flex-start' },
  entries: { gap: WIDE_ROWS.entryGap, minWidth: 0 },
  line: { flexDirection: 'row', alignItems: 'baseline', columnGap: 4, height: WIDE_ROWS.entry, minWidth: 0, overflow: 'hidden' },
  entry: { ...theme.type.small, fontSize: 11, lineHeight: WIDE_ROWS.entry, color: c.text2 },
  title: { flexGrow: 1, flexShrink: 0, flexBasis: TITLE_MIN_SHARE },
  time: { ...theme.type.mono, fontSize: 10, color: c.text3, flexShrink: 0 },
  tag: { ...theme.type.mono, fontSize: 10, color: c.white, textTransform: 'uppercase', flexShrink: 1, minWidth: 0 },
  more: { color: c.text3 },
});
