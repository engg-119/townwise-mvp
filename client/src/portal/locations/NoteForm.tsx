import { useCallback, useState } from 'react';

import { ApiError } from '../../api/client';
import { errorCopy, hasCode } from '../errors';
import { useAction } from '../hooks';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Panel, Stack } from '../ui/layout';
import { Eyebrow, Heading, Small } from '../ui/text';
import type { Note, NoteInput } from './api';
import { NoteFields } from './NoteFields';
import { checkNote, MAX_DETAIL, NOTE_COPY, type NoteDraft, type NoteMessages } from './noteRules';

// C6, the note form (spec P14, 12): the fields a note shares with a business rule's schedule (NoteFields: Kind, the
// dates, the hours, the days, Effect and Expected guests), then Details (required for Other). It checks the API's
// rules before it sends, then “Save note” posts or replaces the note. “Cancel” closes it. `bare` is the form inside
// the Calendar's popover (refine-calendar-and-home design decision 2), whose heading names it: no Panel, eyebrow or
// heading of its own, and Cancel waits, disabled in place, while the save runs, as the popover does.

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
  /** The note was made by TownwiseAI from a file (D34): the form says undoing that read removes it. */
  fromAiFile?: boolean;
  /** Inside a popover that heads it: no Panel, eyebrow or heading, and Cancel disabled while the save runs. */
  bare?: boolean;
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
  const bare = props.bare === true;
  const fields = (
    <Stack gap={20}>
      <NoteFields draft={draft} set={set} messages={messages} idPrefix="note" endHelper="Leave it empty for one day." noun="note" />
      <FormField
        label={draft.kind === 'other' && draft.title.trim() === '' ? 'Details' : 'Details (optional)'}
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
        <Button variant="link" label="Cancel" disabled={bare && action.pending} onPress={props.onCancel} />
      </Actions>
    </Stack>
  );
  const fromAiFile = props.fromAiFile === true ? <Small>{NOTE_COPY.fromAiFileEdit}</Small> : null;
  if (bare) return <>{fromAiFile}{fields}</>;
  const title = props.editing ? 'Edit this note' : 'Add a note';
  return (
    <Panel label={title}>
      <Stack gap={8}>
        <Eyebrow>{props.editing ? 'Edit note' : 'New note'}</Eyebrow>
        <Heading>{title}</Heading>
        {fromAiFile}
      </Stack>
      {fields}
    </Panel>
  );
}
