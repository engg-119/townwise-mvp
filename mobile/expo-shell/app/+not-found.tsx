import { Link } from 'expo-router';
import { Text } from 'react-native';

import { Screen } from '../src/ui';

export default function NotFound(): React.JSX.Element {
  return (
    <Screen>
      <Text>This screen does not exist.</Text>
      <Link href="/">Go to home</Link>
    </Screen>
  );
}
