import { useState } from 'react';
import { Link } from 'expo-router';
import { Text } from 'react-native';

import { useAuth, useAuthState } from '../../src/auth/AuthProvider';
import { Button, Message, Screen } from '../../src/ui';

export default function Home(): React.JSX.Element {
  const auth = useAuth();
  const state = useAuthState();
  const [message, setMessage] = useState<string | null>(null);
  const email = state.status === 'signedIn' ? state.user.email : '';
  return (
    <Screen>
      <Text>{email}</Text>
      <Link href="/security">Security</Link>
      <Button
        label="Sign out"
        onPress={() => {
          void auth.signOut().catch(() => { setMessage("Couldn't sign out. Check your connection and try again."); });
        }}
      />
      {message === null ? null : <Message tone="error">{message}</Message>}
    </Screen>
  );
}
