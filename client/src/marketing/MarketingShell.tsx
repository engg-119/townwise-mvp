import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ScrollView, StyleSheet } from 'react-native';

import { Button, Screen } from '../ui';

// title: the web document title (native has none, so it is unused here).
export interface MarketingShellProps { title: string; children: React.ReactNode }

export function MarketingShell(props: MarketingShellProps): React.JSX.Element {
  const router = useRouter();
  // A cold start at a public page never mounts the auth gate, so the splash is hidden here.
  useEffect(() => { void SplashScreen.hideAsync(); }, []);
  return (
    <Screen>
      <Button
        variant="link"
        label="Back"
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/dashboard');
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>{props.children}</ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingBottom: 24 },
});
