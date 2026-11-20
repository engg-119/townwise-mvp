import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { ResearchedEvent } from '../analytics/api';
import { foundCovers } from '../calendar/entries';
import { addDays } from '../locations/dates';
import { calendarHref } from '../routing';
import { eventChips, eventWhen } from './research-copy';

// A researched event on the Town tab (D66): its title linking to its Calendar day, then its dates and its chips
// (Unconfirmed, Cancelled), for the Research section's week list and the Competition card.

/**
 * The first day from `from` to `to` (YYYY-MM-DD) the event is on, its weekdays honored as on the Calendar, or null. A
 * season that began months ago links to a day in the range, not to its start, and a Saturdays-only market whose days
 * all fall outside the range is not in it.
 */
export function firstDay(event: Pick<ResearchedEvent, 'start' | 'end' | 'weekdays'>, from: string, to: string): string | null {
  const last = event.end < to ? event.end : to;
  for (let day = event.start > from ? event.start : from, i = 0; day <= last && i < 7; day = addDays(day, 1), i += 1) {
    if (foundCovers(event, day)) return day;
  }
  return null;
}

/** `day` is the Calendar day the title links to (firstDay), the event's start when not given. */
export function EventItem(props: { locationId: string; event: ResearchedEvent; day?: string | null }): React.JSX.Element {
  const { event } = props;
  return (
    <View role="listitem" style={styles.item}>
      <Link href={calendarHref(props.locationId, props.day ?? event.start)} style={styles.title}>{event.title}</Link>
      <Text style={styles.help}>{[eventWhen(event), ...eventChips(event)].join(' · ')}</Text>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  item: { gap: 2 },
  title: { ...theme.type.small, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  help: { ...theme.type.small, color: c.text3 },
});
