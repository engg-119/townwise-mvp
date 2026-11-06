import { Link, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { Calendar, TownEvent } from '../analytics/api';
import { noteWords } from '../analytics/panel';
import {
  calendarCoverageLine, calendarWeekLine, dayMonth, EVENT_WORDS, LAST_YEAR_FOOTNOTE, pastDayLine, periodLine, summaryLabel, vsUsualDay, vsUsualLine,
  type PastDay, type ThisWeek as Week,
} from '../analytics/week';
import { metricNumber, metricText, shortDate, WEEKDAY_NAMES, weekdayOf, type Metric } from '../analytics/words';
import { useBreakpoint } from '../hooks';
import type { Note } from '../locations/api';
import { ShowNumbers } from '../locations/parts';
import { DataTable, type Column } from '../ui/DataTable';
import { Section, Stack } from '../ui/layout';
import { Mono, Small } from '../ui/text';

// This week (home.md 2.2): Monday to Sunday of the viewer's week, each day with what is on the town calendar and
// the location's notes, beside the same weekday last year and two years ago. The summary sums last year's same
// week, and only when at least 5 of its days have data. No figure is ever shown for a day after the last day of
// data: the Day column prints a figure only for this week's past days with data. With no history at all
// (`history` false) the past-year columns and the summary are left out and only the calendar shows. Term and season
// periods span weeks, so they show once under the headline with their whole span and sources, not in each day.

function Sources(props: { event: TownEvent }): React.JSX.Element {
  return (
    <>
      {props.event.sources.map((source) => (
        <Link key={source.url} href={source.url as Href} style={styles.source}>{`Source: ${source.label}`}</Link>
      ))}
    </>
  );
}

function EventLines(props: { events: readonly TownEvent[] }): React.JSX.Element {
  return (
    <>
      {props.events.map((event) => (
        <View key={event.id} style={styles.item}>
          <Text style={styles.title}>{event.title}</Text>
          <Mono tone="text3">{EVENT_WORDS[event.kind]}</Mono>
          <Sources event={event} />
        </View>
      ))}
    </>
  );
}

function NoteLines(props: { notes: readonly Note[] }): React.JSX.Element {
  return (
    <>
      {props.notes.map((note) => (
        <View key={note.id} style={styles.item}>
          <Text style={styles.title}>{`Your note: ${noteWords(note)}`}</Text>
          {note.detail === null ? null : <Small>{note.detail}</Small>}
        </View>
      ))}
    </>
  );
}

function PastCell(props: { day: PastDay; metric: Metric }): React.JSX.Element {
  const { day, metric } = props;
  const line = pastDayLine(day, metric);
  if (line === null) return <Mono tone="text3">No data</Mono>;
  const change = vsUsualDay(day);
  return (
    <View style={styles.item}>
      <Mono tone="white">{line}</Mono>
      {day.closed ? <Mono>Closed</Mono> : null}
      {change === null ? null : <Mono>{change}</Mono>}
      {day.events.map((title) => <Small key={title}>{title}</Small>)}
    </View>
  );
}

export function ThisWeek(props: { week: Week; calendar: Calendar; metric: Metric; history: boolean }): React.JSX.Element {
  const { week, calendar, metric, history } = props;
  const { phone } = useBreakpoint();
  const town = calendar.town.name;
  const { summary } = week;
  const usualLine = summary === null ? null : vsUsualLine(summary);
  const columns: Column[] = [
    { key: 'day', label: 'Day', flex: 0.8 },
    { key: 'calendar', label: 'On the calendar', flex: 2 },
    ...(history ? [{ key: 'lastYear', label: 'Last year', flex: 1.6 }] : []),
    ...(history && week.twoYears ? [{ key: 'twoYears', label: 'Two years ago', flex: 1.6 }] : []),
  ];
  const rows = week.rows.map((row) => ({
    key: row.date,
    selected: row.isToday,
    cells: {
      day: (
        <View style={styles.item} testID={`home-day-${row.date}`}>
          <View style={styles.dayHead}>
            {row.isToday ? <View style={styles.square} /> : null}
            <Text style={styles.title}>{(WEEKDAY_NAMES[weekdayOf(row.date)] ?? '').slice(0, 3)}</Text>
          </View>
          <Mono>{dayMonth(row.date)}</Mono>
          {row.isToday ? <Mono tone="text3">Today</Mono> : null}
          {row.value === null ? null : <Mono tone="white">{metricText(row.value, metric)}</Mono>}
        </View>
      ),
      calendar: row.events.length === 0 && row.notes.length === 0
        ? <Mono tone="text3">Nothing listed</Mono>
        : <View style={styles.cell}><EventLines events={row.events} /><NoteLines notes={row.notes} /></View>,
      lastYear: <PastCell day={row.lastYear} metric={metric} />,
      twoYears: <PastCell day={row.twoYearsAgo} metric={metric} />,
    },
  }));
  const number = (value: number | null): string => (value === null ? 'No data' : metricNumber(value, metric));

  return (
    <Section first kicker={`This week in ${town}`} title="What’s on the calendar, and how this week went before">
      <Stack gap={12}>
        {history && summary !== null ? (
          <View style={styles.summary}>
            <View style={styles.big}>
              <Text style={[phone ? theme.type.valuePhone : theme.type.value, styles.value]}>{metricNumber(summary.total, metric)}</Text>
              <Mono>{metric === 'guests' ? 'guests' : 'net sales'}</Mono>
            </View>
            <View style={styles.summaryLines}>
              <Small white>{summaryLabel(summary)}</Small>
              {usualLine === null ? null : <Small>{usualLine}</Small>}
              {summary.busiest === null ? null : <Small>{`Busiest last year: ${shortDate(summary.busiest)}.`}</Small>}
              {summary.quietest === null ? null : <Small>{`Quietest last year: ${shortDate(summary.quietest)}.`}</Small>}
            </View>
          </View>
        ) : null}
        <Small white>{calendarWeekLine(week, calendar)}</Small>
        {week.periods.map((period) => (
          <View key={period.id} style={styles.item}>
            <Small>{periodLine(period)}</Small>
            <Sources event={period} />
          </View>
        ))}
      </Stack>
      <DataTable label="This week, day by day" columns={columns} rows={rows} />
      <Stack gap={8}>
        {history ? <Mono tone="text3">{LAST_YEAR_FOOTNOTE}</Mono> : null}
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
    </Section>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  item: { gap: 2, minWidth: 0 },
  cell: { gap: theme.space[2], minWidth: 0 },
  dayHead: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  square: { width: 6, height: 6, backgroundColor: c.mint },
  title: { ...theme.type.ui, color: c.white },
  source: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
  summary: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: theme.space[6], rowGap: theme.space[3] },
  big: { gap: theme.space[1] },
  value: { color: c.white, fontVariant: ['tabular-nums'] },
  summaryLines: { gap: 2, flexShrink: 1, minWidth: 0 },
});
