import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useAuth, useAuthState } from '../../../src/auth/AuthProvider';
import { theme } from '../../../src/theme';
import { Button, Message, Screen, TextLink } from '../../../src/ui';

export default function Home(): React.JSX.Element {
  const auth = useAuth();
  const state = useAuthState();
  const [message, setMessage] = useState<string | null>(null);
  const email = state.status === 'signedIn' ? state.user.email : '';
  return (
    <Screen>
      <Text style={styles.email}>{email}</Text>
      <TextLink href="/settings/security">Security</TextLink>
      <Button
        variant="link"
        label="Sign out"
        onPress={() => {
          void auth.signOut().catch(() => { setMessage("Couldn't sign out. Check your connection and try again."); });
        }}
      />
      {message === null ? null : <Message tone="error">{message}</Message>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  email: { ...theme.type.h3Phone, color: theme.color.white },
});
