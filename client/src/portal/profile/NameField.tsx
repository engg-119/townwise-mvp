import { useCallback, useEffect, useRef, useState } from 'react';

import { useAction } from '../hooks';
import { useReadOnly } from '../PortalProvider';
import { SETTINGS_READ_ONLY_ID } from '../settings/copy';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { nameProblem, normalizeName } from './greeting';
import { useProfile } from './useProfile';

// Settings, Your account: "Your name", prefilled with the stored name (or the one from the access request). An
// empty field saves null (no name). Success shows the page's “Saved.” notice through onSaved.

export function NameField(props: { onSaved?: () => void; onEdit?: () => void }): React.JSX.Element {
  const { status, profile, save, reload } = useProfile();
  const { readOnly } = useReadOnly();
  const { onSaved, onEdit } = props;
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const filled = useRef(false);

  // Prefill once, when the profile first arrives; later edits are the person's own.
  useEffect(() => {
    if (profile !== null && !filled.current) { filled.current = true; setValue(profile.displayName ?? ''); }
  }, [profile]);

  const store = useAction(useCallback(async (name: string | null) => {
    await save(name);
    onSaved?.();
  }, [save, onSaved]));

  if (status === 'loading') return <LoadingLine text="Loading your name" minHeight={80} />;
  if (status === 'failed') return <ErrorNotice message="Couldn’t load your name." onRetry={reload} />;

  function submit(): void {
    if (readOnly) return;
    const problem = nameProblem(value);
    if (problem !== null) { setMessage(problem); return; }
    const name = normalizeName(value);
    setMessage(null);
    store.run(name === '' ? null : name);
  }

  return (
    <>
      <FormField
        label="Your name"
        helper="TownwiseAI greets you by this name. Leave it empty for no name."
        value={value}
        onChangeText={(next) => { setValue(next); setMessage(null); onEdit?.(); }}
        autoCapitalize="words"
        autoCorrect={false}
        messages={message === null ? [] : [message]}
        {...(readOnly ? { readOnly: true, readOnlyId: SETTINGS_READ_ONLY_ID } : {})}
      />
      {store.error === null ? null : <ErrorNotice error={store.error} onRetry={submit} />}
      <Actions>
        <Button
          label="Save your name"
          variant="outline"
          disabled={readOnly || store.pending}
          {...(readOnly ? { describedBy: SETTINGS_READ_ONLY_ID } : {})}
          onPress={submit}
        />
      </Actions>
    </>
  );
}
