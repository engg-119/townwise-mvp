import { Stack } from 'expo-router';

import { theme } from '../../../src/theme';

export default function AppLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.ground },
        headerTintColor: theme.color.white,
        headerTitleStyle: { fontFamily: theme.type.wordmark.fontFamily },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.color.ground },
      }}
    >
      <Stack.Screen name="dashboard" options={{ title: 'Townwise' }} />
      <Stack.Screen name="settings/security" options={{ title: 'Two-factor settings' }} />
    </Stack>
  );
}
