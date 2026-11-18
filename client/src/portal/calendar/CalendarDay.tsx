import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatCount } from '../format';
import { noteWords } from '../analytics/panel';
import { eventLine } from '../analytics/week';
import type { Note } from '../locations/api';
import { Loading } from '../locations/parts';
import { datesLine, hoursLine, KIND_LABEL, weekdaysLine } from '../locations/noteRules';
import { Actions, Button, LinkButton, type ButtonProps } from '../ui/Button';
import { Notice, ReadOnlyLine } from '../ui/feedback';
import type { PopoverAnchor } from '../ui/Popover';
import { SourceChips } from '../ui/SourceChip';
import { Heading, Mono, Small } from '../ui/text';
import { forecastLabel, forecastWords, type CalendarDayView, type EffectGrade, type EffectMark, type ImportedEvent, type ReasonLine } from './model';

// The Calendar's day panel (P28, spec 16.3): a region "Selected day", beside the grid from 1024px and under it below.
// Top to bottom: the day; its Forecast (the published figure and range, what the notes changed, a booked or closed day,
// a past day's guests against the model, or why there is none); Why (one row per reason, from the largest rise to the
// largest fall, model.ts inOrder: its label, then what it does to guests in words after a ▲ or ▼ in its grade's color
// on the theme's effect ramp, or a = in text2, which screen readers skip, then its sources as chips, ui/SourceChip.tsx,
// on their own wrapping line); On the calendar (the holidays, town events and term dates Why doesn't already name, with
// their sources as chips, the day's notes with Edit and Delete where the API allows, the business rules whose schedule
// covers the day with their summary and a link to Rules, where they are changed (D31), events from the location's
// calendars (D33) with Make a note); then Add an event. Add an event, a note's Edit and an event's Make a note each
// hand the page the button that was pressed, which anchors the page's note form popover (refine-calendar-and-home
// design decision 2), so the panel never changes shape while the form is open. Under view-as the writes are disabled in
// place with the read-only line. It reads and writes nothing itself: the page owns the reads, the form and the dialog.

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

/** A button that hands its own host to `onPress`, so the popover it opens is anchored to it. */
function Opener(props: Omit<ButtonProps, 'ref' | 'onPress'> & { onPress: (anchor: PopoverAnchor) => void }): React.JSX.Element {
  const { onPress, ...button } = props;
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  return <Button {...button} ref={ref} onPress={() => { onPress(ref); }} />;
}

/**
 * A reason's ▲ or ▼ in its grade's color, or = in text2, hidden from screen readers, which hear the same in the words
 * after it (forecast-why). Home's day detail shows it too.
 */
export function ReasonMark(props: { mark: EffectMark; grade: EffectGrade | null }): React.JSX.Element {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Small style={props.grade === null ? null : grades[props.grade]}>{props.mark}</Small>
    </View>
  );
}

/**
 * One reason under Why: its label, then what it does in words after its mark (ReasonMark), then its sources as chips on
 * their own wrapping line.
 */
function WhyRow(props: { reason: ReasonLine }): React.JSX.Element {
  const { reason } = props;
  return (
    <View role="listitem" style={styles.item}>
      <Small white>{reason.label}</Small>
      {reason.detail === null ? null : (
        <View style={styles.effect}>
          {reason.mark === null ? null : <ReasonMark mark={reason.mark} grade={reason.grade} />}
          <Small style={styles.words}>{reason.detail}</Small>
        </View>
      )}
      <SourceChips sources={reason.sources} />
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
  /** Opens the note form for a new note, anchored to "Add an event". */
  onAdd: (anchor: PopoverAnchor) => void;
  /** Opens the note form on `note`, anchored to its Edit. */
  onEdit: (note: Note, anchor: PopoverAnchor) => void;
  onDelete: (note: Note) => void;
  /** Opens the note form from an event in one of the location's calendars (D33), anchored to its Make a note. */
  onMakeNote: (event: ImportedEvent, anchor: PopoverAnchor) => void;
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
      <Part label={forecastLabel(view.forecast)}>
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
          {view.moreRules === 0 ? null : <Small>{`+${formatCount(view.moreRules)} more of your rules`}</Small>}
        </Part>
      )}
      <Part label="On the calendar">
        {nothing ? <Small>{nothingWords}</Small> : null}
        {view.events.map((event) => (
          <View key={event.id} style={styles.item}>
            <Small white>{eventLine(event)}</Small>
            <SourceChips sources={event.sources} />
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
                  <Opener variant="link" label="Edit" accessibilityLabel={`Edit ${name}`} {...ro} onPress={(anchor) => { props.onEdit(note, anchor); }} />
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
          <View key={`${event.calendarId}:${event.uid}`} style={styles.item}>
            <Small white>{`From your calendar: ${event.title}`}</Small>
            <Mono>{importedLine(event)}</Mono>
            <Actions>
              <Opener
                variant="link"
                label="Make a note"
                accessibilityLabel={`Make a note from ${event.title}`}
                {...ro}
                onPress={(anchor) => { props.onMakeNote(event, anchor); }}
              />
            </Actions>
          </View>
        ))}
        {view.imported.length === 0 ? null : <Small>Events from your calendar don’t change the forecast until you make a note from them.</Small>}
      </Part>
      {readOnlyId === null ? null : <ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} />}
      <Actions>
        <Opener label="Add an event" {...ro} onPress={props.onAdd} />
      </Actions>
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
  effect: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2], minWidth: 0 },
  words: { flex: 1, minWidth: 0 },
});

/** The effect ramp's color for each grade (theme.ts). */
const grades = StyleSheet.create({
  up1: { color: c.effectUp1 }, up2: { color: c.effectUp2 }, up3: { color: c.effectUp3 },
  down1: { color: c.effectDown1 }, down2: { color: c.effectDown2 }, down3: { color: c.effectDown3 },
});
