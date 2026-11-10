import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useAction } from '../hooks';
import { useReadOnly } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { nameProblem, normalizeName } from './greeting';
import { useProfile } from './useProfile';

// The one-time prompt at the top of the TownwiseAI page. It shows only when the API asks for a name (no stored
// name, no prefill from the access request) and never under view-as. Save name stores the name; Not now stores
// null, so it is not asked again. Errors stay in the field's message list. On success it disappears.

export function NamePrompt(): React.JSX.Element | null {
  const { status, profile, save } = useProfile();
  const { readOnly } = useReadOnly();
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const store = useAction(useCallback((name: string | null) => save(name), [save]));

  if (status !== 'ready' || profile === null || !profile.askName || readOnly) return null;

  function submit(): void {
    const problem = nameProblem(value);
    if (problem !== null) { setMessage(problem); return; }
    const name = normalizeName(value);
    setMessage(null);
    store.run(name === '' ? null : name);
  }

  return (
    <View style={styles.box}>
      <Text role="heading" aria-level={2} style={styles.lead}>What should TownwiseAI call you?</Text>
      <FormField
        label="First name"
        helper="TownwiseAI greets you by this name. You can change it in Settings."
        value={value}
        onChangeText={(next) => { setValue(next); setMessage(null); }}
        autoCapitalize="words"
        autoCorrect={false}
        messages={message === null ? [] : [message]}
      />
      {store.error === null ? null : <ErrorNotice error={store.error} onRetry={submit} />}
      <Actions>
        <Button label="Save name" variant="outline" disabled={store.pending} onPress={submit} />
        <Button label="Not now" variant="link" disabled={store.pending} onPress={() => { store.run(null); }} />
      </Actions>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginBottom: theme.space[8], gap: theme.space[4] },
  lead: { color: theme.color.white, fontSize: 18, lineHeight: 26 },
});
