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
import { NOTE_EFFECTS, NOTE_KINDS, type Note, type NoteInput } from './api';
import { DateField } from './DateField';
import {
  checkNote, DEFAULT_EFFECT, EFFECT_LABEL, KIND_LABEL, MAX_DETAIL, NOTE_COPY, WEEKDAYS, type NoteDraft, type NoteMessages,
} from './noteRules';
import { ToggleGroup } from './parts';

// C6, the note form (spec P14, 12): Kind, Starts, Ends (optional), Only on these days, Effect (defaulted by the
// kind), Expected guests (hidden when the effect is Closed) and Details (required for Other). It checks the API's
// rules before it sends, then “Save note” posts or replaces the note. “Cancel” closes it.

const KIND_OPTIONS = NOTE_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));
const EFFECT_OPTIONS = NOTE_EFFECTS.map((effect) => ({ value: effect, label: EFFECT_LABEL[effect] }));
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
  save: (input: NoteInput) => Promise<Note>;
  onSaved: (note: Note) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { save, onSaved } = props;
  const [draft, setDraft] = useState<NoteDraft>(props.initial);
  const [messages, setMessages] = useState<NoteMessages>({});
  const action = useAction(useCallback(async (input: NoteInput) => { onSaved(await save(input)); }, [save, onSaved]));
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
          options={EFFECT_OPTIONS}
          isPressed={(effect) => draft.effect === effect}
          onPress={(effect) => { set({ effect }); }}
        />
        {draft.effect === 'closed' ? null : (
          <View style={styles.guests}>
            <FormField
              label="Expected guests (optional)"
              value={draft.expectedGuests}
              onChangeText={(expectedGuests) => { set({ expectedGuests }); }}
              keyboardType="number-pad"
              numeric
              maxLength={6}
              messages={list(messages.expectedGuests)}
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
          <Button label={action.pending ? 'Saving…' : 'Save note'} disabled={action.pending} onPress={submit} />
          <Button variant="link" label="Cancel" onPress={props.onCancel} />
        </Actions>
      </Stack>
    </Panel>
  );
}

const styles = StyleSheet.create({
  guests: { maxWidth: 240 },
});
