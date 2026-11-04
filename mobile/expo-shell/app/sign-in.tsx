import { useState } from 'react';
import { Platform } from 'react-native';
import { ZodError } from 'zod';

import { ApiError } from '../src/api/client';
import { GoogleButton } from '../src/auth/GoogleButton';
import { useAuth, useAuthState } from '../src/auth/AuthProvider';
import { Button, describeError, Field, Message, Screen, useSubmit } from '../src/ui';

const CONFIRMATION = 'If that address can sign in, a link is on its way.';

export default function SignIn(): React.JSX.Element {
  const auth = useAuth();
  const state = useAuthState();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const showEmail = Platform.OS === 'web' || auth.config.webUrl !== null;
  const notice = state.status === 'signedOut' ? state.notice : undefined;

  const { submit, pending } = useSubmit(async () => {
    try {
      await auth.requestMagicLink(email);
      setSent(true);
      setMessage(null);
    } catch (error) {
      if (error instanceof ZodError) {
        setMessage('Enter an email address.');
        return;
      }
      if (isTransportFailure(error)) {
        setMessage(describeError(error));
        return;
      }
      setSent(true);
      setMessage(null);
    }
  });

  return (
    <Screen>
      {notice === undefined ? null : <Message>{notice}</Message>}
      <GoogleButton
        google={auth.config.google}
        onIdToken={(idToken) => {
          void auth.signInWithGoogle(idToken).catch((error: unknown) => { setMessage(describeError(error)); });
        }}
        onError={setMessage}
        {...(pending ? { disabled: true } : {})}
      />
      {showEmail ? (
        sent ? <Message>{CONFIRMATION}</Message> : (
          <>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              inputMode="email"
              autoComplete="email"
            />
            <Button label="Email me a link" onPress={() => { submit(); }} {...(pending ? { disabled: true } : {})} />
          </>
        )
      ) : null}
      {message === null ? null : <Message tone="error">{message}</Message>}
    </Screen>
  );
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof ApiError && (
    error.kind === 'network'
    || error.kind === 'timeout'
    || (error.kind === 'http' && (error.status === 429 || error.status === 503))
  );
}
