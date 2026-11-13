import { Link, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { noteWords } from '../analytics/panel';
import { eventLine, thisDayLine, type MonthDay } from '../analytics/week';
import { shortDate, type Metric } from '../analytics/words';
import { guestsFromWords, yoursDid, type ForecastDay } from '../estimates/api';
import { formatCount, plural } from '../format';
import { Heading, Mono, Small } from '../ui/text';
import { PastCell } from './ThisWeek';

// The selected day of This month (spec P11), beside the grid from where they fit side by side, under it otherwise:
// from today on, the published forecast's day when there is one (its figure and range, the guests your notes and
// business rules add, and its first three reasons, a rule's among them; spec 16.3 P11, D31), the day's holidays and town events with their sources, your
// notes, then, with any history, the day's own figure (only for a past day with data; a day after today gets none of
// its own, ever) and the same weekday last year and two years ago. Term and season periods are left to the month's
// list, since they mark no day. It reads nothing of its own; the Calendar has the full day.

export const DETAIL_ID = 'home-day-detail';

const WHY_LINES = 3;

/** The Forecast part's words: “About 212 guests, likely 180 to 240.”, a booked day, or a closed one. */
export function forecastDayLines(day: ForecastDay): string[] {
  if (day.status === 'closed') return ['Closed.'];
  if (day.status === 'booked') {
    if (!yoursDid(day, 'booked')) return ['Booked for a private event. No walk-in forecast.'];
    return [day.noteGuests > 0 ? `Booked: a private buyout, ${plural(day.noteGuests, 'guest', 'guests')}. No walk-in forecast.` : 'Booked: a private buyout. No walk-in forecast.'];
  }
  if (day.low === null || day.mid === null || day.high === null) return [];
  // The range's low rounds down and its high up (spec 14.4), as the Calendar and TownwiseAI give it.
  const range = `About ${plural(Math.round(day.mid), 'guest', 'guests')}, likely ${formatCount(Math.floor(day.low))} to ${formatCount(Math.ceil(day.high))}.`;
  return [day.noteGuests > 0 ? `${range} Includes ${plural(day.noteGuests, 'guest', 'guests')} from ${guestsFromWords(day)}.` : range];
}

function Part(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.part}>
      <Mono tone="text3">{props.label}</Mono>
      {props.children}
    </View>
  );
}

export function DayDetail(props: { day: MonthDay; forecast: ForecastDay | null; metric: Metric; history: boolean }): React.JSX.Element {
  const { day, forecast, metric, history } = props;
  const nothing = day.events.length === 0 && day.notes.length === 0;
  const lines = forecast === null ? [] : forecastDayLines(forecast);
  const why = forecast === null ? [] : forecast.reasons.slice(0, WHY_LINES);
  return (
    <View role="region" aria-label="Selected day" nativeID={DETAIL_ID} style={styles.root}>
      <Heading level={3}>{day.isToday ? `Today, ${shortDate(day.date)}` : shortDate(day.date)}</Heading>
      {lines.length === 0 ? null : (
        <Part label="Forecast">
          {lines.map((line) => <Small key={line} white>{line}</Small>)}
        </Part>
      )}
      {why.length === 0 ? null : (
        <Part label="Why">
          {why.map((reason, index) => <Small key={`${String(index)}:${reason.kind}`}>{reason.label}</Small>)}
        </Part>
      )}
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
          <Mono tone={day.value === null ? 'text3' : 'white'}>{thisDayLine(day, metric)}</Mono>
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
  part: { gap: theme.space[1], minWidth: 0 },
  item: { gap: 0, minWidth: 0 },
  source: { ...theme.type.mono, color: c.text2, paddingVertical: 14, textDecorationLine: 'underline', textDecorationColor: c.line },
});
