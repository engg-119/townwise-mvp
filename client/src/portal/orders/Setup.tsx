import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { LinkButton } from '../ui/Button';
import { Small } from '../ui/text';

// P31 Ordering setup (/locations/[id]/orders/setup, members; design Decisions 3, 4 and 8): suppliers and their
// delivery days, the items, item sales and counts, read with fetchOrderSetup and saved with saveOrderSetup
// (orders/api.ts). A placeholder until the page lands (tasks 6.3 and 6.4).
export function Setup(): React.JSX.Element {
  const { location } = useLocation();
  return (
    <View style={styles.page}>
      <Small>The ordering setup page isn’t built yet.</Small>
      <LinkButton href={locationHref(location.id, 'orders')} label="Back to Orders" />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: theme.space[3] },
});
