import { useState } from 'react';

import { ApiError } from '../src/api/client';
import { normalizeRecoveryCode, normalizeTotpCode } from '../src/auth/auth';
import { useAuth } from '../src/auth/AuthProvider';
import { Button, describeError, Field, Message, Screen, useSubmit } from '../src/ui';

const INVALID_CODE = "That code didn't work. Codes change every 30 seconds; wait for a new one and try again.";

export default function TotpScreen(): React.JSX.Element {
  const auth = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const { submit, pending } = useSubmit(async (input: { code: string } | { recoveryCode: string }) => {
    setMessage(null);
    try {
      await auth.verifyMfa(input);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_code') {
        setMessage(INVALID_CODE);
        return;
      }
      setMessage(describeError(error));
    }
  });

  return (
    <Screen>
      {useRecovery ? (
        <Field
          label="Recovery code"
          value={recovery}
          onChangeText={setRecovery}
          autoCapitalize="none"
          onSubmitEditing={() => { submit({ recoveryCode: normalizeRecoveryCode(recovery) }); }}
        />
      ) : (
        <Field
          label="Authentication code"
          value={code}
          onChangeText={(value) => {
            const next = normalizeTotpCode(value);
            setCode(next);
            if (next.length === 6) submit({ code: next });
          }}
          onSubmitEditing={() => {
            const next = normalizeTotpCode(code);
            if (next.length === 6) submit({ code: next });
          }}
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          keyboardType="number-pad"
          inputMode="numeric"
        />
      )}
      {useRecovery ? (
        <Button
          label="Submit recovery code"
          onPress={() => { submit({ recoveryCode: normalizeRecoveryCode(recovery) }); }}
          {...(pending ? { disabled: true } : {})}
        />
      ) : null}
      <Button
        label={useRecovery ? 'Use an authentication code' : 'Use a recovery code instead'}
        onPress={() => { setUseRecovery((current) => !current); setMessage(null); }}
      />
      <Button label="Use a different account" onPress={() => { auth.cancelMfa(); }} />
      {message === null ? null : <Message tone="error">{message}</Message>}
    </Screen>
  );
}
