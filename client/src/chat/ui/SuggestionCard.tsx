import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { openAsAdminOrgId } from '../../portal/api';
import { usePortal } from '../../portal/PortalProvider';
import { EFFECT_LABEL, guestsLine, guestsOf, hoursLine } from '../../portal/locations/noteRules';
import { Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { FormField } from '../../portal/ui/FormField';
import { Eyebrow, Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import { isCalendarChange, type EventChoice, type Suggestion } from '../api';
import { dayText, formatCount, KIND_LABEL, rangeText, weekdaysText } from '../format';
import type { AgentPanelState, Decided } from '../useAgentPanel';

// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions, spec P25): each Monday a pass reads the
// next 3 months of the town's calendar with the location's notes and rules and suggests notes or business rules. A
// card asks the question, gives TownwiseAI's one-sentence why, what Accept saves (a rule's schedule; a note's effect,
// guests, hours and detail) and the calendar entries it rests on, and offers Accept and Dismiss to org admins only;
// members see the card without them. Nothing changes the forecast until an admin accepts. Under the cards, the
// organization's switch with its words: admins turn it off or on, members see its state.
//
// The location's own calendars (openspec change calendar-event-suggestions, design decisions 9, 10 and 15) add three
// kinds, whose sentence (`words`) the server writes: a private event the weekly pass spotted on a calendar, whose card
// asks the admin to choose the whole restaurant (a buyout) or alongside regular service, a radio group with neither
// chosen, and the guest count, prefilled from the event's title when it gave one; Accept stays disabled, saying why,
// until a choice is made and, alongside regular service, a count is given. And the follow-ups of a note made from an
// event that moved or went, which list in their own section, "Your calendar changed", before the suggestions. Beside
// the weekly switch, the organization's switch for reading the calendars' event titles: admins turn it off or on (staff
// open as admin only off), members see its state.

/** The switch's words (spec P25), with the town's name. */
export function weeklyWords(town: string): string {
  return `Once a week TownwiseAI reads the next 3 months of ${town}’s calendar with your notes and rules, and suggests notes or rules for you to accept. It sends them to Anthropic and uses this organization’s TownwiseAI budget.`;
}

/**
 * The titles switch's words (calendar-event-suggestions design decision 9). [CONFIRM: the switch's words]
 */
export const TITLES_WORDS = 'Read your calendars’ event titles. Once a week TownwiseAI also reads the titles, dates and hours of the next 3 months of events on this location’s calendars, to suggest notes for private events. They are sent to Anthropic, which doesn’t train on them.';

/** A spotted event's two choices, neither chosen until the admin picks one. */
const EVENT_CHOICES: readonly { value: EventChoice['effect']; label: string }[] = [
  { value: 'closed', label: 'The whole restaurant (a buyout)' },
  { value: 'more_guests', label: 'Alongside regular service' },
];
const EVENT_CHOICE_LEGEND = 'How this event runs';

/** The days a suggestion names: "Thu, Nov 26, 2026", "Dec 24 to Dec 26, 2026", with its weekdays and an open end. */
function daysOf(startDate: string, endDate: string | null, weekdays: readonly number[] | null): string {
  const dates = endDate === null ? `from ${dayText(startDate)} on` : startDate === endDate ? dayText(startDate) : rangeText(startDate, endDate);
  const which = weekdaysText(weekdays);
  return which === null ? dates : `${which.replace(/ only$/, '')}, ${dates}`;
}

/**
 * What a note of kind other is, by its effect: "Other on Thu, Dec 31?" asks nothing an admin can answer. Null for
 * every other kind, which its kind names.
 */
function otherWords(note: Extract<Suggestion, { type: 'note' }>['note']): string | null {
  if (note.kind !== 'other') return null;
  return note.effect === 'unknown' ? 'Something unusual' : EFFECT_LABEL[note.effect];
}

/** The card's question. A follow-up's and a spotted event's read from the note's kind and dates, never a title. */
export function suggestionHeading(suggestion: Suggestion): string {
  if (suggestion.type === 'rule') return `Add the rule “${suggestion.text}”?`;
  const { note } = suggestion;
  const days = daysOf(note.startDate, note.endDate, note.weekdays);
  if (suggestion.type === 'event') return `A private event on ${days}?`;
  if (suggestion.type === 'move') return `Move the note to ${days}?`;
  if (suggestion.type === 'remove') return `Delete the note on ${days}?`;
  if (note.kind === 'closure' || (note.effect === 'closed' && note.kind !== 'private_event')) return `Closed on ${days}?`;
  if (note.kind === 'private_event' && note.effect === 'closed') {
    return note.expectedGuests === null ? `Booked for a private party on ${days}?` : `Booked for a private party of ${formatCount(note.expectedGuests)} on ${days}?`;
  }
  if (note.kind === 'private_event' && note.expectedGuests !== null) return `A private event of ${formatCount(note.expectedGuests)} guests on ${days}?`;
  return `${otherWords(note) ?? KIND_LABEL[note.kind]} on ${days}?`;
}

/**
 * What a note suggestion saves beyond its heading, in the notes list's words (P14): "More guests than usual. About 220
 * guests. 6 pm to 9 pm." A closed effect, and an other note's effect, are left out, since the heading says them. Null
 * when there is nothing more.
 */
export function suggestionFacts(suggestion: Suggestion): string | null {
  // A spotted event's effect and guests are the admin's to choose, on the card.
  if (suggestion.type === 'rule' || suggestion.type === 'event') return null;
  const { note } = suggestion;
  const parts = [note.effect === 'closed' || note.kind === 'other' ? null : EFFECT_LABEL[note.effect], guestsLine(note.expectedGuests), hoursLine(note)]
    .filter((part) => part !== null);
  return parts.length === 0 ? null : `${parts.join('. ')}.`;
}

/** What Accept does, and who can press it. */
export function suggestionHelp(suggestion: Suggestion, canChange: boolean): string {
  if (!canChange) return 'An admin of your organization can accept or dismiss this.';
  switch (suggestion.type) {
    case 'rule': return 'Accept adds this business rule, and the forecast uses its schedule from then on. Dismiss and TownwiseAI won’t suggest it again.';
    case 'event': return 'Accept saves a private-event note for these days, and the forecast uses it from then on. Dismiss and TownwiseAI won’t ask about this event again.';
    case 'move': return 'Accept moves the note to the event’s new dates and hours, and leaves the rest of it as it is. Dismiss keeps the note where it is.';
    case 'remove': return 'Accept deletes the note, and the forecast stops using it. Dismiss keeps the note.';
    case 'note': return 'Accept saves this note, and the forecast uses it from then on. Dismiss and TownwiseAI won’t suggest it again.';
  }
}

/**
 * Why a spotted event's Accept is disabled, or null once it can be pressed: a choice is needed, and alongside regular
 * service a guest count (the API refuses none, since it would change no forecast); a count, when given, is 1 to 20,000.
 */
export function eventAcceptBlock(effect: EventChoice['effect'] | null, guests: string): string | null {
  if (effect === null) return 'Choose how this event runs to accept it.';
  const count = guestsOf(guests);
  if (count === 'invalid') return 'Enter the guests as a whole number from 1 to 20,000 to accept it.';
  if (effect === 'more_guests' && count === null) return 'Enter the guests to accept it alongside regular service.';
  return null;
}

/** What the decision did. */
export function decidedLine(suggestion: Suggestion, decided: Decided): string {
  if (decided.status === 'dismissed') return isCalendarChange(suggestion) ? 'Dismissed. The note stays as it is.' : 'Dismissed. TownwiseAI won’t suggest it again.';
  if (suggestion.type === 'rule') return `Added the business rule “${suggestion.text}”.`;
  const { note } = suggestion;
  const days = daysOf(note.startDate, note.endDate, note.weekdays);
  if (suggestion.type === 'move') return `Moved the note to ${days}.`;
  if (suggestion.type === 'remove') return 'Deleted the note.';
  return `Saved a note: ${otherWords(note) ?? KIND_LABEL[note.kind]}, ${days}.`;
}

/** The card's sentence under its question: TownwiseAI's why on a note or rule, the server's words on the other kinds. */
function sentenceOf(suggestion: Suggestion): string {
  return suggestion.type === 'note' || suggestion.type === 'rule' ? suggestion.why : suggestion.words;
}

/** "Based on Commencement (Jun 14)". Null when it names none. */
function basedOn(suggestion: Suggestion): string | null {
  if (suggestion.calendar.length === 0) return null;
  return `Based on ${suggestion.calendar.map((entry) => `${entry.title} (${entry.start === entry.end ? dayText(entry.start) : rangeText(entry.start, entry.end)})`).join(', ')}.`;
}

type Host = React.ComponentRef<typeof View>;

/**
 * A spotted event's two choices: a radio group with neither checked at first (the arrow keys and Space choose on web,
 * with one tab stop, on the checked choice or the first while none is).
 */
function EventChoiceGroup(props: {
  value: EventChoice['effect'] | null;
  onChange: (value: EventChoice['effect']) => void;
  disabled: boolean;
  describedBy: string | undefined;
}): React.JSX.Element {
  const refs = useRef<(Host | null)[]>([]);
  const { disabled } = props;
  function onKeyDown(event: { key: string; preventDefault: () => void }): void {
    if (disabled) return;
    const focused = refs.current.findIndex((element) => element !== null && element === (document.activeElement as unknown));
    const at = focused === -1 ? EVENT_CHOICES.findIndex((choice) => choice.value === props.value) : focused;
    if (event.key === ' ' || event.key === 'Enter') {
      const here = EVENT_CHOICES[at];
      if (here === undefined) return;
      event.preventDefault();
      props.onChange(here.value);
      return;
    }
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!forward && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = (Math.max(at, 0) + (forward ? 1 : EVENT_CHOICES.length - 1)) % EVENT_CHOICES.length;
    const next = EVENT_CHOICES[index];
    if (next === undefined) return;
    props.onChange(next.value);
    (refs.current[index] as unknown as { focus?: () => void } | null)?.focus?.();
  }
  return (
    <View role="radiogroup" aria-label={EVENT_CHOICE_LEGEND} {...(Platform.OS === 'web' ? ({ onKeyDown } as object) : {})} style={styles.choices}>
      <Text style={styles.legend}>{EVENT_CHOICE_LEGEND}</Text>
      <View style={styles.answers}>
        {EVENT_CHOICES.map((choice, index) => {
          const on = choice.value === props.value;
          const tabStop = on || (props.value === null && index === 0);
          return (
            <Pressable
              key={choice.value}
              ref={(element) => { refs.current[index] = element; }}
              role="radio"
              accessibilityState={{ checked: on, disabled }}
              {...(Platform.OS === 'web'
                ? { tabIndex: tabStop && !disabled ? 0 : -1, 'aria-checked': on, 'aria-disabled': disabled || undefined, 'aria-describedby': props.describedBy }
                : { disabled })}
              onPress={() => { if (!disabled) props.onChange(choice.value); }}
              style={[styles.choice, on ? styles.choiceOn : null]}
            >
              <Text style={[styles.choiceLabel, on ? styles.choiceLabelOn : null]}>{choice.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SuggestionCard(props: {
  suggestion: Suggestion;
  panel: AgentPanelState;
  canChange: boolean;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { suggestion, panel } = props;
  const { id } = suggestion;
  const helpId = `suggestion-${id}-help`;
  const decided = panel.decided[id];
  const error = panel.suggestionErrors[id];
  const deciding = panel.deciding === id;
  const off = props.readOnlyId !== null || panel.deciding !== null;
  const based = basedOn(suggestion);
  const facts = suggestionFacts(suggestion);
  const detail = suggestion.type === 'rule' || suggestion.type === 'event' ? null : suggestion.note.detail;
  const describedBy = [props.readOnlyId, helpId].filter((value): value is string => value !== null).join(' ');
  // A spotted event's choice and guest count, prefilled from the event's title when it gave a number.
  const spotted = suggestion.type === 'event';
  const [effect, setEffect] = useState<EventChoice['effect'] | null>(null);
  const [guests, setGuests] = useState(() => (suggestion.type === 'event' && suggestion.note.expectedGuests !== null ? String(suggestion.note.expectedGuests) : ''));
  const block = spotted ? eventAcceptBlock(effect, guests) : null;
  const guestsInvalid = spotted && guestsOf(guests) === 'invalid';
  const decidedLineRef = useRef<Host>(null);
  // A decision pressed on this card moves focus to the line that says what it did (the buttons it pressed are gone), as
  // ProposalCard's save does. Only the card pressed: the same suggestion can also show in the column beside the landing.
  const pressed = useRef(false);
  const isDecided = decided !== undefined;
  useEffect(() => {
    if (isDecided && pressed.current && Platform.OS === 'web') decidedLineRef.current?.focus();
    if (isDecided) pressed.current = false;
  }, [isDecided]);
  function press(decision: 'accept' | 'dismiss'): void {
    pressed.current = true;
    if (decision === 'accept' && spotted) {
      const count = guestsOf(guests);
      if (effect === null || count === 'invalid') return;
      panel.decide(id, decision, { effect, expectedGuests: count });
      return;
    }
    panel.decide(id, decision);
  }
  return (
    <View style={styles.card}>
      <Heading level={3}>{suggestionHeading(suggestion)}</Heading>
      <Text style={styles.context}>{sentenceOf(suggestion)}</Text>
      {suggestion.type === 'rule' ? <Text style={styles.context}>{suggestion.scheduleSummary}</Text> : null}
      {facts === null ? null : <Text style={styles.context}>{facts}</Text>}
      {detail === null ? null : <Text style={styles.context}>{detail}</Text>}
      {based === null ? null : <Text style={styles.help}>{based}</Text>}
      {decided !== undefined ? (
        <View ref={decidedLineRef} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
          <Text style={styles.done}>{decidedLine(suggestion, decided)}</Text>
        </View>
      ) : (
        <>
          {props.canChange && spotted ? (
            <>
              <EventChoiceGroup value={effect} onChange={setEffect} disabled={off} describedBy={props.readOnlyId ?? undefined} />
              <View style={styles.guests}>
                <FormField
                  label="Guests"
                  helper="Needed alongside regular service, optional for a buyout."
                  value={guests}
                  onChangeText={setGuests}
                  keyboardType="number-pad"
                  numeric
                  maxLength={6}
                  readOnly={off}
                  {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })}
                  {...(guestsInvalid ? { messages: ['Enter a whole number from 1 to 20,000.'] } : {})}
                />
              </View>
            </>
          ) : null}
          {props.canChange ? (
            <View role="group" aria-label={suggestionHeading(suggestion)} style={styles.answers}>
              <Button variant="outline" label="Accept" disabled={off || block !== null} describedBy={describedBy} onPress={() => { press('accept'); }} />
              <Button variant="outline" label="Dismiss" disabled={off} describedBy={describedBy} onPress={() => { press('dismiss'); }} />
            </View>
          ) : null}
          <Text nativeID={helpId} style={styles.help}>{deciding ? 'Saving…' : (props.canChange ? block : null) ?? suggestionHelp(suggestion, props.canChange)}</Text>
        </>
      )}
      {error === undefined || decided !== undefined ? null : <ErrorNotice message={error} />}
    </View>
  );
}

/** The switch: its words and a button for admins, its state for members, and a line while the server can't run passes. */
function WeeklySwitch(props: { panel: AgentPanelState; town: string; readOnlyId: string | null }): React.JSX.Element | null {
  const { me } = usePortal();
  const { panel } = props;
  if (panel.state.status !== 'ready') return null;
  const weekly = panel.state.data.weeklySuggestions;
  if (weekly === null) return null;
  const on = panel.weeklyOn ?? weekly.on;
  return (
    <View style={styles.switch}>
      <Text style={styles.body}>
        {weeklyWords(props.town)}{' '}
        <Link href="/privacy" style={styles.link}>Privacy</Link>
      </Text>
      <Text style={styles.body}>{on ? 'Weekly suggestions are on.' : 'Weekly suggestions are off.'}</Text>
      {on && !weekly.available ? <Text style={styles.help}>Weekly suggestions aren’t running right now, so none are being made.</Text> : null}
      {weekly.canChange ? (
        <Button
          variant="outline"
          label={on ? 'Turn off weekly suggestions' : 'Turn on weekly suggestions'}
          disabled={props.readOnlyId !== null || panel.switching}
          {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
          onPress={() => { panel.setWeekly(!on, openAsAdminOrgId(me)); }}
        />
      ) : null}
      {panel.switchError === null ? null : <ErrorNotice message={panel.switchError} />}
    </View>
  );
}

/**
 * The switch for reading the calendars' event titles (calendar-event-suggestions design decision 9), under the weekly
 * one: its words and a button for admins, its state for members. Staff open as admin may turn it off but not on (the
 * organization's own consent), so with it off they get a line that says so instead of a button. None from an API
 * before it.
 */
function TitlesSwitch(props: { panel: AgentPanelState; readOnlyId: string | null }): React.JSX.Element | null {
  const { me } = usePortal();
  const { panel } = props;
  if (panel.state.status !== 'ready') return null;
  const weekly = panel.state.data.weeklySuggestions;
  if (weekly?.calendarTitles === undefined) return null;
  const on = panel.titlesOn ?? weekly.calendarTitles;
  const openAsAdmin = openAsAdminOrgId(me);
  return (
    <View style={styles.switch}>
      <Text style={styles.body}>
        {TITLES_WORDS}{' '}
        <Link href="/privacy" style={styles.link}>Privacy</Link>
      </Text>
      <Text style={styles.body}>{on ? 'Reading event titles is on.' : 'Reading event titles is off.'}</Text>
      {weekly.canChange && (on || openAsAdmin === null) ? (
        <Button
          variant="outline"
          label={on ? 'Turn off reading event titles' : 'Turn on reading event titles'}
          disabled={props.readOnlyId !== null || panel.switchingTitles}
          {...(props.readOnlyId === null ? {} : { describedBy: props.readOnlyId })}
          onPress={() => { panel.setTitles(!on, openAsAdmin); }}
        />
      ) : null}
      {weekly.canChange && openAsAdmin !== null ? (
        <Text style={styles.help}>{on ? 'You can turn this off. Only an admin of this organization can turn it back on.' : 'Only an admin of this organization can turn this on.'}</Text>
      ) : null}
      {panel.titlesError === null ? null : <ErrorNotice message={panel.titlesError} />}
    </View>
  );
}

/** The notice for a card that went when its decision was sent (its event changed): it takes focus on web, as the card's decided line would have. */
function SuggestionsNotice(props: { text: string }): React.JSX.Element {
  const ref = useRef<Host>(null);
  useEffect(() => {
    if (Platform.OS === 'web') ref.current?.focus();
  }, [props.text]);
  return (
    <View ref={ref} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
      <Text style={styles.done}>{props.text}</Text>
    </View>
  );
}

function undecided(panel: AgentPanelState, suggestions: readonly Suggestion[]): number {
  return suggestions.filter((suggestion) => panel.decided[suggestion.id] === undefined).length;
}

/**
 * "Your calendar changed" (the follow-ups of notes whose calendar event moved or went, shown only when there are some),
 * then "Suggested for the next 3 months": the open suggestions, then the switches. Each heading counts its own.
 */
export function SuggestionsSection(props: { panel: AgentPanelState; town: string; readOnlyId: string | null }): React.JSX.Element | null {
  const { panel } = props;
  const { state } = panel;
  if (state.status === 'failed') return null;
  const canChange = state.status === 'ready' && state.data.weeklySuggestions?.canChange === true;
  const all = state.status === 'ready' ? state.data.suggestions : [];
  const changes = all.filter(isCalendarChange);
  const suggested = all.filter((suggestion) => !isCalendarChange(suggestion));
  const cards = (list: readonly Suggestion[]): React.ReactNode => list.map((suggestion) => (
    <SuggestionCard key={suggestion.id} suggestion={suggestion} panel={panel} canChange={canChange} readOnlyId={props.readOnlyId} />
  ));
  let body: React.ReactNode;
  if (state.status === 'loading') body = <LoadingLine text="Loading suggestions" minHeight={80} />;
  else if (suggested.length === 0) body = <Text style={styles.muted}>No suggestions right now.</Text>;
  else body = cards(suggested);
  return (
    <>
      {changes.length === 0 ? null : (
        <View style={styles.section}>
          <View style={styles.head}>
            <Eyebrow>{`${formatCount(undecided(panel, changes))} to decide`}</Eyebrow>
            <Heading>Your calendar changed</Heading>
          </View>
          {cards(changes)}
        </View>
      )}
      <View style={styles.section}>
        <View style={styles.head}>
          {state.status === 'ready' ? <Eyebrow>{`${formatCount(undecided(panel, suggested))} to decide`}</Eyebrow> : null}
          <Heading>Suggested for the next 3 months</Heading>
        </View>
        {panel.suggestionsNotice === null ? null : <SuggestionsNotice text={panel.suggestionsNotice} />}
        {body}
        <WeeklySwitch panel={panel} town={props.town} readOnlyId={props.readOnlyId} />
        <TitlesSwitch panel={panel} readOnlyId={props.readOnlyId} />
      </View>
    </>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  section: { gap: theme.space[3] },
  head: { gap: theme.space[1] },
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  context: { ...theme.type.small, color: c.text2 },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2], alignItems: 'flex-start' },
  help: { ...theme.type.small, color: c.text3 },
  done: { ...theme.type.small, color: c.white },
  muted: { ...theme.type.small, color: c.text3, flexShrink: 1 },
  // A spotted event's choices, in the look of MetricSwitch's radio group.
  choices: { gap: theme.space[2], minWidth: 0 },
  legend: { ...theme.type.ui, color: c.white },
  choice: {
    minHeight: 44, minWidth: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    borderColor: c.line, backgroundColor: 'transparent', flexShrink: 1, maxWidth: '100%',
  },
  choiceOn: { backgroundColor: c.mint, borderColor: c.mint },
  choiceLabel: { ...theme.type.ui, color: c.white },
  choiceLabelOn: { color: c.onMint },
  guests: { maxWidth: 240 },
  switch: { gap: theme.space[2], alignItems: 'flex-start' },
  body: { ...theme.type.small, color: c.text2 },
  link: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
});
