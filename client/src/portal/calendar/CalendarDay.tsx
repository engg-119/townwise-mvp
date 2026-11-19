import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { ResearchedEvent } from '../analytics/api';
import { formatCount } from '../format';
import { noteWords } from '../analytics/panel';
import { eventLine } from '../analytics/week';
import type { Note } from '../locations/api';
import { Loading } from '../locations/parts';
import { datesLine, hoursLine, KIND_LABEL, weekdaysLine } from '../locations/noteRules';
import {
  EDITED_LINE, FOUND_ACTIONS, FOUND_LABEL, FOUND_NOTE, foundActionLabel, foundChips, foundLine, whereWho,
} from '../research/copy';
import { itemHref } from '../routing';
import { Actions, Button, LinkButton, type ButtonProps } from '../ui/Button';
import { Notice, ReadOnlyLine } from '../ui/feedback';
import { useFocusFallback } from '../ui/messageFocus';
import type { PopoverAnchor } from '../ui/Popover';
import { AppChip, SourceChips } from '../ui/SourceChip';
import { Heading, Mono, Small } from '../ui/text';
import { FIGURE_KEY, forecastLabel, forecastWords, type CalendarDayView, type EffectGrade, type EffectMark, type ImportedEvent, type ReasonLine } from './model';

// The Calendar's day panel (P28, spec 16.3): a region "Selected day", beside the grid from 1024px and under it below.
// Top to bottom: the day; its Forecast (the published figure and range, what the notes changed, a booked or closed day,
// a past day's guests against the model, or why there is none); Why (one row per reason, from the largest rise to the
// largest fall, model.ts inOrder: its label, then what it does to guests in words after a ▲ or ▼ in its grade's color
// on the theme's effect ramp, or a = in text2, which screen readers skip, then its sources as chips, ui/SourceChip.tsx,
// on their own wrapping line); On the calendar (the holidays, town events and term dates Why doesn't already name, with
// their sources as chips, the day's notes with Edit and Delete where the API allows, the business rules whose schedule
// covers the day with their summary and a link to Rules, where they are changed (D31), a note made from one of the
// location's calendar events saying "Made from a calendar event" with no title (calendar-event-suggestions), events from the location's
// calendars (D33) with Make a note); then Add an event. Add an event, a note's Edit and an event's Make a note each
// hand the page the button that was pressed, which anchors the page's note form popover (refine-calendar-and-home
// design decision 2), so the panel never changes shape while the form is open. Under view-as the writes are disabled in
// place with the read-only line. It reads and writes nothing itself: the page owns the reads, the form and the dialog.
// Each entry keeps its source, with no dedupe (D49): a note shows its event name, then its kind words and detail, and a
// note TownwiseAI made from a file a "Your file" chip to that file's item while its ref exists; an imported event ends
// with a chip to its calendar's page in Your data (`c_<calendarId>`), named by the calendar's own label.
// Last, "Found by research" (D66, design decision 15): each event town research found on the day, with its dates, where
// and who, an Unconfirmed chip for a low-confidence finding and a Cancelled one, its sources, Edit (the page's edit
// sheet, anchored to it), Hide and Ask TownwiseAI, and on an edited one "Edited by your team" with Reset. Under view-as
// Edit, Hide and Reset are not shown (the route refuses view-as); Ask TownwiseAI is, since the chat page reads.

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

/** One found event in the day panel (see the top of this file). */
function FoundRow(props: {
  event: ResearchedEvent;
  readOnly: boolean;
  pending: boolean;
  onEdit: (anchor: PopoverAnchor) => void;
  onAction: (op: 'hide' | 'restore') => void;
  onAsk: () => void;
}): React.JSX.Element {
  const { event } = props;
  const place = whereWho(event);
  const chips = foundChips(event);
  const busy = props.pending ? { disabled: true } : {};
  return (
    <View style={styles.item}>
      <Small white>{event.title}</Small>
      <Mono>{foundLine(event)}</Mono>
      {place === null ? null : <Small>{place}</Small>}
      {chips.length === 0 ? null : <View style={styles.chips}>{chips.map((chip) => <Mono key={chip} tone="white">{chip}</Mono>)}</View>}
      <SourceChips sources={event.sources} />
      {event.edited ? (
        <View style={styles.effect}>
          <Small>{EDITED_LINE}</Small>
          {props.readOnly ? null : (
            <Button variant="link" label={FOUND_ACTIONS.reset} accessibilityLabel={foundActionLabel('reset', event.title)} {...busy} onPress={() => { props.onAction('restore'); }} />
          )}
        </View>
      ) : null}
      <Actions>
        {props.readOnly ? null : (
          <Opener variant="link" label={FOUND_ACTIONS.edit} accessibilityLabel={foundActionLabel('edit', event.title)} {...busy} onPress={props.onEdit} />
        )}
        {props.readOnly ? null : (
          <Button variant="link" label={FOUND_ACTIONS.hide} accessibilityLabel={foundActionLabel('hide', event.title)} {...busy} onPress={() => { props.onAction('hide'); }} />
        )}
        <Button variant="link" label={FOUND_ACTIONS.ask} accessibilityLabel={foundActionLabel('ask', event.title)} onPress={props.onAsk} />
      </Actions>
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
  /** For the chips to a calendar's page and a file's item in Your data. */
  locationId: string;
  notice: string | null;
  /** The action the notice is for (Notice's `result`): one object per save or delete. */
  noticeResult?: object | null;
  /** The notice says a write did not happen, so it stays in the panel (Notice's `stays`). */
  noticeStays?: boolean;
  readOnlyId: string | null;
  readOnlyText: string;
  /** Opens the note form for a new note, anchored to "Add an event". */
  onAdd: (anchor: PopoverAnchor) => void;
  /** Opens the note form on `note`, anchored to its Edit. */
  onEdit: (note: Note, anchor: PopoverAnchor) => void;
  onDelete: (note: Note) => void;
  /** Opens the note form from an event in one of the location's calendars (D33), anchored to its Make a note. */
  onMakeNote: (event: ImportedEvent, anchor: PopoverAnchor) => void;
  /** Opens the edit sheet on a found event (D66), anchored to its Edit. */
  onEditFound: (event: ResearchedEvent, anchor: PopoverAnchor) => void;
  /** Hide, or Reset (a restore to what research found), sent with the event's head. */
  onFoundAction: (event: ResearchedEvent, op: 'hide' | 'restore') => void;
  /** Opens TownwiseAI on a new conversation with a draft about the event. */
  onAskFound: (event: ResearchedEvent) => void;
  /** The found event whose Hide or Reset is out: its buttons wait. */
  foundPending?: string | null;
}): React.JSX.Element {
  const { view, readOnlyId } = props;
  // When a save took the focused control away, the panel takes focus in place of the notice, which is a toast.
  const fallback = useFocusFallback<React.ComponentRef<typeof View>>();
  if (view === null) {
    return <View role="region" aria-label="Selected day" nativeID={PANEL_ID} {...fallback} style={styles.root}><Loading text="Loading the day" minHeight={120} /></View>;
  }
  const words = forecastWords(view.forecast, props.locationName);
  const label = forecastLabel(view.forecast);
  // The figure's kind in words, unless the part's label already says it (UI review S2): an outlook keeps “Forecast”.
  const figureKey = words.figure === null || FIGURE_KEY[words.figure.source] === label ? null : FIGURE_KEY[words.figure.source];
  const ro = readOnlyId === null ? null : { disabled: true, describedBy: readOnlyId };
  const nothing = view.events.length === 0 && view.notes.length === 0 && view.rules.length === 0 && view.imported.length === 0
    && view.researched.length === 0;
  const nothingWords = view.shownInWhy > 0 ? 'Nothing else on the calendar this day.' : 'Nothing on the calendar this day.';
  return (
    <View role="region" aria-label="Selected day" nativeID={PANEL_ID} {...fallback} style={styles.root}>
      <Heading>{view.heading}</Heading>
      {props.notice === null ? null : <Notice text={props.notice} stays={props.noticeStays === true} {...(props.noticeResult == null ? {} : { result: props.noticeResult })} />}
      <Part label={label}>
        {words.figure === null ? null : (
          <View style={styles.item}>
            {/* Actual or forecast, in words, over the figure in its tone (D49, design decision 10). */}
            {figureKey === null ? null : <Mono>{figureKey}</Mono>}
            <Text style={[styles.lead, words.figure.source === 'forecast' ? styles.forecast : null]}>
              {words.figure.before === '' ? '' : `${words.figure.before} `}
              <Text style={[styles.value, words.figure.source === 'forecast' ? styles.forecast : null]}>{words.figure.value}</Text>
              {` ${words.figure.after}`}
            </Text>
          </View>
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
              {/* A person's own title ends with no full stop of ours (UI review nit 11); kind words do. */}
              <Small white>{note.title === null || note.title === undefined ? `Your note: ${noteWords(note)}.` : `Your note: ${note.title}`}</Small>
              {note.title === null || note.title === undefined ? null : <Small>{noteWords(note)}</Small>}
              <Mono>{noteLine(note)}</Mono>
              {note.fromEvent === null || note.fromEvent === undefined ? null : <Small>Made from a calendar event</Small>}
              {note.detail === null ? null : <Small>{note.detail}</Small>}
              {note.source?.ref ? (
                <AppChip href={itemHref(props.locationId, note.source.ref)} name="Your file" label="Your file. Opens it in Your data" glyph="file" />
              ) : null}
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
            <AppChip
              href={itemHref(props.locationId, `c_${event.calendarId}`)}
              name={event.calendar ?? 'Your calendar'}
              label={`${event.calendar ?? 'Your calendar'}. Opens this calendar in Your data`}
              glyph="calendar"
            />
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
        {view.researched.length === 0 ? null : <Mono tone="text3">{FOUND_LABEL}</Mono>}
        {view.researched.map((event) => (
          <FoundRow
            key={event.id}
            event={event}
            readOnly={readOnlyId !== null}
            pending={props.foundPending === event.id}
            onEdit={(anchor) => { props.onEditFound(event, anchor); }}
            onAction={(op) => { props.onFoundAction(event, op); }}
            onAsk={() => { props.onAskFound(event); }}
          />
        ))}
        {view.researched.length === 0 ? null : <Small>{FOUND_NOTE}</Small>}
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
  forecast: { color: c.text2 },
  list: { gap: theme.space[3] },
  item: { gap: 2, minWidth: 0 },
  effect: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2], minWidth: 0 },
  words: { flex: 1, minWidth: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[3] },
});

/** The effect ramp's color for each grade (theme.ts). */
const grades = StyleSheet.create({
  up1: { color: c.effectUp1 }, up2: { color: c.effectUp2 }, up3: { color: c.effectUp3 },
  down1: { color: c.effectDown1 }, down2: { color: c.effectDown2 }, down3: { color: c.effectDown3 },
});
