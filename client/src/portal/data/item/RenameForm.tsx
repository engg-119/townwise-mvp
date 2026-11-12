import { useState } from 'react';

import { theme } from '../../../theme';
import { usePortal } from '../../PortalProvider';
import { Actions, Button } from '../../ui/Button';
import { Messages } from '../../ui/feedback';
import { FormField } from '../../ui/FormField';
import { Stack } from '../../ui/layout';
import { useFocusMessage } from '../../ui/messageFocus';
import { renameItem, type DataItem } from '../api';
import { TITLE_MAX } from '../copy';
import { EDIT, nameHelp, renameError, splitName } from './copy';

// Rename on an item's page (P27, D28): one field, “Name”, holding the name without its extension, which the API keeps
// (the helper says which). It takes focus when it opens, since the Rename button it replaces is gone. Saving the same
// name just closes; an empty one says so in place. A refusal shows under the field and takes focus. While the rename
// runs, `onBusy` tells the page so its other actions wait.

export function RenameForm(props: {
  item: DataItem;
  onBusy: (busy: boolean) => void;
  onRenamed: (item: DataItem) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { item, onBusy } = props;
  const name = item.name ?? '';
  const { base, extension } = splitName(name);
  const [title, setTitle] = useState(base);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const focusMessage = useFocusMessage();

  const save = (): void => {
    if (pending) return;
    const clean = title.trim();
    if (clean === '') {
      setProblem(EDIT.nameMissing);
      return;
    }
    setProblem(null);
    if (clean === base || clean === name) {
      props.onClose();
      return;
    }
    setPending(true);
    setFailure(null);
    onBusy(true);
    renameItem(api, item.locationId, item.ref, clean).then(
      (renamed) => { onBusy(false); props.onRenamed(renamed); },
      (error: unknown) => { setPending(false); onBusy(false); setFailure(error); focusMessage(); },
    );
  };

  return (
    <Stack gap={theme.space[4]}>
      <FormField
        label={EDIT.nameLabel}
        {...(extension === '' ? {} : { helper: nameHelp(extension) })}
        value={title}
        onChangeText={setTitle}
        onSubmitEditing={save}
        maxLength={TITLE_MAX}
        autoComplete="off"
        autoFocus
        messages={problem === null ? [] : [problem]}
      />
      {failure === null ? null : <Messages live="alert" takesFocus items={[renameError(failure)]} />}
      <Actions>
        <Button variant="primary" label={pending ? EDIT.saving : EDIT.save} disabled={pending} onPress={save} />
        <Button variant="link" label={EDIT.cancel} disabled={pending} onPress={props.onClose} />
      </Actions>
    </Stack>
  );
}
