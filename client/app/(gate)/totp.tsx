import { useState } from 'react';

import { ApiError } from '../../src/api/client';
import { normalizeRecoveryCode, normalizeTotpCode } from '../../src/auth/auth';
import { useAuth } from '../../src/auth/AuthProvider';
import { SignInFrame } from '../../src/auth/SignInFrame';
import { Button } from '../../src/portal/ui/Button';
import { ErrorNotice } from '../../src/portal/ui/feedback';
import { FormField } from '../../src/portal/ui/FormField';
import { Heading, Small } from '../../src/portal/ui/text';
import { describeError, useSubmit } from '../../src/ui';

// P2. The second step of signing in (spec 15.1: the Public frame), as the SignIn board's "Second step" card: the
// code, which sends itself at six digits, or a recovery code. A wrong code prints under its field.

const INVALID_CODE = 'That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.';
const SHORT_CODE = 'Enter the 6-digit code from your authenticator app.';
const INVALID_RECOVERY = 'That recovery code didn’t work. Each one works once.';
const EMPTY_RECOVERY = 'Enter one of your recovery codes.';

type Input = { code: string } | { recoveryCode: string };

export default function TotpScreen(): React.JSX.Element {
  const auth = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  // A message about what was typed prints under the field; anything else under the actions.
  const [fieldMessage, setFieldMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { submit, pending } = useSubmit(async (input: Input) => {
    setFieldMessage(null);
    setMessage(null);
    try {
      await auth.verifyMfa(input);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_code') {
        setFieldMessage('code' in input ? INVALID_CODE : INVALID_RECOVERY);
        return;
      }
      setMessage(describeError(error));
    }
  });

  function sendCode(value: string): void {
    const next = normalizeTotpCode(value);
    if (next.length === 6) submit({ code: next });
    else setFieldMessage(SHORT_CODE);
  }

  function sendRecovery(): void {
    const next = normalizeRecoveryCode(recovery);
    if (next === '') setFieldMessage(EMPTY_RECOVERY);
    else submit({ recoveryCode: next });
  }

  const messages = fieldMessage === null ? [] : [fieldMessage];

  return (
    <SignInFrame
      title="Sign in to Townwise"
      lead="Your account uses two-step sign-in."
      note="Townwise is in development. No forecasts are for sale yet."
    >
      {useRecovery ? (
        <>
          <Heading>Enter a recovery code</Heading>
          <FormField
            label="Recovery code"
            helper="Each recovery code works once."
            value={recovery}
            onChangeText={setRecovery}
            autoComplete="off"
            autoCorrect={false}
            numeric
            messages={messages}
            onSubmitEditing={sendRecovery}
          />
          <Button block label="Continue" disabled={pending} onPress={sendRecovery} />
        </>
      ) : (
        <>
          <Heading>Enter your code</Heading>
          <Small>Open your authenticator app and enter the 6-digit code for Townwise.</Small>
          <FormField
            label="Code"
            value={code}
            onChangeText={(value) => {
              const next = normalizeTotpCode(value);
              setCode(next);
              if (next.length === 6) submit({ code: next });
            }}
            onSubmitEditing={() => { sendCode(code); }}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            keyboardType="number-pad"
            inputMode="numeric"
            numeric
            messages={messages}
          />
          <Button block label="Continue" disabled={pending} onPress={() => { sendCode(code); }} />
        </>
      )}
      <Button
        variant="link"
        label={useRecovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
        onPress={() => { setUseRecovery((current) => !current); setFieldMessage(null); setMessage(null); }}
      />
      <Button variant="link" label="Use a different account" onPress={() => { auth.cancelMfa(); }} />
      {message === null ? null : <ErrorNotice message={message} />}
    </SignInFrame>
  );
}
