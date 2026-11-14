import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { ToggleGroup } from '../locations/parts';
import { Button } from '../ui/Button';
import { FILTER_KEYS, FILTER_LABEL, type FilterKey, type Filters } from './model';

// The Calendar's header row (P28, spec 16.3), one 44px row with its items centered, wrapping: Today, Previous month,
// Next month, then the month in words (aria-live, so a change is announced while focus stays on the button). The
// arrows sit before the label, so they never move under the pointer, and from 641px the label has a fixed width, so
// nothing after it moves either. Then `trailing`: controls the page passes, as the row's own items, so a full-width
// line among them (the import's help and messages) sits under the row. From 1024px they sit at the right of the row,
// on a line they wrap to as well; below that they start their own line at the left. No item is taller than 44px.
// Previous and Next are disabled in place at the 25 months' ends. The filters are their own group (CalendarFilters),
// which the page places by width.

const LIVE = Platform.OS === 'web' ? { 'aria-live': 'polite' as const } : {};

/** From 641px: the longest week label, “Dec 28, 2026 to Jan 3, 2027”, is about 200px in `ui` 14px. */
const LABEL_WIDTH = 216;

export function Toolbar(props: {
  /** “November 2026”. */
  label: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  /** After the label, as the row's own flex items: the import control on web, or the line that points to it on native. */
  trailing: React.ReactNode;
}): React.JSX.Element {
  const { desktop, phone } = useBreakpoint();
  return (
    <View style={[styles.row, desktop ? styles.rowWide : null]}>
      <View style={[styles.nav, desktop ? styles.navWide : styles.navNarrow, phone ? styles.navPhone : null]}>
        <Button variant="link" label="Today" onPress={props.onToday} />
        <Button variant="outline" label="‹" accessibilityLabel="Previous month" disabled={!props.canPrevious} onPress={props.onPrevious} />
        <Button variant="outline" label="›" accessibilityLabel="Next month" disabled={!props.canNext} onPress={props.onNext} />
        <Text {...LIVE} style={[styles.label, phone ? styles.labelPhone : styles.labelFixed]}>{props.label}</Text>
      </View>
      {props.trailing}
    </View>
  );
}

/**
 * “Show on the calendar”: the filters hide marks and list items, never a figure; "Your calendar" shows only once a
 * file is imported. Filters are page state, not stored.
 */
export function CalendarFilters(props: {
  filters: Filters;
  onFilter: (key: FilterKey) => void;
  /** Whether an imported calendar is open, so its chip shows. */
  imported: boolean;
}): React.JSX.Element {
  const keys = FILTER_KEYS.filter((key) => key !== 'imported' || props.imported);
  return (
    <ToggleGroup
      label="Show on the calendar"
      options={keys.map((key) => ({ value: key, label: FILTER_LABEL[key] }))}
      isPressed={(key) => props.filters[key]}
      onPress={props.onFilter}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[3], rowGap: theme.space[4] },
  // From 1024px the free space goes after the label, so the trailing controls sit at the right of the row, and any
  // that wrap sit at the right of the next line.
  rowWide: { justifyContent: 'flex-end' },
  nav: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3], minHeight: 44 },
  navWide: { marginRight: 'auto' },
  // Below 1024px the arrows and the label take the whole row, so the trailing controls start their own line.
  navNarrow: { flexBasis: '100%' },
  navPhone: { flexShrink: 1, minWidth: 0 },
  label: { ...theme.type.ui, color: theme.color.white, fontVariant: ['tabular-nums'] },
  labelFixed: { width: LABEL_WIDTH },
  labelPhone: { flexShrink: 1, minWidth: 0 },
});
