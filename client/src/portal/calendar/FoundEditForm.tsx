import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import { ApiError } from '../../api/client';
import type { ResearchedEvent } from '../analytics/api';
import { errorCopy } from '../errors';
import { useAction } from '../hooks';
import { DateField } from '../locations/DateField';
import type { ResearchedEventFields } from '../research/api';
import { EDIT_SHEET, FOUND_NOTICES } from '../research/copy';
import { checkFound, draftOfFound, MAX_FOUND_TEXT, type FoundDraft, type FoundMessages } from '../research/edit';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice, InlineNotice } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Stack } from '../ui/layout';

// The Calendar's edit sheet on a found event (D66 design decisions 11 and 15), inside the page's popover, which heads
// it "Edit event": Title, Starts, Ends, Time and Where from the event's shown values; Save sends them with the event's
// `head` as `basedOn` (the page's save). When someone changed the event since (409 `changed_since`), the page opens the
// sheet again on the event as it reads now, with `conflict`: the fields show the new values, a line says so, and Save
// sends the new head. Cancel waits, disabled in place, while a save runs, as the popover does. As fixed in UI review:
// the conflict line sits just above Save and Cancel, and on web the sheet scrolls them into view when it opens again
// with it, since the line made the sheet taller than the popover and pushed Save out of sight.

function list(message: string | undefined): readonly string[] {
  return message === undefined ? [] : [message];
}

/** A save failure in the sheet's words: the edit limit, a refused value, the shared network and rate-limit copy. */
export function foundSaveCopy(error: unknown): string {
  if (error instanceof ApiError && error.status === 409 && error.code === 'too_many_edits') return FOUND_NOTICES.tooManyEdits;
  if (error instanceof ApiError && error.status === 400) {
    if (error.code === 'bad_title') return FOUND_NOTICES.badTitle;
    if (error.code === 'bad_where') return FOUND_NOTICES.badWhere;
    if (error.code === 'bad_dates') return FOUND_NOTICES.badDates;
    return FOUND_NOTICES.invalid;
  }
  return errorCopy(error);
}

export function FoundEditForm(props: {
  event: ResearchedEvent;
  /** The page opened the sheet again after a 409: the event changed since the person opened it. */
  conflict: boolean;
  save: (fields: ResearchedEventFields) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const { event, save } = props;
  const [draft, setDraft] = useState<FoundDraft>(() => draftOfFound(event));
  const [messages, setMessages] = useState<FoundMessages>({});
  const action = useAction(useCallback((fields: ResearchedEventFields) => save(fields), [save]));
  const set = (patch: Partial<FoundDraft>): void => { setDraft((current) => ({ ...current, ...patch })); };

  function submit(): void {
    const checked = checkFound(draft, event);
    setMessages(checked.messages);
    if (checked.fields !== null) action.run(checked.fields);
  }

  // The line and the actions in the popover's view when the sheet opens again on a conflict (web; react-native-web's
  // View is the element).
  const footer = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (!props.conflict || Platform.OS !== 'web') return;
    const node = footer.current as unknown as { scrollIntoView?: (options: { block: 'nearest' }) => void } | null;
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [props.conflict]);

  const failure = action.error === null ? null : foundSaveCopy(action.error);
  return (
    <Stack gap={20}>
      <FormField
        label={EDIT_SHEET.title}
        value={draft.title}
        onChangeText={(title) => { set({ title }); }}
        maxLength={MAX_FOUND_TEXT}
        autoCapitalize="sentences"
        messages={list(messages.title)}
      />
      <DateField label={EDIT_SHEET.start} value={draft.start} onChange={(start) => { set({ start }); }} messages={list(messages.start)} />
      <DateField label={EDIT_SHEET.end} value={draft.end} onChange={(end) => { set({ end }); }} messages={list(messages.end)} />
      <FormField
        label={EDIT_SHEET.time}
        value={draft.startTime}
        onChangeText={(startTime) => { set({ startTime }); }}
        placeholder="HH:MM"
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        maxLength={5}
        numeric
        messages={list(messages.startTime)}
      />
      <FormField
        label={EDIT_SHEET.where}
        value={draft.where}
        onChangeText={(where) => { set({ where }); }}
        maxLength={MAX_FOUND_TEXT}
        autoCapitalize="words"
        messages={list(messages.where)}
      />
      {failure === null ? null : <ErrorNotice message={failure} {...(failure === FOUND_NOTICES.tooManyEdits ? {} : { onRetry: submit })} />}
      <View ref={footer}>
        <Stack gap={20}>
          {props.conflict ? <InlineNotice text={FOUND_NOTICES.changedSince} /> : null}
          <Actions>
            <Button label={action.pending ? EDIT_SHEET.saving : EDIT_SHEET.save} disabled={action.pending} onPress={submit} />
            <Button variant="link" label={EDIT_SHEET.cancel} disabled={action.pending} onPress={props.onCancel} />
          </Actions>
        </Stack>
      </View>
    </Stack>
  );
}
