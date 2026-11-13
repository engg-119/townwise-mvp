import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { errorCopy, hasCode } from '../errors';
import { useAction } from '../hooks';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Pair, Panel, Stack } from '../ui/layout';
import { Eyebrow, Heading } from '../ui/text';
import { NOTE_EFFECTS, NOTE_KINDS, type Note, type NoteInput, type NoteKind } from './api';
import { DateField } from './DateField';
import {
  checkNote, DEFAULT_EFFECT, EFFECT_LABEL, KIND_LABEL, MAX_DETAIL, NOTE_COPY, WEEKDAYS, type NoteDraft, type NoteMessages,
} from './noteRules';
import { ToggleGroup } from './parts';

// C6, the note form (spec P14, 12): Kind, Starts, Ends (optional), Starts at and Ends at (optional hours, hidden
// for a closure), Only on these days, Effect (defaulted by the kind), Expected guests (hidden when the effect is
// Closed, except on a private event, where Closed is a buyout and the field takes the party's size; on a private event
// with more guests its helper says Townwise forecasts whole days, so the guests count toward each day's total) and Details
// (required for Other). It checks the API's rules before it sends, then “Save note” posts or replaces the note.
// “Cancel” closes it.

const KIND_OPTIONS = NOTE_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));
const EFFECT_OPTIONS = NOTE_EFFECTS.map((effect) => ({ value: effect, label: EFFECT_LABEL[effect] }));
/** For a private event, Closed is a buyout. A label of this form's only: the chat's proposal words are unchanged. */
const EVENT_EFFECT_OPTIONS = NOTE_EFFECTS.map((effect) => ({
  value: effect, label: effect === 'closed' ? 'Buyout, closed to walk-ins all day' : EFFECT_LABEL[effect],
}));
const HOURS_HELP = '24-hour, like 18:30. Leave empty for all day.';
/** Forecasts are daily (spec 12): shown where a private event's guests change the forecast. */
const GUESTS_HELP = 'Townwise forecasts whole days, so these guests add to the whole day’s total, on each day the note covers.';

function effectOptions(kind: NoteKind): typeof EFFECT_OPTIONS {
  return kind === 'private_event' ? EVENT_EFFECT_OPTIONS : EFFECT_OPTIONS;
}
const DAY_OPTIONS = WEEKDAYS.map((day) => ({ value: day.value, label: day.short, accessibilityLabel: day.plural.slice(0, -1) }));

function list(message: string | undefined): readonly string[] {
  return message === undefined ? [] : [message];
}

/** A save failure in the page's words: the note limit, the shared network and rate-limit copy, or “Couldn’t save”. */
export function saveErrorCopy(error: unknown): string {
  if (hasCode(error, 409, 'note_limit')) return NOTE_COPY.limit;
  if (error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && error.status === 429))) {
    return errorCopy(error);
  }
  return NOTE_COPY.saveFailed;
}

export function NoteForm(props: {
  initial: NoteDraft;
  editing: boolean;
  /** The saved note, or null when the page handled the failure itself (a 404 closes the form). */
  save: (input: NoteInput) => Promise<Note | null>;
  onSaved: (note: Note) => void;
  onCancel: () => void;
  /** Save note's look: the page's primary (Notes), or an outline where the page has another primary (TownwiseAI). */
  submitVariant?: 'primary' | 'outline';
}): React.JSX.Element {
  const { save, onSaved } = props;
  const [draft, setDraft] = useState<NoteDraft>(props.initial);
  const [messages, setMessages] = useState<NoteMessages>({});
  const action = useAction(useCallback(async (input: NoteInput) => {
    const note = await save(input);
    if (note !== null) onSaved(note);
  }, [save, onSaved]));
  const set = (patch: Partial<NoteDraft>): void => { setDraft((current) => ({ ...current, ...patch })); };

  function submit(): void {
    const checked = checkNote(draft);
    if ('messages' in checked) {
      setMessages(checked.messages);
      return;
    }
    setMessages({});
    action.run(checked.input);
  }

  const failure = action.error === null ? null : saveErrorCopy(action.error);
  const buyout = draft.kind === 'private_event' && draft.effect === 'closed';
  const title = props.editing ? 'Edit this note' : 'Add a note';
  return (
    <Panel label={title}>
      <Stack gap={8}>
        <Eyebrow>{props.editing ? 'Edit note' : 'New note'}</Eyebrow>
        <Heading>{title}</Heading>
      </Stack>
      <Stack gap={20}>
        <ToggleGroup
          label="Kind"
          options={KIND_OPTIONS}
          isPressed={(kind) => draft.kind === kind}
          onPress={(kind) => { set({ kind, effect: DEFAULT_EFFECT[kind] }); }}
        />
        <Pair>
          <DateField label="Starts" value={draft.startDate} onChange={(startDate) => { set({ startDate }); }} messages={list(messages.startDate)} />
          <DateField
            label="Ends (optional)"
            helper="Leave it empty for one day."
            value={draft.endDate}
            onChange={(endDate) => { set({ endDate }); }}
            messages={list(messages.endDate)}
          />
        </Pair>
        {draft.kind === 'closure' ? null : (
          <Pair>
            <TimeField label="Starts at" helper={HOURS_HELP} value={draft.startTime} onChange={(startTime) => { set({ startTime }); }} messages={list(messages.startTime)} />
            <TimeField label="Ends at" value={draft.endTime} onChange={(endTime) => { set({ endTime }); }} messages={list(messages.endTime)} />
          </Pair>
        )}
        <ToggleGroup
          label="Only on these days"
          helper="Leave them all off for every day from start to end. For example, closed on Mondays in March."
          nativeID="note-days"
          options={DAY_OPTIONS}
          isPressed={(day) => draft.weekdays.includes(day)}
          onPress={(day) => {
            set({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter((other) => other !== day) : [...draft.weekdays, day] });
          }}
        />
        <ToggleGroup
          label="Effect"
          helper="Set from the kind. Change it if you expect something else."
          nativeID="note-effect"
          options={effectOptions(draft.kind)}
          isPressed={(effect) => draft.effect === effect}
          onPress={(effect) => { set({ effect }); }}
        />
        {draft.effect === 'closed' && !buyout ? null : (
          <View style={styles.guests}>
            <FormField
              label={buyout ? 'Guests at the buyout (optional)' : 'Expected guests (optional)'}
              value={draft.expectedGuests}
              onChangeText={(expectedGuests) => { set({ expectedGuests }); }}
              keyboardType="number-pad"
              numeric
              maxLength={6}
              messages={list(messages.expectedGuests)}
              {...(draft.kind === 'private_event' && draft.effect === 'more_guests' ? { helper: GUESTS_HELP } : {})}
            />
          </View>
        )}
        <FormField
          label={draft.kind === 'other' ? 'Details' : 'Details (optional)'}
          helper={NOTE_COPY.detailHelp}
          value={draft.detail}
          onChangeText={(detail) => { set({ detail }); }}
          multiline
          maxLength={MAX_DETAIL}
          autoCapitalize="sentences"
          messages={list(messages.detail)}
        />
        {failure === null ? null : (
          <ErrorNotice message={failure} {...(failure === NOTE_COPY.limit ? {} : { onRetry: submit })} />
        )}
        <Actions>
          <Button variant={props.submitVariant ?? 'primary'} label={action.pending ? 'Saving…' : 'Save note'} disabled={action.pending} onPress={submit} />
          <Button variant="link" label="Cancel" onPress={props.onCancel} />
        </Actions>
      </Stack>
    </Panel>
  );
}

/** A local time as 'HH:MM': a typed field with the keyboard that has the colon, as DateField has the dash. */
function TimeField(props: {
  label: string; helper?: string; value: string; onChange: (value: string) => void; messages: readonly string[];
}): React.JSX.Element {
  return (
    <FormField
      label={props.label}
      value={props.value}
      onChangeText={props.onChange}
      placeholder="HH:MM"
      keyboardType="numbers-and-punctuation"
      autoCorrect={false}
      maxLength={5}
      numeric
      messages={props.messages}
      {...(props.helper === undefined ? {} : { helper: props.helper })}
    />
  );
}

const styles = StyleSheet.create({
  guests: { maxWidth: 240 },
});
