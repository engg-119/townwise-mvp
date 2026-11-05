import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { Platform } from 'react-native';

import { AuthProvider } from '../src/auth/AuthProvider';
import { createAuth } from '../src/auth/auth';
import { createSession } from '../src/auth/session';
import { createApiClient } from '../src/api/client';
import { parseConfig } from '../src/config';
import { env } from '../src/env';
import { createAuthStore } from '../src/auth/store';
import type { Auth } from '../src/auth/auth';
import type { ErrorBoundaryProps } from 'expo-router';
import { theme } from '../src/theme';
import { Button, Message, Screen } from '../src/ui';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout(): React.JSX.Element {
  const [auth] = useState(createAppAuth);
  return (
    <AuthProvider auth={auth}>
      <RootStack />
    </AuthProvider>
  );
}

function createAppAuth(): Auth {
  const config = parseConfig(env, { dev: __DEV__ });
  const store = createAuthStore();
  const session = createSession();
  const api = createApiClient({
    baseUrl: config.apiUrl,
    session,
    onSessionEnded: () => {
      if (store.getState().status === 'signedIn') {
        store.set({ status: 'signedOut', notice: 'You’ve been signed out. Sign in again to continue.' });
      }
    },
  });
  return createAuth({ api, session, store, config });
}

// On web the public pages and sign-in name themselves in the document title (MarketingShell.web). This
// default is the title of every other screen, so a page's title never outlives it (sign-in, then the app).
export function RootStack(): React.JSX.Element {
  return (
    <>
      {Platform.OS === 'web' ? <Head><title>Townwise</title></Head> : null}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.ground } }}>
        <Stack.Screen name="(marketing)" />
        <Stack.Screen name="(gate)" />
      </Stack>
    </>
  );
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps): React.JSX.Element {
  useEffect(() => {
    if (__DEV__) console.error(error);
  }, [error]);
  return (
    <Screen>
      <Message tone="error">{__DEV__ ? error.message : 'Something went wrong.'}</Message>
      <Button label="Try again" onPress={() => { void retry(); }} />
      {Platform.OS === 'web' ? <Button variant="link" label="Go to start" onPress={goToStart} /> : null}
    </Screen>
  );
}

function goToStart(): void {
  const location = (globalThis as { location?: { assign: (url: string) => void } }).location;
  location?.assign('/');
}
