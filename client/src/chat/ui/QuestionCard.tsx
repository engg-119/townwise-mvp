import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import type { Note } from '../../portal/locations/api';
import { guestsOf } from '../../portal/locations/noteRules';
import { Button } from '../../portal/ui/Button';
import { ErrorNotice, Messages } from '../../portal/ui/feedback';
import { FormField } from '../../portal/ui/FormField';
import { Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { Question, QuestionAnswer } from '../api';
import { dayText, formatCount, KIND_LABEL, rangeText, shortDayText, weekdayName, weekdaysText } from '../format';
import type { AgentPanelState, Answered, QuestionPlace, SendToChat } from '../useAgentPanel';
import { TELL_BUDGET, type TuningChatState } from '../useTuningChat';
import { MAX_MESSAGE } from './Composer';
import { ChatButton, type ChatButtonHandle } from './controls';

// A question TownwiseAI has for the person (spec P25, 10.12): asked by rules over the location's own sales and
// notes, never by an estimate (D46: a weekday with no sales is a suggested rule now, RuleSuggestionCard). A heading question, one line of the evidence it saw (counts and guests, never sales),
// the answers, and a line saying what an answer does. Once answered, the answers give way to what the answer did.
//
// The fourth answer, Something else… (shown while TownwiseAI's chat is on), opens a field of the card's own; pressed
// again it folds the field and keeps the words, and Cancel drops them. Send puts the question and its evidence before
// the person's words and sends that to TownwiseAI as a chat message, in the conversation shown; only once that turn is
// saved is the question answered `other`, with no words. A turn that isn't saved answers nothing, and the card keeps
// the words with the chat's reason. The panel and the chat's landing can both show a card, sharing its state
// (useAgentPanel); only the copy the person used announces its answer or error.
//
// D71: a past private event with no guest count asks how many guests came (each day, for a note over several days): a
// Guests field, Save (only for a whole count from 1 to 20,000) and Skip. Save writes the count into the event's note, so
// Townwise takes those guests off the day when it learns; Skip asks no more. The field's text is the card's own, and
// its name carries the card's dates, so two cards' fields are told apart. Once saved, the context drops "no guest count
// yet". The first of two counts wins: a card whose count lost to one saved elsewhere (or a Skip) says so. A Save the API
// turns away with 404 (the note got a count elsewhere, or went) reads the panel again and the notice says the count
// wasn't saved. After an answer, focus moves to what the answer did (web), in the copy the person used.

const SOMETHING_ELSE = 'Something else…';
/** D71. [CONFIRM: the private event question's help line] */
const PARTY_HELP_ONE = 'Townwise takes these guests off that day when it learns from your sales, so the event isn’t read as a normal busy day.';
const PARTY_HELP_MANY = 'Townwise takes these guests off each of those days when it learns from your sales, so the event isn’t read as a normal busy day.';
const ELSE_HELP = 'Something else lets you tell TownwiseAI in the chat.';

export interface QuestionCopy {
  heading: string;
  context: string;
  answers: { value: QuestionAnswer; label: string }[];
  help: string;
}

/** Something else…'s view of the chat. */
export interface QuestionChat {
  /** A reply is streaming, or a conversation or a version is loading: Something else… waits. */
  busy: boolean;
  /** This month's budget is used up. */
  exhausted: boolean;
}

/** Null while TownwiseAI's chat is off or unread: then no card offers Something else…. */
export function questionChatOf(state: TuningChatState): QuestionChat | null {
  if (state.status !== 'ready' || !state.enabled) return null;
  return { busy: state.streaming || state.switching || state.conversationLoading, exhausted: state.budget?.exhausted === true };
}

function days(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'day' : 'days'}`;
}

/** The plural weekday a date falls on ("Mondays"). */
function weekdaysOf(date: string): string {
  return weekdayName(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

/** A gap's usual guests, "about 100 guests" or "about 80 to 120 guests"; null from an API that sends none. */
function usualGuests(question: Extract<Question, { kind: 'gap' }>): string | null {
  const { typicalGuestsLow: low, typicalGuestsHigh: high } = question;
  if (low === undefined || high === undefined) return null;
  return low === high ? `about ${formatCount(low)} guests` : `about ${formatCount(low)} to ${formatCount(high)} guests`;
}

function sentences(parts: readonly (string | false)[]): string {
  return parts.filter((part): part is string => part !== false).join(' ');
}

/** The ids a control is described by, joined; empty for none. */
function joined(...values: readonly (string | null | false)[]): string {
  return values.filter((value): value is string => typeof value === 'string').join(' ');
}

/** D71: whether a private event's question covers more than one day, so it asks for each day's guests. */
function eachDay(question: Extract<Question, { kind: 'party_guests' }>): boolean {
  return question.startDate !== question.endDate;
}

/** D71: "On Fridays only." for a note over several days that names weekdays. */
function partyWeekdays(question: Extract<Question, { kind: 'party_guests' }>): string | false {
  const weekdays = weekdaysText(question.weekdays);
  return eachDay(question) && weekdays !== null && `On ${weekdays.replace(/ only$/, '')} only.`;
}

/** D71: the context once a count is saved, without "Its note has no guest count yet." (empty for none). */
function savedPartyContext(question: Question, answered: Answered | undefined): string | null {
  if (question.kind !== 'party_guests' || answered?.answer !== 'guests') return null;
  return sentences([partyWeekdays(question)]);
}

/**
 * The words of a card. `chat`: TownwiseAI's chat is on, so Something else… is offered (never on a private event's
 * question, D71, whose answers are Save and Skip: `answers` holds Skip only).
 */
export function questionCopy(question: Question, locationName: string, chat: boolean): QuestionCopy {
  const other = chat ? [{ value: 'other' as const, label: SOMETHING_ELSE }] : [];
  if (question.kind === 'party_guests') {
    // [CONFIRM: the private event question's heading and context]
    const many = eachDay(question);
    return {
      heading: many
        ? `How many guests came for the private event each day from ${rangeText(question.startDate, question.endDate)}?`
        : `How many guests came for the private event on ${dayText(question.startDate)}?`,
      context: sentences([partyWeekdays(question), 'Its note has no guest count yet.']),
      answers: [{ value: 'not_sure', label: 'Skip' }],
      help: many ? PARTY_HELP_MANY : PARTY_HELP_ONE,
    };
  }
  if (question.kind === 'likely_closed') {
    const usual = `${weekdaysOf(question.date)} usually have about ${formatCount(question.typicalGuests)}`;
    const recorded = question.guests === 0
      ? `No guests were recorded, only sales. ${usual} guests.`
      : `${question.guests === 1 ? 'Only 1 guest was' : `Only ${formatCount(question.guests)} guests were`} recorded. ${usual}.`;
    return {
      heading: `Were you open on ${dayText(question.date)}?`,
      context: recorded,
      answers: [
        { value: 'open', label: 'Yes, it was just slow' },
        { value: 'closed', label: 'No, we were closed' },
        { value: 'not_sure', label: 'Not sure' },
        ...other,
      ],
      help: sentences([
        'Townwise treats this day as likely closed until you say.',
        'Yes saves a note that you were open with fewer guests, so the day counts.',
        'No saves a closure note for it.',
        chat && ELSE_HELP,
      ]),
    };
  }
  const one = question.from === question.to;
  const usual = usualGuests(question);
  let context: string;
  if (one) context = usual === null ? 'There are no sales for this day.' : `${weekdaysOf(question.from)} usually have ${usual}. ${shortDayText(question.from)} has no sales.`;
  else context = sentences([`There are no sales for these ${days(question.dayCount)}.`, usual !== null && `You usually have ${usual} on those days of the week.`]);
  return {
    heading: one ? `Were you closed on ${dayText(question.from)}?` : `Were you closed ${rangeText(question.from, question.to)}?`,
    context,
    answers: [
      { value: 'closed', label: 'Yes, we were closed' },
      { value: 'open', label: 'No, the data is missing' },
      { value: 'not_sure', label: 'Not sure' },
      ...other,
    ],
    help: one
      ? sentences(['Yes saves a closure note for that day.', 'If the data is missing, upload that day and TownwiseAI will use it.', chat && ELSE_HELP])
      : sentences(['Yes saves a closure note for those days.', 'If the data is missing, upload those days and TownwiseAI will use them.', chat && ELSE_HELP]),
  };
}

/** What the stored answer did: the note it saved, or that the question won't come back. */
export function answeredLine(question: Question, answered: Answered): string {
  if (question.kind === 'party_guests') {
    // [CONFIRM: "Saved: {n} guests on the private event note." and the skip's line]
    // [CONFIRM 300: the lines when this Save's count lost to a count or a Skip saved first elsewhere]
    const sent = answered.sent;
    if (answered.answer !== 'guests') {
      return sent === undefined
        ? 'Got it. TownwiseAI won’t ask about this event again.'
        : `This question was already skipped, so your count of ${formatCount(sent)} wasn’t saved. You can add it to the event’s note on the Notes page.`;
    }
    const count = answered.note?.expectedGuests ?? null;
    if (count === null) return 'Saved the guest count on the private event note.';
    const saved = `${count === 1 ? '1 guest' : `${formatCount(count)} guests`}${eachDay(question) ? ' each day' : ''}`;
    if (sent !== undefined && sent !== count) {
      return `A count was already saved: ${saved} on the private event note, so your ${formatCount(sent)} wasn’t used. You can change it on the Notes page.`;
    }
    return `Saved: ${saved} on the private event note.`;
  }
  const these = question.kind === 'likely_closed' ? 'this day' : 'these days';
  if (answered.answer === 'closed') return answered.note === null ? 'Saved. TownwiseAI treats those days as closed.' : savedNoteLine(answered.note);
  if (answered.answer === 'open' && question.kind === 'likely_closed') {
    return answered.note === null
      ? 'Saved. Townwise now counts that day.'
      : `Saved a note: you were open on ${dayText(question.date)}, with fewer guests than usual. Townwise now counts that day.`;
  }
  if (answered.answer === 'other') return `Sent to TownwiseAI in the chat. It won’t ask about ${these} again.`;
  return `Got it. TownwiseAI won’t ask about ${these} again.`;
}

function savedNoteLine(note: Note): string {
  const one = note.startDate === note.endDate;
  const dates = one ? dayText(note.startDate) : rangeText(note.startDate, note.endDate);
  const weekdays = weekdaysText(note.weekdays);
  const which = weekdays === null ? dates : `${weekdays.replace(/ only$/, '')}, ${dates}`;
  return `Saved a note: ${KIND_LABEL[note.kind]}, ${which}. TownwiseAI treats ${one && weekdays === null ? 'that day' : 'those days'} as closed.`;
}

/** "About {subject} ({evidence}): ", what Something else… puts before the person's words. */
function otherPrefix(question: Question): string {
  // D71: never offered on a private event's question; its subject, should it ever be.
  if (question.kind === 'party_guests') return `About the private event ${eachDay(question) ? rangeText(question.startDate, question.endDate) : `on ${dayText(question.startDate)}`}: `;
  if (question.kind === 'likely_closed') {
    const recorded = question.guests === 0
      ? 'sales but no guests recorded'
      : `only ${question.guests === 1 ? '1 guest' : `${formatCount(question.guests)} guests`} recorded`;
    return `About ${dayText(question.date)} (${recorded}; ${weekdaysOf(question.date)} usually have about ${formatCount(question.typicalGuests)}): `;
  }
  const usual = usualGuests(question);
  if (question.from === question.to) {
    return `About ${dayText(question.from)} (${usual === null ? 'no sales' : `no sales; ${weekdaysOf(question.from)} usually have ${usual}`}): `;
  }
  const none = `no sales on these ${days(question.dayCount)}`;
  return `About ${rangeText(question.from, question.to)} (${usual === null ? none : `${none}; those days of the week usually have ${usual}`}): `;
}

/** The chat message Something else… sends: the question and its evidence, then the person's words, trimmed. */
export function otherMessage(question: Question, text: string): string {
  return `${otherPrefix(question)}${text.trim()}`;
}

/** The most the field holds, so the message fits the chat's limit. */
export function otherMaxLength(question: Question): number {
  return MAX_MESSAGE - otherPrefix(question).length;
}

/** An error on a card: an alert in the copy the person used, the same words without one in the other. */
function CardError(props: { message: string; live: boolean; onRetry?: () => void }): React.JSX.Element {
  const retry = props.onRetry === undefined ? {} : { onRetry: props.onRetry };
  if (props.live) return <ErrorNotice message={props.message} {...retry} />;
  return (
    <View style={styles.quiet}>
      <Messages items={[props.message]} />
      {props.onRetry === undefined ? null : <Button variant="outline" label="Try again" onPress={props.onRetry} />}
    </View>
  );
}

/**
 * D71: the Guests field, Save and Skip of a private event's question. [CONFIRM: "Guests who came" ("…each day"), Save, Skip
 * and "Enter a whole number of guests from 1 to 20,000."]
 */
function PartyAnswers(props: {
  id: string; helpId: string; help: string; many: boolean; off: boolean; readOnlyId: string | null;
  /** The field's accessible name, with the card's dates. */
  name: string;
  save: (guests: number) => void; skip: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const count = guestsOf(text);
  const valid = typeof count === 'number';
  const message = count === 'invalid' ? 'Enter a whole number of guests from 1 to 20,000.' : null;
  return (
    <>
      <View style={styles.guests}>
        <FormField
          label={props.many ? 'Guests who came each day' : 'Guests who came'}
          accessibilityLabel={props.name}
          value={text}
          onChangeText={setText}
          keyboardType="number-pad"
          numeric
          maxLength={6}
          readOnly={props.off}
          {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })}
          {...(message === null ? {} : { messages: [message] })}
          onSubmitEditing={() => { if (valid && !props.off) props.save(count); }}
        />
      </View>
      <View role="group" aria-label="Answer" style={styles.partyActions}>
        <Button
          variant="outline"
          label="Save"
          disabled={props.off || !valid}
          describedBy={joined(props.readOnlyId, props.helpId)}
          onPress={() => { if (valid) props.save(count); }}
        />
        <Button variant="outline" label="Skip" disabled={props.off} describedBy={joined(props.readOnlyId, props.helpId)} onPress={props.skip} />
      </View>
      <Text nativeID={props.helpId} style={styles.help}>{props.help}</Text>
    </>
  );
}

export function QuestionCard(props: {
  question: Question;
  panel: AgentPanelState;
  locationName: string;
  readOnlyId: string | null;
  /** Null while TownwiseAI's chat is off or unread: no Something else…. */
  chat: QuestionChat | null;
  /** Sends Something else…'s message in the conversation shown. */
  send: SendToChat;
  /** Where the card is drawn: its element ids stay unique when the panel and the chat's landing both show it. */
  place: QuestionPlace;
}): React.JSX.Element {
  const { question, panel, chat, place } = props;
  const id = question.id;
  const copy = questionCopy(question, props.locationName, chat !== null);
  const helpId = `question-${place}-${id}-help`;
  const budgetId = `question-${place}-${id}-budget`;
  const answered = panel.answered[id];
  const other = panel.others[id];
  const error = panel.errors[id];
  const answering = panel.answering === id;
  const telling = panel.telling === id;
  // Another question's answer or message is going.
  const busy = (panel.answering !== null && !answering) || (panel.telling !== null && !telling);
  const off = props.readOnlyId !== null || answering || telling || busy;
  const exhausted = chat?.exhausted === true;
  const otherOff = off || chat === null || chat.busy || exhausted;
  const open = chat !== null && other?.open === true;
  // Drawn in both places, only the copy the person used speaks.
  const live = (panel.actedIn[id] ?? place) === place;
  const status = live ? { role: 'status' as const } : {};
  const otherButton = useRef<ChatButtonHandle>(null);
  // This card opened the field (not the same question's card elsewhere), so its field takes focus; once the field
  // closes, from either copy, it forgets.
  const [opened, setOpened] = useState(false);
  if (opened && !open) setOpened(false);
  // Save, Skip or an answer button went with the answer: focus moves to what it did (web), in the copy the person used.
  const done = useRef<Host>(null);
  const isAnswered = answered !== undefined;
  const wasAnswered = useRef(isAnswered);
  useEffect(() => {
    if (isAnswered && !wasAnswered.current && live && Platform.OS === 'web') done.current?.focus();
    wasAnswered.current = isAnswered;
  }, [isAnswered, live]);
  const context = savedPartyContext(question, answered) ?? copy.context;

  let body: React.ReactNode;
  if (answered !== undefined) {
    body = (
      <View ref={done} {...(Platform.OS === 'web' ? { tabIndex: -1 as const } : {})}>
        <Text {...status} style={styles.done}>{answeredLine(question, answered)}</Text>
      </View>
    );
  }
  else if (question.kind === 'party_guests') {
    body = (
      <PartyAnswers
        id={id}
        helpId={helpId}
        help={answering ? 'Saving your answer…' : copy.help}
        many={eachDay(question)}
        name={eachDay(question)
          ? `Guests who came each day, ${rangeText(question.startDate, question.endDate)}`
          : `Guests who came, ${dayText(question.startDate)}`}
        off={off}
        readOnlyId={props.readOnlyId}
        save={(guests) => { panel.answer(id, 'guests', place, guests); }}
        skip={() => { panel.answer(id, 'not_sure', place); }}
      />
    );
  } else if (other?.sent === true) body = <Text {...status} style={styles.help}>{answering ? 'Saving your answer…' : 'Your message is in the chat.'}</Text>;
  else {
    body = (
      <>
        <View role="group" aria-label={copy.heading} style={styles.answers}>
          {copy.answers.map((answer) => (answer.value === 'other' ? (
            <ChatButton
              key={answer.value}
              variant="outline"
              label={answer.label}
              expanded={open}
              disabled={otherOff}
              describedBy={joined(props.readOnlyId, exhausted && budgetId, helpId)}
              focusRef={otherButton}
              onPress={() => {
                if (open) {
                  panel.foldOther(id);
                  return;
                }
                setOpened(true);
                panel.openOther(id);
              }}
            />
          ) : (
            <Button
              key={answer.value}
              variant="outline"
              label={answer.label}
              disabled={off}
              describedBy={joined(props.readOnlyId, helpId)}
              onPress={() => { panel.answer(id, answer.value, place); }}
            />
          )))}
        </View>
        {open ? (
          <View style={styles.other}>
            <FormField
              label="Tell TownwiseAI in your own words"
              helper="Leave out guest names. TownwiseAI answers in the chat."
              multiline
              autoCapitalize="sentences"
              autoFocus={opened}
              maxLength={otherMaxLength(question)}
              value={other.text}
              onChangeText={(text) => { panel.typeOther(id, text); }}
            />
            <View style={styles.otherActions}>
              <ChatButton
                variant="outline"
                label="Send to TownwiseAI"
                disabled={otherOff || other.text.trim() === ''}
                describedBy={joined(exhausted && budgetId)}
                onPress={() => { panel.tell(id, otherMessage(question, other.text), props.send, place); }}
              />
              <ChatButton
                variant="link"
                label="Cancel"
                disabled={telling}
                onPress={() => {
                  panel.closeOther(id);
                  otherButton.current?.focus();
                }}
              />
            </View>
            {/* The budget's own line under the help already says that one. */}
            {other.error === null || (exhausted && other.error === TELL_BUDGET) ? null : <CardError message={other.error} live={live} />}
          </View>
        ) : null}
        <Text nativeID={helpId} style={styles.help}>{answering ? 'Saving your answer…' : telling ? 'Sending to TownwiseAI…' : copy.help}</Text>
        {exhausted ? <Text nativeID={budgetId} style={styles.help}>{TELL_BUDGET}</Text> : null}
      </>
    );
  }
  return (
    <View style={styles.card}>
      <Heading level={3}>{copy.heading}</Heading>
      {context === '' ? null : <Text style={styles.context}>{context}</Text>}
      {body}
      {error === undefined || answered !== undefined ? null : (
        // A message already in the chat needs only its answer saved again, never sent again.
        <CardError message={error} live={live} {...(other?.sent === true ? { onRetry: () => { panel.answer(id, 'other', place); } } : {})} />
      )}
    </View>
  );
}

/**
 * D71: why a private event's card went when its count was saved (a 404). Drawn with the cards in both places; the copy the
 * person used takes focus (web) and is announced.
 */
export function QuestionsNoticeLine(props: { panel: AgentPanelState; place: QuestionPlace }): React.JSX.Element | null {
  const notice = props.panel.questionsNotice;
  const live = notice !== null && notice.place === props.place;
  const text = notice?.text ?? null;
  const ref = useRef<Host>(null);
  useEffect(() => {
    if (!live || text === null) return;
    if (Platform.OS === 'web') ref.current?.focus();
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [live, text]);
  if (text === null) return null;
  return (
    <View ref={ref} {...(live && Platform.OS === 'web' ? { tabIndex: -1 as const } : {})} {...(live ? { role: 'status' as const } : {})}>
      <Text style={styles.done}>{text}</Text>
    </View>
  );
}

type Host = React.ComponentRef<typeof View>;

const c = theme.color;

const styles = StyleSheet.create({
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  context: { ...theme.type.small, color: c.text2 },
  answers: { gap: theme.space[2], alignItems: 'flex-start' },
  other: { gap: theme.space[3] },
  guests: { maxWidth: 240 },
  partyActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space[2] },
  otherActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4], rowGap: theme.space[2] },
  help: { ...theme.type.small, color: c.text3 },
  done: { ...theme.type.small, color: c.white },
  // As ErrorNotice lays out its message and Try again.
  quiet: { gap: theme.space[4], alignItems: 'flex-start' },
});
