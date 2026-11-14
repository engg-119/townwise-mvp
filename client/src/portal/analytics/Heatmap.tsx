import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { plural } from '../format';
import { formatMonth, localToday } from '../locations/dates';
import { valueOf } from '../locations/sales';
import { cellLabel, heatmapMonths } from './cells';
import { dayFlags, eventsOf, notesOf, type DayContext } from './days';
import type { Included, Marks } from './filters';
import type { DayRecord } from './history';
import { metricNumber, metricText, shortDate, type Metric } from './words';

// The heatmap's props (home.md 4.4, build plan 8.3), shared with Heatmap.web.tsx, which draws the grid. Home
// mounts it with `interactive={false}` and onboarding's Reading screen (onboarding/HistoryStep) with `pending` too.
//
// Native has no grid (D21): a month list, newest first, each month a 44px row with its days and average; pressing
// a month opens its days as 44px rows (date, value, marks in words), and pressing a day selects it and shows
// `panel` under that row. `interactive={false}` renders nothing on native (Home's mini heatmap is web only).

export interface HeatmapProps {
  /** Decoded history, oldest first. */
  days: readonly DayRecord[];
  metric: Metric;
  marks: Marks;
  context: DayContext;
  /** From the filters; a value it refuses is drawn as "Left out". */
  included: Included;
  years: readonly number[];
  /** False on Home and Reading: a picture with `label` as its name. */
  interactive: boolean;
  selected?: string | null;
  onSelect?: (date: string | null) => void;
  /** Web: the day under the pointer, or null when it leaves the grid. */
  onPreview?: (date: string | null) => void;
  /** Reading: days in this range with no row render as "Not read yet". */
  pending?: { from: string; to: string };
  /** The text summary: printed under an interactive grid, the picture's name otherwise. */
  label: string;
  /** The viewer's day; later days are blank. Defaults to the device's today. */
  today?: string;
  /** Web: when this changes, the selected day's cell takes focus (the Day panel's Previous day and Next day). */
  focusKey?: number;
  /** Native: the Day panel, shown under the selected day's row. */
  panel?: React.ReactNode;
}

function dayWords(date: string, day: DayRecord | undefined, props: HeatmapProps): string {
  const value = day === undefined ? null : valueOf(day, props.metric);
  const events = eventsOf(props.context, date);
  const flags = dayFlags(date, day, props.context);
  const marks = [
    props.marks.holidays && events.some((event) => event.kind === 'holiday') ? 'Holiday' : null,
    props.marks.townEvents && events.some((event) => event.kind === 'event') ? 'Town event' : null,
    props.marks.notes && notesOf(props.context, date).length > 0 ? 'Your note' : null,
    // A near-empty day (spec D32) is closed for the filters but named for what it is, as cells.ts names it on web.
    props.marks.closures && flags.closed ? (flags.likelyClosed ? 'Likely closed' : 'Closed') : null,
    value !== null && !props.included(date) ? 'Left out' : null,
  ].filter((part): part is string => part !== null);
  return [value === null ? 'No data' : metricNumber(value, props.metric), ...marks].join(', ');
}

/** "Sat, Nov 21". */
function dayName(date: string): string {
  return shortDate(date).replace(/, \d{4}$/, '');
}

export function Heatmap(props: HeatmapProps): React.JSX.Element | null {
  const [deviceToday] = useState(localToday);
  const today = props.today ?? deviceToday;
  const { days, metric, years, selected = null } = props;
  const months = useMemo(() => heatmapMonths({ days, metric, years }), [days, metric, years]);
  const byDate = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const [open, setOpen] = useState<string | null>(null);
  // The Day panel's Previous day and Next day can move the selection into another month: open that one.
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    if (selected !== null) setOpen(selected.slice(0, 7));
  }
  if (!props.interactive) return null;
  return (
    <View role="list" aria-label={`Months, ${metric === 'guests' ? 'daily guests' : 'daily net sales'}`} style={styles.list}>
      {months.map((row) => {
        const expanded = open === row.month;
        const average = `${metricText(row.mean, metric)} on average`;
        const head = `${formatMonth(row.month)}, ${plural(row.days, 'day', 'days')} with data, ${average}`;
        const dates: string[] = [];
        if (expanded) {
          const [y, m] = row.month.split('-').map(Number);
          const last = new Date(Date.UTC(y ?? 0, m ?? 1, 0)).getUTCDate();
          for (let d = last; d >= 1; d -= 1) {
            const date = `${row.month}-${String(d).padStart(2, '0')}`;
            if (date <= today) dates.push(date);
          }
        }
        return (
          <View key={row.month} role="listitem">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={head}
              accessibilityState={{ expanded }}
              onPress={() => { setOpen(expanded ? null : row.month); }}
              style={[styles.row, expanded ? styles.rowOpen : null]}
            >
              <Text style={styles.month}>{formatMonth(row.month)}</Text>
              <Text style={styles.value}>{`${plural(row.days, 'day', 'days')}, ${average}`}</Text>
            </Pressable>
            {expanded ? (
              <View aria-label={`Days in ${formatMonth(row.month)}`}>
                {dates.map((date) => {
                  const day = byDate.get(date);
                  const on = date === selected;
                  const label = cellLabel(date, day, props, false);
                  return (
                    <View key={date}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityState={{ selected: on }}
                        onPress={() => { props.onSelect?.(date); }}
                        style={[styles.day, on ? styles.dayOn : null]}
                      >
                        <Text style={styles.dayName}>{dayName(date)}</Text>
                        <Text style={styles.value}>{dayWords(date, day, props)}</Text>
                      </Pressable>
                      {on ? props.panel : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { borderTopWidth: 1, borderTopColor: c.border },
  row: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12, minHeight: 44,
    paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  rowOpen: { backgroundColor: c.raised },
  month: { ...theme.type.ui, color: c.white },
  value: { ...theme.type.mono, color: c.text2, fontVariant: ['tabular-nums'] },
  day: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12, minHeight: 44,
    paddingLeft: 20, paddingRight: 8, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  dayOn: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.border },
  dayName: { ...theme.type.mono, color: c.white, fontVariant: ['tabular-nums'] },
});
