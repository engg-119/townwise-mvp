import { useState } from 'react';
import { Link } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../src/api/client';
import { GoogleButton } from '../../src/auth/GoogleButton';
import { useAuth, useAuthState } from '../../src/auth/AuthProvider';
import { SignInFrame } from '../../src/auth/SignInFrame';
import { theme } from '../../src/theme';
import { describeError, Message } from '../../src/ui';

const OFF = 'Sign-in is turned off right now. Try again later.';

// Why the server refused a Google sign-in, in the sign-in mockup's words (SignIn.dc.html, Messages). With
// Google as the only way in, this is the only feedback a refused new user gets.
const REFUSALS = new Map<string, string>([
  ['google_email_unverified', 'Your Google account’s email isn’t verified yet. Verify it with Google, then try again.'],
  ['google_email_not_authoritative', 'Townwise accepts Gmail addresses and Google Workspace accounts. This Google account uses a different email provider.'],
  ['email_linked_to_other_google_account', 'This email is already linked to a different Google account. Sign in with that account, or write to hello@townwise.tech.'],
  ['google_email_conflict', 'Another Townwise account already uses this email. Write to hello@townwise.tech and we’ll sort it out.'],
  ['origin_not_allowed', 'Sign-in isn’t available from this address. Go to townwise.tech to sign in.'],
  ['google_unavailable', 'Google isn’t responding. Try again in a minute.'],
]);

function describeSignInError(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    const refusal = error.code === null ? undefined : REFUSALS.get(error.code);
    if (refusal !== undefined) return refusal;
    // The server answers 404 when Google sign-in is off there.
    if (error.status === 404) return OFF;
  }
  return describeError(error);
}

// Google is the only way in, and there is no sign-up page: the server creates the account on the
// first Google sign-in from a Gmail or Google Workspace address (api/kit/auth, resolveGoogleUser).
export default function SignIn(): React.JSX.Element {
  const auth = useAuth();
  const state = useAuthState();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const notice = state.status === 'signedOut' ? state.notice : undefined;
  const google = auth.config.google;
  // The iOS Google flow needs its own client ID; without one the button cannot work there.
  const off = google === null || (Platform.OS === 'ios' && google.iosClientId === null);

  function onIdToken(idToken: string): void {
    setMessage(null);
    setPending(true);
    void auth.signInWithGoogle(idToken)
      .catch((error: unknown) => { setMessage(describeSignInError(error)); })
      .finally(() => { setPending(false); });
  }

  // While the server checks the Google token, the button gives way to a disabled "Signing you in…".
  let action: React.JSX.Element;
  if (off) {
    action = <Message>{OFF}</Message>;
  } else if (pending) {
    action = (
      <Pressable accessibilityRole="button" disabled style={styles.wait}>
        <View style={styles.waitDot} />
        <Text style={styles.waitLabel}>Signing you in…</Text>
      </Pressable>
    );
  } else {
    action = <GoogleButton google={google} onIdToken={onIdToken} onError={setMessage} />;
  }

  return (
    <SignInFrame
      title="Sign in to Townwise"
      lead="Use your Google account, whether you’re new or returning. Your first sign-in creates your account. Townwise has no passwords."
      note="Townwise is in development. No forecasts are for sale yet."
    >
      {notice === undefined ? null : <Message>{notice}</Message>}
      {action}
      {message === null ? null : <Message tone="error">{message}</Message>}
      <Text style={styles.fine}>Use a Gmail address or a Google Workspace account.</Text>
      <Text style={styles.fine}>
        By continuing, you agree to the <Link href="/terms" style={styles.inline}>Terms</Link> and
        the <Link href="/privacy" style={styles.inline}>Privacy Policy</Link>.
      </Text>
    </SignInFrame>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fine: { ...theme.type.small, color: c.text2 },
  inline: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  // The sign-in mockup's waiting button: raised fill, line border, a mint square before the label.
  wait: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 18,
    backgroundColor: c.raised, borderWidth: 1, borderColor: c.line,
  },
  waitDot: { width: 8, height: 8, backgroundColor: c.mint },
  waitLabel: { ...theme.type.button, fontWeight: 500, color: c.white },
});
