import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { ResearchedEvent } from '../analytics/api';
import { calendarHref } from '../routing';
import { eventChips, eventWhen } from './research-copy';

// A researched event on the Town tab (D66): its title linking to its Calendar day, then its dates and its chips
// (Unconfirmed, Cancelled), for the Research section's week list and the Competition card.

export function EventItem(props: { locationId: string; event: ResearchedEvent }): React.JSX.Element {
  const { event } = props;
  return (
    <View role="listitem" style={styles.item}>
      <Link href={calendarHref(props.locationId, event.start)} style={styles.title}>{event.title}</Link>
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
