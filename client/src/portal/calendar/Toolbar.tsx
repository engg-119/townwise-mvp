import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { ToggleGroup } from '../locations/parts';
import { webAria } from '../ui/aria';
import { Button } from '../ui/Button';
import { FILTER_KEYS, FILTER_LABEL, type FilterKey, type Filters } from './model';

// The Calendar's header row (P28, spec 16.3), one 44px row with its items centered, wrapping: Today, Previous month,
// Next month ("Previous week" and "Next week" in the week view), then the month or week in words (aria-live, so a
// change is announced while focus stays on the button). The arrows sit before the label, so they never move under the
// pointer, and from 641px the label has a fixed width that holds the longest week label, so nothing after it moves
// either, in either view. Then the "Calendar view" switch, Month and Week as one segmented pair of `.tgl` buttons
// (aria-pressed on web, a checked state on native, as ToggleGroup's), and `trailing`: what the page passes, as the
// row's own items, which is the "Your calendars" button alone (YourCalendars.tsx): its popover floats over the page, so
// it takes no line of the row or under it. From 1024px the switch and the button sit at the right of the row (the
// arrows' group takes the free space), on a line they wrap to as well; below that they start their own line at the
// left, together. No item is taller than 44px.
// Previous and Next are disabled in place at the 25 months' ends. The filters are their own group (CalendarFilters),
// which the page places by width.

/** The month grid, or the selected day's week (`?view=week`). */
export type CalendarView = 'month' | 'week';

const VIEWS: readonly { value: CalendarView; label: string }[] = [{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }];

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
  view: CalendarView;
  onView: (view: CalendarView) => void;
  /** After the switch, as the row's own flex items: the "Your calendars" button, the row's last item. */
  trailing: React.ReactNode;
}): React.JSX.Element {
  const { desktop, phone } = useBreakpoint();
  const unit = props.view === 'week' ? 'week' : 'month';
  return (
    <View style={[styles.row, desktop ? styles.rowWide : null]}>
      <View style={[styles.nav, desktop ? styles.navWide : styles.navNarrow, phone ? styles.navPhone : null]}>
        <Button variant="link" label="Today" onPress={props.onToday} />
        <Button variant="outline" label="‹" accessibilityLabel={`Previous ${unit}`} disabled={!props.canPrevious} onPress={props.onPrevious} />
        <Button variant="outline" label="›" accessibilityLabel={`Next ${unit}`} disabled={!props.canNext} onPress={props.onNext} />
        <Text {...LIVE} style={[styles.label, phone ? styles.labelPhone : styles.labelFixed]}>{props.label}</Text>
      </View>
      {/* No auto margin: from 1024px the arrows' group already takes the free space, and a second would split it. */}
      <View role="group" aria-label="Calendar view" style={styles.views}>
        {VIEWS.map((option, at) => {
          const pressed = props.view === option.value;
          return (
            <Pressable
              key={option.value}
              role="button"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: pressed }}
              {...webAria({ 'aria-pressed': pressed })}
              onPress={() => { props.onView(option.value); }}
              style={[styles.tgl, at > 0 ? styles.tglNext : null, pressed ? styles.tglOn : null]}
            >
              <Text style={[styles.tglText, pressed ? styles.tglTextOn : null]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {props.trailing}
    </View>
  );
}

/**
 * “Show on the calendar”: the filters hide marks and list items, never a figure; "Your calendar" shows only when the
 * location has a calendar, and "Found by research" while research found something. The last chip, “Forecast chart”,
 * shows or hides the forecast chart (D64), on by default. Filters and the chart's chip are page state, not stored.
 */
export function CalendarFilters(props: {
  filters: Filters;
  onFilter: (key: FilterKey) => void;
  /** Whether the location has a calendar, so its chip shows. */
  imported: boolean;
  /** Whether "Found by research" shows (D66): while the read holds a found event, or the filter is off. */
  researched?: boolean;
  /** Whether the forecast chart shows (D64), and its chip's press. */
  chart: boolean;
  onChart: () => void;
}): React.JSX.Element {
  const keys = FILTER_KEYS.filter((key) => (key !== 'imported' || props.imported) && (key !== 'researched' || props.researched === true));
  return (
    <ToggleGroup<FilterKey | 'chart'>
      label="Show on the calendar"
      options={[...keys.map((key) => ({ value: key, label: FILTER_LABEL[key] })), { value: 'chart' as const, label: CHART_CHIP }]}
      isPressed={(key) => (key === 'chart' ? props.chart : props.filters[key])}
      onPress={(key) => { if (key === 'chart') props.onChart(); else props.onFilter(key); }}
    />
  );
}

/** The last chip of “Show on the calendar”: the forecast chart above the month grid and atop the week's days (D64). */
export const CHART_CHIP = 'Forecast chart';

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
  // The `.tgl` look (locations/parts.tsx ToggleGroup) as one segmented pair: the second shares the first's border.
  views: { flexDirection: 'row' },
  tgl: {
    minHeight: 44, minWidth: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    borderColor: theme.color.line, backgroundColor: 'transparent',
  },
  tglNext: { marginLeft: -1 },
  tglOn: { backgroundColor: theme.color.mint, borderColor: theme.color.mint, zIndex: 1 },
  tglText: { ...theme.type.ui, color: theme.color.white },
  tglTextOn: { color: theme.color.onMint },
});
