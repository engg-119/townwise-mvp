import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { ToggleGroup } from '../locations/parts';
import { Button } from '../ui/Button';
import { FILTER_KEYS, FILTER_LABEL, type FilterKey, type Filters } from './model';

// The Calendar's toolbar (P27, spec 16.3): the month switcher (Previous month, the month in words,
// Next month, then Today), the filter chips, and the slot for the owner's calendar file. One row from 1024px,
// wrapping below. Previous and Next are disabled in place at the 25 months' ends. The filters hide marks and list
// items, never a figure; "Your calendar" shows only once a file is imported. Filters are page state, not stored.

const LIVE = Platform.OS === 'web' ? { 'aria-live': 'polite' as const } : {};

export function Toolbar(props: {
  /** “November 2026”. */
  month: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  filters: Filters;
  onFilter: (key: FilterKey) => void;
  /** Whether an imported calendar is open, so its chip shows. */
  imported: boolean;
  /** The import control on web, or the line that points to it on native. */
  children: React.ReactNode;
}): React.JSX.Element {
  const { desktop } = useBreakpoint();
  const keys = FILTER_KEYS.filter((key) => key !== 'imported' || props.imported);
  return (
    <View style={[styles.bar, desktop ? styles.barWide : null]}>
      <View style={styles.months}>
        <Button variant="outline" label="‹" accessibilityLabel="Previous month" disabled={!props.canPrevious} onPress={props.onPrevious} />
        <Text {...LIVE} style={styles.month}>{props.month}</Text>
        <Button variant="outline" label="›" accessibilityLabel="Next month" disabled={!props.canNext} onPress={props.onNext} />
        <Button variant="link" label="Today" onPress={props.onToday} />
      </View>
      <ToggleGroup
        label="Show on the calendar"
        options={keys.map((key) => ({ value: key, label: FILTER_LABEL[key] }))}
        isPressed={(key) => props.filters[key]}
        onPress={props.onFilter}
      />
      <View style={styles.slot}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { gap: theme.space[4] },
  barWide: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: theme.space[8], rowGap: theme.space[4] },
  months: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3] },
  month: { ...theme.type.ui, color: theme.color.white, minWidth: 128, textAlign: 'center', fontVariant: ['tabular-nums'] },
  slot: { flexShrink: 1, minWidth: 0 },
});
