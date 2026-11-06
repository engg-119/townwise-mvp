import { StyleSheet, View } from 'react-native';

import { locationHref } from '../../../../../../src/portal/routing';
import { useLocation } from '../../../../../../src/portal/shell/LocationShell';
import { LinkButton } from '../../../../../../src/portal/ui/Button';
import { StatusTag } from '../../../../../../src/portal/ui/feedback';
import { Body } from '../../../../../../src/portal/ui/text';
import { theme } from '../../../../../../src/theme';

// P24 Analytics (/locations/[locationId]/analytics, members): docs/portal/spec.md 16.1. The page is in progress,
// so for now it says so with the In progress tag and leads to Sales data, which holds the daily totals. It
// reads and writes nothing, so view-as shows it unchanged.
export default function AnalyticsTab(): React.JSX.Element {
  const { location } = useLocation();
  return (
    <View style={styles.stack}>
      <StatusTag kind="progress" label="In progress" />
      <Body>Analytics isn’t built yet. Your daily totals are on Sales data.</Body>
      <LinkButton variant="outline" href={locationHref(location.id, 'sales')} label="Sales data" />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space[4], alignItems: 'flex-start', maxWidth: 640 },
});
