import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth, useAuthState } from '../../../src/auth/AuthProvider';
import { loadOrg, type Org } from '../../../src/org';
import { theme } from '../../../src/theme';
import { Button, describeError, Message, Screen, TextLink } from '../../../src/ui';

type OrgLoad = { status: 'loading' } | { status: 'none' } | { status: 'failed'; error: string } | { status: 'ready'; org: Org };

export default function Home(): React.JSX.Element {
  const auth = useAuth();
  const state = useAuthState();
  const [message, setMessage] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgLoad>({ status: 'loading' });
  const email = state.status === 'signedIn' ? state.user.email : '';

  const load = useCallback(() => {
    let cancelled = false;
    void loadOrg(auth.api).then((next) => {
      if (!cancelled) setOrg(next === null ? { status: 'none' } : { status: 'ready', org: next });
    }).catch((error: unknown) => {
      if (!cancelled) setOrg({ status: 'failed', error: describeError(error) });
    });
    return () => { cancelled = true; };
  }, [auth]);

  useFocusEffect(load);

  return (
    <Screen scroll>
      <Text style={styles.email}>{email}</Text>
      <Locations load={org} />
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

function Locations({ load }: { load: OrgLoad }): React.JSX.Element {
  if (load.status === 'loading') return <Text style={styles.muted}>Loading your locations…</Text>;
  if (load.status === 'none') return <Text style={styles.muted}>You’re not part of an organization yet.</Text>;
  if (load.status === 'failed') return <Message tone="error">{load.error}</Message>;
  const { org, locations } = load.org;
  return (
    <View style={styles.section}>
      <Text role="heading" style={styles.org}>{org.name}</Text>
      {locations.length === 0 ? <Text style={styles.muted}>No locations yet.</Text> : null}
      {locations.map((location) => (
        <View key={location.id}>
          <TextLink href={`/locations/${encodeURIComponent(location.id)}/chat`}>{location.name}</TextLink>
          <Text style={styles.town}>{`${location.town.name}, ${location.town.state}`}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  email: { ...theme.type.h3Phone, color: theme.color.white },
  section: { gap: theme.space[2] },
  org: { ...theme.type.ui, color: theme.color.text2 },
  muted: { ...theme.type.small, color: theme.color.text3 },
  town: { ...theme.type.small, color: theme.color.text3 },
});
