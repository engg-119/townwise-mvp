import { Link, type Href } from 'expo-router';
import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatCount } from '../format';
import { noteWords } from '../analytics/panel';
import { eventLine } from '../analytics/week';
import type { Note } from '../locations/api';
import { Loading } from '../locations/parts';
import { datesLine, hoursLine, KIND_LABEL, weekdaysLine } from '../locations/noteRules';
import { Actions, Button, LinkButton } from '../ui/Button';
import { Notice, ReadOnlyLine } from '../ui/feedback';
import { Heading, inlineTarget, Mono, Small } from '../ui/text';
import { forecastWords, type CalendarDayView, type ImportedEvent, type ReasonLine } from './model';

// The Calendar's day panel (P27, spec 16.3): a region "Selected day", beside the grid from 1024px and
// under it below. Top to bottom: the day; its Forecast (the published figure and range, what the notes changed, a
// booked or closed day, a past day's guests against the model, or why there is none); Why (one row per reason: your
// notes and rules first with what they did, then the run's reasons, biggest effect first, each its label, then whether
// it usually brings more or fewer guests in words after a direction mark screen readers skip, then a small inline
// Source link); On the calendar (the holidays, town events and term dates Why doesn't already name, with their
// sources, the day's notes with Edit and Delete where the API allows, the business rules whose schedule covers the day
// with their summary and a link to Rules, where they are changed (D31), events from the owner's calendar file with
// Make a note); then
// Add an event, or the note form open in its place. Under view-as the writes are disabled in place with the
// read-only line. It reads and writes nothing itself: the page owns the reads, the form and the dialog.

export const PANEL_ID = 'calendar-day';

function Part(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.part}>
      <Mono tone="text3">{props.label}</Mono>
      {props.children}
    </View>
  );
}

/** “Nov 21, 2026, 6 pm to 9 pm, 70 guests”: the note's dates and whatever else it has. */
function noteLine(note: Note): string {
  return [
    datesLine(note), weekdaysLine(note.weekdays), hoursLine(note),
    note.expectedGuests === null ? null : `${formatCount(note.expectedGuests)} guests`,
  ].filter((part) => part !== null).join(', ');
}

function importedLine(event: ImportedEvent): string {
  return [datesLine(event), hoursLine(event)].filter((part) => part !== null).join(', ');
}

/**
 * One reason under Why: its label, then what it does in words (the mark before them is hidden from screen readers,
 * which hear the same words), ending in a small inline “Source” link named for where it goes.
 */
function WhyRow(props: { reason: ReasonLine }): React.JSX.Element {
  const { reason } = props;
  const many = reason.sources.length > 1;
  return (
    <View role="listitem" style={styles.item}>
      <Small white>{reason.label}</Small>
      {reason.detail === null && reason.sources.length === 0 ? null : (
        <View style={styles.effect}>
          {reason.mark === null ? null : (
            <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Small white>{reason.mark}</Small>
            </View>
          )}
          <Small style={styles.words}>
            {reason.detail ?? ''}
            {reason.sources.map((source, index) => (
              <Fragment key={source.url}>
                {reason.detail === null && index === 0 ? '' : ' '}
                <Link href={source.url as Href} accessibilityLabel={`Source: ${source.label}`} style={styles.inlineSource}>
                  {many ? `Source ${String(index + 1)}` : 'Source'}
                </Link>
              </Fragment>
            ))}
          </Small>
        </View>
      )}
    </View>
  );
}

export function CalendarDay(props: {
  /** Null while the selected day's month loads. */
  view: CalendarDayView | null;
  /** The location's shown name (shownLocationName). */
  locationName: string;
  /** The location's Business rules page. */
  rulesHref: string;
  notice: string | null;
  readOnlyId: string | null;
  readOnlyText: string;
  /** The note form, open in the panel; null when closed. */
  form: React.ReactNode;
  onAdd: () => void;
  onEdit: (note: Note) => void;
  onDelete: (note: Note) => void;
  /** Opens the note form from an event in the owner's calendar file. */
  onMakeNote: (event: ImportedEvent) => void;
}): React.JSX.Element {
  const { view, readOnlyId } = props;
  if (view === null) {
    return <View role="region" aria-label="Selected day" nativeID={PANEL_ID} style={styles.root}><Loading text="Loading the day" minHeight={120} /></View>;
  }
  const words = forecastWords(view.forecast, props.locationName);
  const ro = readOnlyId === null ? null : { disabled: true, describedBy: readOnlyId };
  const nothing = view.events.length === 0 && view.notes.length === 0 && view.rules.length === 0 && view.imported.length === 0;
  const nothingWords = view.shownInWhy > 0 ? 'Nothing else on the calendar this day.' : 'Nothing on the calendar this day.';
  return (
    <View role="region" aria-label="Selected day" nativeID={PANEL_ID} style={styles.root}>
      <Heading>{view.heading}</Heading>
      {props.notice === null ? null : <Notice text={props.notice} />}
      <Part label="Forecast">
        {words.figure === null ? null : (
          <Text style={styles.lead}>
            {words.figure.before === '' ? '' : `${words.figure.before} `}
            <Text style={styles.value}>{words.figure.value}</Text>
            {` ${words.figure.after}`}
          </Text>
        )}
        {words.lines.map((line) => <Small key={line} white={words.figure === null}>{line}</Small>)}
      </Part>
      {view.reasons.length === 0 ? null : (
        <Part label="Why">
          <View role="list" style={styles.list}>
            {view.reasons.map((reason) => <WhyRow key={reason.key} reason={reason} />)}
          </View>
          {view.moreNotes === 0 ? null : <Small>{`+${formatCount(view.moreNotes)} more of your notes`}</Small>}
        </Part>
      )}
      <Part label="On the calendar">
        {nothing ? <Small>{nothingWords}</Small> : null}
        {view.events.map((event) => (
          <View key={event.id} style={styles.item}>
            <Small white>{eventLine(event)}</Small>
            {event.sources.map((source) => (
              <Link key={source.url} href={source.url as Href} style={styles.source}>{`Source: ${source.label}`}</Link>
            ))}
          </View>
        ))}
        {view.notes.map((note) => {
          const name = `${KIND_LABEL[note.kind]} note, ${datesLine(note)}`;
          return (
            <View key={note.id} style={styles.item}>
              <Small white>{`Your note: ${noteWords(note)}.`}</Small>
              <Mono>{noteLine(note)}</Mono>
              {note.detail === null ? null : <Small>{note.detail}</Small>}
              {note.canEdit ? (
                <Actions>
                  <Button variant="link" label="Edit" accessibilityLabel={`Edit ${name}`} {...ro} onPress={() => { props.onEdit(note); }} />
                  <Button variant="link" label="Delete" accessibilityLabel={`Delete ${name}`} {...ro} onPress={() => { props.onDelete(note); }} />
                </Actions>
              ) : null}
            </View>
          );
        })}
        {view.rules.map((rule) => (
          <View key={rule.id} style={styles.item}>
            <Small white>{`Your rule: ${rule.text}`}</Small>
            {rule.scheduleSummary === null || rule.scheduleSummary === undefined ? null : <Mono>{rule.scheduleSummary}</Mono>}
          </View>
        ))}
        {view.rules.length === 0 ? null : (
          <Actions>
            <LinkButton href={props.rulesHref} label="Open business rules" />
          </Actions>
        )}
        {view.imported.map((event) => (
          <View key={event.uid} style={styles.item}>
            <Small white>{`From your calendar: ${event.title}`}</Small>
            <Mono>{importedLine(event)}</Mono>
            <Actions>
              <Button variant="link" label="Make a note" accessibilityLabel={`Make a note from ${event.title}`} {...ro} onPress={() => { props.onMakeNote(event); }} />
            </Actions>
          </View>
        ))}
        {view.imported.length === 0 ? null : <Small>Events from your calendar don’t change the forecast until you make a note from them.</Small>}
      </Part>
      {readOnlyId === null ? null : <ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} />}
      {props.form ?? (
        <Actions>
          <Button label="Add an event" {...ro} onPress={props.onAdd} />
        </Actions>
      )}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[5], minWidth: 0 },
  part: { gap: theme.space[2], minWidth: 0 },
  lead: { ...theme.type.sub, color: c.white },
  value: { ...theme.type.monoUi, fontSize: 22, lineHeight: 28, fontWeight: 500, color: c.white, fontVariant: ['tabular-nums'] },
  list: { gap: theme.space[3] },
  item: { gap: 2, minWidth: 0 },
  source: { ...theme.type.mono, color: c.text2, paddingVertical: 14, textDecorationLine: 'underline', textDecorationColor: c.line },
  effect: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2], minWidth: 0 },
  words: { flex: 1, minWidth: 0 },
  // Inside the effect's sentence: the sentence's own type, so the line keeps its height, with a 44px target on web.
  inlineSource: { ...inlineTarget, color: c.text2, textDecorationLine: 'underline', textDecorationColor: c.line },
});
