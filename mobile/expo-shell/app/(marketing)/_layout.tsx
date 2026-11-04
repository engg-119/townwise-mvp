import { Stack } from 'expo-router';

import { theme } from '../../src/theme';

export default function MarketingLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.ground } }} />;
}
