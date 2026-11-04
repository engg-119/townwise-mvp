import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform } from 'react-native';

import { AuthProvider, useAuth, useAuthState } from '../src/auth/AuthProvider';
import { createAuth } from '../src/auth/auth';
import { createSession } from '../src/auth/session';
import { createApiClient } from '../src/api/client';
import { parseConfig } from '../src/config';
import { env } from '../src/env';
import { createAuthStore, routeFor } from '../src/auth/store';
import type { Auth } from '../src/auth/auth';
import type { ErrorBoundaryProps } from 'expo-router';
import { Button, Loading, Message, Screen, Unreachable } from '../src/ui';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout(): React.JSX.Element {
  const [auth] = useState(createAppAuth);
  return (
    <AuthProvider auth={auth}>
      <RootNavigator />
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
        store.set({ status: 'signedOut', notice: 'Your session ended. Sign in again.' });
      }
    },
  });
  return createAuth({ api, session, store, config });
}

export function RootNavigator(): React.JSX.Element | null {
  const auth = useAuth();
  const state = useAuthState();
  useEffect(() => { void auth.restore(); }, [auth]);
  useEffect(() => {
    if (state.status !== 'restoring') void SplashScreen.hideAsync();
  }, [state.status]);
  if (state.status === 'restoring') return Platform.OS === 'web' ? <Loading /> : null;
  if (state.status === 'unreachable') {
    return (
      <Unreachable
        onRetry={() => auth.restore()}
        {...(Platform.OS === 'web' ? {} : { onSignInAgain: () => auth.signOut() })}
      />
    );
  }
  const home = routeFor(state) ?? '/sign-in';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={state.status === 'signedIn'} redirectTo={home}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={state.status === 'signedOut'} redirectTo={home}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={state.status === 'mfaRequired'} redirectTo={home}>
        <Stack.Screen name="totp" />
      </Stack.Protected>
      <Stack.Screen name="auth/magic" />
    </Stack>
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
      {Platform.OS === 'web' ? <Button label="Go to start" onPress={goToStart} /> : null}
    </Screen>
  );
}

function goToStart(): void {
  const location = (globalThis as { location?: { assign: (url: string) => void } }).location;
  location?.assign('/');
}
