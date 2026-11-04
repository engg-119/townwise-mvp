import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';

import { Message, Screen, TextLink } from '../src/ui';

export default function NotFound(): React.JSX.Element {
  // An unknown deep link renders outside the auth gate, so the splash is hidden here.
  useEffect(() => { void SplashScreen.hideAsync(); }, []);
  return (
    <Screen>
      <Message>This screen does not exist.</Message>
      <TextLink href="/">Go to home</TextLink>
    </Screen>
  );
}
