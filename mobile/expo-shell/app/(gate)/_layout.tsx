import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform } from 'react-native';

import { useAuth, useAuthState } from '../../src/auth/AuthProvider';
import { restoreOnce } from '../../src/auth/restoreOnce';
import { routeFor } from '../../src/auth/store';
import { theme } from '../../src/theme';
import { Loading, Unreachable } from '../../src/ui';

export default function AuthGate(): React.JSX.Element {
  const auth = useAuth();
  const state = useAuthState();
  useEffect(() => { restoreOnce(auth); }, [auth]);
  useEffect(() => {
    if (state.status !== 'restoring') void SplashScreen.hideAsync();
  }, [state.status]);
  if (state.status === 'restoring') return <Loading />;
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
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.ground } }}>
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
