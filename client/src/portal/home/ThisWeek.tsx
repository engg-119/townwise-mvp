import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { Calendar } from '../analytics/api';
import {
  calendarCoverageLine, calendarWeekLine, dayMonth, EVENT_WORDS, forecastPhrase, LAST_YEAR_FOOTNOTE, pastDayPhrase, periodLine, thisDayPhrase,
  vsUsualDayPhrase,
  type PastDay, type ThisWeek as Week, type WeekRow,
} from '../analytics/week';
import { metricNumber, shortDate, WEEKDAY_NAMES, weekdayOf, type Metric } from '../analytics/words';
import type { DayEntry } from '../calendar/entries';
import type { ForecastDay, ForecastWindow } from '../estimates/api';
import { useBreakpoint } from '../hooks';
import { ShowNumbers } from '../locations/parts';
import { DataTable, type Column } from '../ui/DataTable';
import { SourceChips } from '../ui/SourceChip';
import { Stack } from '../ui/layout';
import { PhraseParts } from '../ui/PhraseParts';
import { Mono, Small } from '../ui/text';
import { Block } from './Block';

// This week (spec P11): the seven days from today, today first (owner request, 2026-11-15), each day with what is on
// the town calendar and the location's notes, beside the same weekday last year and two years ago. Last year's total for the week is the first
// tile At a glance. No figure is ever shown for a day after the last day of data: a day prints its own figure only
// when it is past and has data, or “Likely closed (1 guest recorded)” when it was near empty (spec D32), as This month says. With no history at all (`history` false) the past-year rows and the footnote are
// left out and only the calendar shows. Term and season periods span weeks, so they show once under the headline
// with their whole span and sources, not in each day.
//
// With a published forecast, the first row is each day's Forecast, as This month's grid gives it (owner request,
// 2026-11-15): "About 90 guests, 68 to 112", Closed or Booked, or "No forecast" for a day the run doesn't cover; with
// none published there is no Forecast row, so Home still never shows a guess of its own.
// From 1024px the week is a strip, one column a day, with today's column, the first, raised: the day (and its own figure), then
// rows for the calendar, last year (a bar scaled to the week's busiest day last year, aria-hidden, beside the printed
// figure) and two years ago. It is a table, so each cell is read with its day and its row. Below 1024px it is the
// day-by-day table, which stacks at 640px and below.

/** An entry's kind words under its words: “Your note”, “Your rule”, “Holiday”, “Town event” or “Your calendar”. */
function entryKind(entry: DayEntry): string {
  if (entry.kind === 'note') return 'Your note';
  if (entry.kind === 'rule') return 'Your rule';
  if (entry.kind === 'imported') return 'Your calendar';
  return EVENT_WORDS[entry.kind];
}

/**
 * A day's compact entries (D49, week.ts weekEntries): three, or the first two and “+N more”, in the Calendar's order,
 * with no source links (the Calendar's day panel and This month's day detail hold them).
 */
function CalendarCell(props: { row: WeekRow }): React.JSX.Element {
  const { lines, more } = props.row.entries;
  if (lines.length === 0) return <Mono tone="text3">Nothing listed</Mono>;
  return (
    <View style={styles.cell}>
      {lines.map((entry) => (
        <View key={entry.key} style={styles.item}>
          <Text style={styles.title}>{entry.words}</Text>
          <Mono tone="text3">{entryKind(entry)}</Mono>
        </View>
      ))}
      {more === null ? null : <Mono tone="text3">{more}</Mono>}
    </View>
  );
}

/** A day's published forecast, its figure bold in a forecast's lighter tone (D49, design decision 10), or "No forecast". */
function ForecastCell(props: { day: ForecastDay | undefined }): React.JSX.Element {
  const phrase = forecastPhrase(props.day);
  return phrase === null ? <Mono tone="text3">No forecast</Mono> : <Mono tone="text2"><PhraseParts phrase={phrase} /></Mono>;
}

/** A day in a past year: "Sat, Nov 8, 2025: 241 guests", closed, against usual, and its holidays and events. */
export function PastCell(props: { day: PastDay; metric: Metric }): React.JSX.Element {
  const { day, metric } = props;
  const line = pastDayPhrase(day, metric);
  if (line === null) return <Mono tone="text3">No data</Mono>;
  const change = vsUsualDayPhrase(day);
  return (
    <View style={styles.item}>
      <Mono tone="white"><PhraseParts phrase={line} /></Mono>
      {day.closed ? <Mono>{day.likelyClosed ? 'Likely closed' : 'Closed'}</Mono> : null}
      {change === null ? null : <Mono><PhraseParts phrase={change} /></Mono>}
      {day.events.map((title) => <Small key={title}>{title}</Small>)}
    </View>
  );
}

function DayHead(props: { row: WeekRow; metric: Metric }): React.JSX.Element {
  const { row } = props;
  return (
    <View style={styles.item} testID={`home-day-${row.date}`}>
      <View style={styles.dayHead}>
        {row.isToday ? <View style={styles.square} /> : null}
        <Text style={styles.title}>{(WEEKDAY_NAMES[weekdayOf(row.date)] ?? '').slice(0, 3)}</Text>
      </View>
      <Mono>{dayMonth(row.date)}</Mono>
      {row.isToday ? <Mono tone="text3">Today</Mono> : null}
      {row.value === null ? null : <Mono tone="white"><PhraseParts phrase={thisDayPhrase(row, props.metric)} /></Mono>}
    </View>
  );
}

const BAR_ZONE = 40;

/** Last year's figure as a bar, scaled to the week's busiest day last year; aria-hidden, the cell prints it. */
function Bar(props: { value: number | null; top: number }): React.JSX.Element {
  const height = props.value === null || props.top <= 0 ? 0 : Math.max(1, Math.round((props.value / props.top) * BAR_ZONE));
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.barZone}>
      {height === 0 ? null : <View style={[styles.bar, { height }]} />}
    </View>
  );
}

/** The week as a strip of seven columns (from 1024px). */
function WeekStrip(props: { week: Week; metric: Metric; history: boolean; forecast: ReadonlyMap<string, ForecastDay> | null }): React.JSX.Element {
  const { week, metric, history, forecast } = props;
  const top = Math.max(0, ...week.rows.map((row) => row.lastYear.value ?? 0));
  const rows: { key: string; label: string; cell: (row: WeekRow) => React.ReactNode }[] = [
    ...(forecast === null ? [] : [{ key: 'forecast', label: 'Forecast', cell: (row: WeekRow) => <ForecastCell day={forecast.get(row.date)} /> }]),
    { key: 'calendar', label: 'On the calendar', cell: (row) => <CalendarCell row={row} /> },
    ...(history ? [{
      key: 'lastYear', label: 'Last year',
      cell: (row: WeekRow) => <View style={styles.cell}><Bar value={row.lastYear.value} top={top} /><PastCell day={row.lastYear} metric={metric} /></View>,
    }] : []),
    ...(history && week.twoYears ? [{
      key: 'twoYears', label: 'Two years ago', cell: (row: WeekRow) => <PastCell day={row.twoYearsAgo} metric={metric} />,
    }] : []),
  ];
  return (
    <View role="table" aria-label="This week, day by day" style={styles.strip}>
      <View role="row" style={styles.stripRow}>
        <View role="cell" style={styles.corner} />
        {week.rows.map((row) => (
          <View key={row.date} role="columnheader" style={[styles.stripCell, row.isToday ? styles.today : null]}>
            <DayHead row={row} metric={metric} />
          </View>
        ))}
      </View>
      {rows.map((part) => (
        <View key={part.key} role="row" style={[styles.stripRow, styles.ruled]}>
          <View role="rowheader" style={styles.corner}><Mono tone="text3">{part.label}</Mono></View>
          {week.rows.map((row) => (
            <View key={row.date} role="cell" style={[styles.stripCell, row.isToday ? styles.today : null]}>{part.cell(row)}</View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** The week as a table, a row a day (below 1024px). */
function WeekTable(props: { week: Week; metric: Metric; history: boolean; forecast: ReadonlyMap<string, ForecastDay> | null }): React.JSX.Element {
  const { week, metric, history, forecast } = props;
  const columns: Column[] = [
    { key: 'day', label: 'Day', flex: 0.8 },
    ...(forecast === null ? [] : [{ key: 'forecast', label: 'Forecast', flex: 1.4 }]),
    { key: 'calendar', label: 'On the calendar', flex: 2 },
    ...(history ? [{ key: 'lastYear', label: 'Last year', flex: 1.6 }] : []),
    ...(history && week.twoYears ? [{ key: 'twoYears', label: 'Two years ago', flex: 1.6 }] : []),
  ];
  const rows = week.rows.map((row) => ({
    key: row.date,
    selected: row.isToday,
    cells: {
      day: <DayHead row={row} metric={metric} />,
      forecast: forecast === null ? null : <ForecastCell day={forecast.get(row.date)} />,
      calendar: <CalendarCell row={row} />,
      lastYear: <PastCell day={row.lastYear} metric={metric} />,
      twoYears: <PastCell day={row.twoYearsAgo} metric={metric} />,
    },
  }));
  return <DataTable label="This week, day by day" columns={columns} rows={rows} />;
}

export function ThisWeek(props: {
  week: Week; calendar: Calendar; metric: Metric; history: boolean;
  /** The published forecast, when there is one; null while it loads, if it fails, or with none published. */
  forecast: ForecastWindow | null;
}): React.JSX.Element {
  const { week, calendar, metric, history } = props;
  const { desktop } = useBreakpoint();
  const forecast = useMemo(
    () => (props.forecast === null ? null : new Map(props.forecast.days.map((day): [string, ForecastDay] => [day.date, day]))),
    [props.forecast],
  );
  const number = (value: number | null): string => (value === null ? 'No data' : metricNumber(value, metric));

  return (
    <Block label={`This week in ${calendar.town.name}`} eyebrow={`This week in ${calendar.town.name}`} title="What’s on the calendar, and how this week went before">
      <Stack gap={8}>
        <Small white>{calendarWeekLine(week, calendar)}</Small>
        {week.periods.map((period) => (
          <View key={period.id} style={styles.item}>
            <Small>{periodLine(period)}</Small>
            <SourceChips sources={period.sources} />
          </View>
        ))}
      </Stack>
      {desktop
        ? <WeekStrip week={week} metric={metric} history={history} forecast={forecast} />
        : <WeekTable week={week} metric={metric} history={history} forecast={forecast} />}
      <Stack gap={8}>
        {history ? <Mono tone="text3">{LAST_YEAR_FOOTNOTE}</Mono> : null}
        {history && desktop ? <Mono tone="text3">Bars show last year’s days, scaled to the busiest of them.</Mono> : null}
        <Mono tone="text3">{calendarCoverageLine(calendar)}</Mono>
      </Stack>
      {history ? (
        <ShowNumbers>
          <DataTable
            label="This week’s days in past years"
            columns={[
              { key: 'day', label: 'Day' }, { key: 'lastYear', label: 'Last year', numeric: true },
              { key: 'twoYears', label: 'Two years ago', numeric: true }, { key: 'usual', label: 'Usual (last year)', numeric: true },
            ]}
            rows={week.rows.map((row) => ({
              key: row.date,
              cells: {
                day: shortDate(row.date),
                lastYear: number(row.lastYear.value),
                twoYears: number(row.twoYearsAgo.value),
                usual: row.lastYear.usual === null ? 'Not enough days' : metricNumber(row.lastYear.usual.mean, metric),
              },
            }))}
          />
        </ShowNumbers>
      ) : null}
    </Block>
  );
}

const c = theme.color;
const CORNER = 124;

const styles = StyleSheet.create({
  item: { gap: 2, minWidth: 0 },
  cell: { gap: theme.space[2], minWidth: 0 },
  dayHead: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  square: { width: 6, height: 6, backgroundColor: c.mint },
  title: { ...theme.type.ui, color: c.white },
  strip: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border },
  stripRow: { flexDirection: 'row', alignItems: 'stretch' },
  ruled: { borderTopWidth: 1, borderTopColor: c.border },
  corner: { width: CORNER, paddingVertical: theme.space[3], paddingRight: theme.space[3] },
  stripCell: { flex: 1, minWidth: 0, paddingVertical: theme.space[3], paddingHorizontal: theme.space[2], borderLeftWidth: 1, borderLeftColor: c.border },
  today: { backgroundColor: c.raised },
  barZone: { height: BAR_ZONE, justifyContent: 'flex-end' },
  bar: { width: '100%', maxWidth: 40, backgroundColor: c.mint },
});
