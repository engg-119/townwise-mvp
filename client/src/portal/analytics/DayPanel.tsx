import { Link, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { locationHref } from '../routing';
import { Actions, Button, LinkButton } from '../ui/Button';
import { DefinitionList } from '../ui/DataTable';
import { Heading, Mono, Small } from '../ui/text';
import { PANEL_EMPTY, NO_NOTES, type DayPanelData } from './panel';

// The Day panel (home.md 4.5), one file for both platforms: everything Townwise has for one day, from panel.ts.
// Sections in order, a section with nothing in it left out (Your numbers and Your notes always show): the date and
// its status, Your numbers, On the town calendar with each event's sources, Your notes, Where it came from, then
// Previous day, Next day and a link to TownwiseAI. It never writes, so it is the same under view-as. Note text and
// figures are only on screen; nothing here logs.

const HEADING_ID = 'analytics-day-heading';

function Part(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.part}>
      <Heading level={3} style={styles.partTitle}>{props.title}</Heading>
      {props.children}
    </View>
  );
}

export function DayPanel(props: {
  data: DayPanelData | null;
  locationId: string;
  /** Null at the first or last day the heatmap shows. */
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}): React.JSX.Element {
  const { data } = props;
  if (data === null) {
    return (
      <View role="region" aria-label="Day" style={styles.panel}>
        <Small>{PANEL_EMPTY}</Small>
      </View>
    );
  }
  return (
    <View role="region" aria-labelledby={HEADING_ID} style={styles.panel}>
      <View style={styles.head}>
        <Heading level={3} nativeID={HEADING_ID}>{data.heading}</Heading>
        {data.status.length === 0 ? null : <Mono>{data.status.map((status) => `${status}.`).join(' ')}</Mono>}
      </View>

      <Part title="Your numbers">
        <DefinitionList mono items={data.numbers.map((number) => ({ term: number.label, value: number.value }))} />
      </Part>

      {data.events.length === 0 && data.calendarNote === null ? null : (
        <Part title="On the town calendar">
          {data.events.map((event) => (
            <View key={event.id} style={styles.item}>
              <Text style={styles.itemTitle}>{event.title}</Text>
              <Mono tone="text3">{event.dates === null ? event.kind : `${event.kind}, ${event.dates}`}</Mono>
              {event.sources.map((source) => (
                <Link key={source.url} href={source.url as Href} style={styles.source}>{`Source: ${source.label}`}</Link>
              ))}
            </View>
          ))}
          {data.calendarNote === null ? null : <Small>{data.calendarNote}</Small>}
        </Part>
      )}

      <Part title="Your notes">
        {data.notes.length === 0 ? <Small>{NO_NOTES}</Small> : data.notes.map((note) => (
          <View key={note.id} style={styles.item}>
            <Text style={styles.itemTitle}>{note.words}</Text>
            {note.dates === null ? null : <Mono tone="text3">{note.dates}</Mono>}
            {note.weekdays === null ? null : <Mono tone="text3">{note.weekdays}</Mono>}
            {note.expected === null ? null : <Mono>{note.expected}</Mono>}
            {note.detail === null ? null : <Small>{note.detail}</Small>}
            <Mono tone="text3">{note.addedBy}</Mono>
          </View>
        ))}
        <LinkButton href={locationHref(props.locationId, 'notes')} label="Open Notes" />
      </Part>

      {data.source === null ? null : (
        <Part title="Where it came from">
          <Small>{data.source.line}</Small>
          {data.source.warning === null ? null : <Small>{data.source.warning}</Small>}
          {/* F4 (build plan section 7): the stored file's kind and name, "Download cleaned CSV" and a link to Your
              files mount here once uploads link to stored files. Until then `source.file` is always null. */}
        </Part>
      )}

      <View style={styles.footer}>
        <Actions>
          <Button variant="outline" label="Previous day" disabled={props.onPrev === null} {...(props.onPrev === null ? {} : { onPress: props.onPrev })} />
          <Button variant="outline" label="Next day" disabled={props.onNext === null} {...(props.onNext === null ? {} : { onPress: props.onNext })} />
        </Actions>
        <LinkButton href={locationHref(props.locationId, 'agent')} label="Ask TownwiseAI about this day" />
      </View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  panel: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, padding: theme.space[5], gap: theme.space[5] },
  head: { gap: theme.space[2] },
  part: { gap: theme.space[3], paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border },
  partTitle: { ...theme.type.label, color: c.text3 },
  item: { gap: theme.space[1] },
  itemTitle: { ...theme.type.ui, color: c.white },
  source: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
  footer: { gap: theme.space[2], paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border },
});
