import { Link, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { noteWords } from '../analytics/panel';
import { eventLine, type MonthDay } from '../analytics/week';
import { metricText, shortDate, type Metric } from '../analytics/words';
import { locationHref } from '../routing';
import { Heading, Mono, Small } from '../ui/text';
import { BesideCalendar } from './BesideCalendar';
import { PastCell } from './ThisWeek';

// The selected day of This month (spec P11), beside the grid from where they fit side by side, under it otherwise:
// the day's holidays and town events with their sources, your notes, then, with any history, the day's own figure
// (only for a past day with data; a day after today gets none, ever) and the same weekday last year and two years
// ago. Term and season periods are left to the month's list, since they mark no day. Its own parts read nothing; BesideCalendar, mounted beside them, reads the month forecast and the orders.

export const DETAIL_ID = 'home-day-detail';

function Part(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.part}>
      <Mono tone="text3">{props.label}</Mono>
      {props.children}
    </View>
  );
}

export function DayDetail(props: { day: MonthDay; metric: Metric; history: boolean; locationId: string }): React.JSX.Element {
  const { day, metric, history } = props;
  const nothing = day.events.length === 0 && day.notes.length === 0;
  const title = day.isToday ? `Today, ${shortDate(day.date)}` : shortDate(day.date);
  return (
    <View role="region" aria-label="Selected day" nativeID={DETAIL_ID} style={styles.root}>
      <Heading level={3}>
        <Link href={`${locationHref(props.locationId, 'orders')}?day=${day.date}` as Href} style={styles.dateLink}>{title}</Link>
      </Heading>
      <BesideCalendar locationId={props.locationId} date={day.date} />
      <Part label="On the calendar">
        {nothing ? <Small>Nothing on the calendar this day.</Small> : null}
        {day.events.map((event) => (
          <View key={event.id} style={styles.item}>
            <Small white>{eventLine(event)}</Small>
            {event.sources.map((source) => (
              <Link key={source.url} href={source.url as Href} style={styles.source}>{`Source: ${source.label}`}</Link>
            ))}
          </View>
        ))}
        {day.notes.map((note) => (
          <View key={note.id} style={styles.item}>
            <Small white>{`Your note: ${noteWords(note)}.`}</Small>
            {note.detail === null ? null : <Small>{note.detail}</Small>}
          </View>
        ))}
      </Part>
      {history && !day.future ? (
        <Part label="This day">
          <Mono tone={day.value === null ? 'text3' : 'white'}>{day.value === null ? 'No sales stored for this day.' : metricText(day.value, metric)}</Mono>
        </Part>
      ) : null}
      {history ? <Part label="Same weekday last year"><PastCell day={day.lastYear} metric={metric} /></Part> : null}
      {history && day.twoYearsAgo.value !== null ? <Part label="Two years ago"><PastCell day={day.twoYearsAgo} metric={metric} /></Part> : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[4], minWidth: 0 },
  dateLink: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  part: { gap: theme.space[1], minWidth: 0 },
  item: { gap: 0, minWidth: 0 },
  source: { ...theme.type.mono, color: c.text2, paddingVertical: 14, textDecorationLine: 'underline', textDecorationColor: c.line },
});
