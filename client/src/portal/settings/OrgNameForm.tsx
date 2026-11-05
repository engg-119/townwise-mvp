import { useCallback, useState } from 'react';

import { useAction } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Section } from '../ui/layout';
import { renameOrg } from './api';
import { SETTINGS_COPY, SETTINGS_READ_ONLY_ID } from './copy';

// Organization name (spec P18, 10.3), for org admins: one field and the page's primary, Save name. PATCH /api/org
// takes 2 to 120 characters after trimming. On success the page says “Saved.” at the top of its content, and
// GET /api/me is read again so the top bar and the eyebrow show the new name.

export function OrgNameForm(props: { name: string; onSaved: () => void; onEdit: () => void }): React.JSX.Element {
  const { api, refreshMe } = usePortal();
  const { readOnly } = useReadOnly();
  const { onSaved, onEdit } = props;
  const [value, setValue] = useState(props.name);
  const [message, setMessage] = useState<string | null>(null);

  const save = useAction(useCallback(async (name: string) => {
    await renameOrg(api, name);
    onSaved();
    // The rename stands even if this read fails; the top bar then catches up on the next read.
    await refreshMe().catch(() => undefined);
  }, [api, onSaved, refreshMe]));

  function submit(): void {
    if (readOnly) return;
    const name = value.trim();
    if (name.length < 2 || name.length > 120) { setMessage(SETTINGS_COPY.nameLength); return; }
    setMessage(null);
    save.run(name);
  }

  return (
    <Section first kicker="Organization" title="Organization name">
      <FormField
        label="Name"
        helper={SETTINGS_COPY.nameHelper}
        value={value}
        onChangeText={(next) => { setValue(next); onEdit(); }}
        autoCapitalize="words"
        autoCorrect={false}
        messages={message === null ? [] : [message]}
        {...(readOnly ? { readOnly: true, readOnlyId: SETTINGS_READ_ONLY_ID } : {})}
      />
      {save.error === null ? null : <ErrorNotice error={save.error} onRetry={submit} />}
      <Actions>
        <Button
          label="Save name"
          disabled={readOnly || save.pending}
          {...(readOnly ? { describedBy: SETTINGS_READ_ONLY_ID } : {})}
          onPress={submit}
        />
      </Actions>
    </Section>
  );
}
