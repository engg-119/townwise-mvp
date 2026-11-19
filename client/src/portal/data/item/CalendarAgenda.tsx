import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../../theme';
import { AgendaCard } from '../../calendar/AgendaCard';
import { Heading } from '../../ui/text';
import type { AgendaItem, AgendaMonth } from './agenda';

// The calendar agenda of Your data (D49, calendar-detail), web and native: a list per month under its heading, each
// event the week view's agenda card (calendar/AgendaCard.tsx). An event with a day to open is one link, named by its
// title and day, to that day on the Calendar; a file's event that made no note is plain text. Titles render as text.
// `below` puts a part under an event's card, outside its link (the calendar page's label choice, D58).

function Row(props: { item: AgendaItem; below: React.ReactNode }): React.JSX.Element {
  const { item, below } = props;
  const card = (
    <AgendaCard card={{ kind: item.kind, hours: item.hours, title: item.title, sub: item.when }}>
      {item.sub === null ? null : <Text style={styles.sub}>{item.sub}</Text>}
      {item.status === null ? null : <Text style={styles.status}>{item.status}</Text>}
    </AgendaCard>
  );
  if (item.href === null) {
    if (below === null) return <View role="listitem" accessibilityLabel={item.label}>{card}</View>;
    return <View role="listitem"><View accessibilityLabel={item.label}>{card}</View>{below}</View>;
  }
  return (
    <View role="listitem">
      <Link href={item.href} asChild>
        {/* A child of Link asChild takes one plain style object (ui/hover.ts). */}
        <Pressable role="link" accessibilityLabel={item.label} style={styles.link}>
          {card}
        </Pressable>
      </Link>
      {below}
    </View>
  );
}

export function CalendarAgenda(props: {
  months: readonly AgendaMonth[];
  label: string;
  /** A part under an item's card, by the item; null for none. */
  below?: (item: AgendaItem) => React.ReactNode;
}): React.JSX.Element {
  return (
    <View aria-label={props.label} style={styles.root}>
      {props.months.map((month) => (
        <View key={month.month} style={styles.month}>
          <Heading level={4}>{month.label}</Heading>
          <View role="list" aria-label={`${props.label}, ${month.label}`} style={styles.list}>
            {month.items.map((item) => <Row key={item.key} item={item} below={props.below?.(item) ?? null} />)}
          </View>
        </View>
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[4], minWidth: 0 },
  month: { gap: theme.space[2], minWidth: 0 },
  list: { gap: 3 },
  link: { minHeight: 44, justifyContent: 'center' },
  sub: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3 },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2 },
});
