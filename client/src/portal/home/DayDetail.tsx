import { Link, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { noteWords } from '../analytics/panel';
import { eventLine, thisDayPhrase, type MonthDay } from '../analytics/week';
import { shortDate, type Metric } from '../analytics/words';
import { ReasonMark } from '../calendar/CalendarDay';
import { shortReasons, type ShortReason } from '../calendar/model';
import { appliedOf, guestsFromWords, yoursDid, type ForecastDay } from '../estimates/api';
import { formatCount, plural } from '../format';
import type { LoadState } from '../hooks';
import type { OrderBoard } from '../orders/api';
import { locationHref } from '../routing';
import { PhraseParts } from '../ui/PhraseParts';
import { SourceChips } from '../ui/SourceChip';
import { Heading, Mono, Small } from '../ui/text';
import { orderCoverSentence, orderForDay, REORDER_OVERVIEW } from './beside';
import { PastCell } from './ThisWeek';

// The selected day of This month (spec P11), beside the grid from where they fit side by side, under it otherwise:
// from today on, the published forecast's day when there is one (its figure and range, the guests your notes and
// business rules add, and its three reasons with the largest effect either way, in the Calendar's order and short words,
// “Saturday: usually more guests” after the Calendar's colored mark, which a note's or a rule's line, its label alone,
// goes without, a rule's among them, each with its sources as chips, ui/SourceChip.tsx; spec 16.3 P11, 14.4, D31), how
// the next order relates to the day (P30, from Home's one read of the orders, with a link to the day on Orders), the
// day's holidays and town events with their sources less those Why already names (as the Calendar's panel leaves
// them out), your notes, then, with any history, the day's own figure (only for a past day with data; a day after today
// gets none of its own, ever) and the same weekday last year and two years ago. Term and season periods are left to the
// month's list, since they mark no day. It reads nothing of its own; the Calendar has the full day.

export const DETAIL_ID = 'home-day-detail';

const WHY_LINES = 3;

/**
 * The Forecast part's words: “About 212 guests, likely 180 to 240.”, a booked day, or a closed one. An outlook day's
 * read the same under a part headed “Outlook” (D52).
 */
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

/**
 * A forecast day's `count` reasons with the largest effect either way, in the Calendar's order and short words, each
 * with its reason for its sources and, before a line whose words say the direction, Why's mark (shortReasons). Home
 * passes a forecast day only from today on.
 */
export function whyRows(day: Pick<ForecastDay, 'reasons' | 'model'>, count: number): ShortReason[] {
  return shortReasons(day, false, count);
}

/** The Reorder part's line: how the next order relates to `date`, or why Townwise can't say. */
function orderCover(date: string, board: LoadState<OrderBoard>): string {
  if (board.status === 'failed') return 'Townwise couldn’t check the next order.';
  if (board.status !== 'ready') return 'Checking the next order.';
  return board.data.available ? orderCoverSentence(date, orderForDay(date, board.data)) : board.data.reason;
}

function Part(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.part}>
      <Mono tone="text3">{props.label}</Mono>
      {props.children}
    </View>
  );
}

export function DayDetail(props: {
  day: MonthDay; forecast: ForecastDay | null; metric: Metric; history: boolean; locationId: string; board: LoadState<OrderBoard>;
}): React.JSX.Element {
  const { day, forecast, metric, history, locationId, board } = props;
  const lines = forecast === null ? [] : forecastDayLines(forecast);
  // Home passes a forecast day only from today on.
  const why = forecast === null ? [] : whyRows(forecast, WHY_LINES);
  // A holiday or town event a run reason in Why names is there with its sources, so On the calendar doesn't repeat it.
  const named = new Set(why.flatMap((row) => (appliedOf(row.reason) === null ? [row.reason.label] : [])));
  const events = day.events.filter((event) => !named.has(event.title));
  const nothing = events.length === 0 && day.notes.length === 0;
  return (
    <View role="region" aria-label="Selected day" nativeID={DETAIL_ID} style={styles.root}>
      <Heading level={3}>{day.isToday ? `Today, ${shortDate(day.date)}` : shortDate(day.date)}</Heading>
      {lines.length === 0 ? null : (
        <Part label={forecast?.outlook === true && forecast.status === 'open' ? 'Outlook' : 'Forecast'}>
          {lines.map((line) => <Small key={line} white>{line}</Small>)}
        </Part>
      )}
      {why.length === 0 ? null : (
        <Part label="Why">
          {why.map((row, index) => (
            <View key={String(index)} style={styles.item}>
              <View style={styles.line}>
                {row.mark === null ? null : <ReasonMark mark={row.mark} grade={row.grade} />}
                <Small style={styles.words}>{row.line}</Small>
              </View>
              <SourceChips sources={row.reason.sources} />
            </View>
          ))}
        </Part>
      )}
      <Part label="Reorder">
        <Small>{REORDER_OVERVIEW}</Small>
        <Small white>{orderCover(day.date, board)}</Small>
        <Link href={`${locationHref(locationId, 'orders')}?day=${day.date}` as Href} style={styles.source}>Open this day on Orders</Link>
      </Part>
      <Part label="On the calendar">
        {nothing ? <Small>{events.length < day.events.length ? 'Nothing else on the calendar this day.' : 'Nothing on the calendar this day.'}</Small> : null}
        {events.map((event) => (
          <View key={event.id} style={styles.item}>
            <Small white>{eventLine(event)}</Small>
            <SourceChips sources={event.sources} />
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
          <Mono tone={day.value === null ? 'text3' : 'white'}><PhraseParts phrase={thisDayPhrase(day, metric)} /></Mono>
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
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2], minWidth: 0 },
  words: { flex: 1, minWidth: 0 },
  source: { ...theme.type.mono, color: c.text2, paddingVertical: 14, textDecorationLine: 'underline', textDecorationColor: c.line },
});
