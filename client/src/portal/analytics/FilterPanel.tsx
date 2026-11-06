import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Checkbox } from '../ui/Checkbox';
import { KEEP_ONE_YEAR, type Filters as FilterState, type Inclusion, type Marks } from './filters';
import { MetricSwitch } from './MetricSwitch';
import type { Metric } from './words';

// The Analytics filters (home.md 4.2): one block that drives the whole page, as four labelled groups in a row on
// desktop and stacked on phones. The state lives in the page (Analytics.tsx, filters.ts), never in the URL or storage.
// Changing a filter never animates and never moves focus.

const MARKS: readonly { key: keyof Marks; label: string }[] = [
  { key: 'townEvents', label: 'Town events' },
  { key: 'holidays', label: 'Holidays' },
  { key: 'notes', label: 'Your notes' },
  { key: 'closures', label: 'Closures' },
];

const INCLUDE: readonly { key: keyof Inclusion; label: string }[] = [
  { key: 'closed', label: 'Closed days' },
  { key: 'noted', label: 'Days with a note' },
  { key: 'eventDays', label: 'Holiday and event days' },
];

const KEEP_ONE_ID = 'analytics-keep-year';

function Group(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View role="group" aria-label={props.label} style={styles.group}>
      <Text style={styles.legend}>{props.label}</Text>
      <View>{props.children}</View>
    </View>
  );
}

export function FilterPanel(props: {
  filters: FilterState;
  /** Every year with data, ascending. */
  years: readonly number[];
  metrics: Readonly<Record<Metric, boolean>>;
  onChange: (filters: FilterState) => void;
  onYear: (year: number, checked: boolean) => void;
  /** The last year's box was just refused: show "Keep at least one year." */
  keepOneYear: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const { desktop } = useBreakpoint();
  const { filters, onChange } = props;
  const disabled = props.disabled === true;
  return (
    <View role="group" aria-label="Filters" style={[styles.block, desktop ? styles.row : null]}>
      <MetricSwitch
        nativeID="analytics-metric"
        value={filters.metric}
        available={props.metrics}
        disabled={disabled}
        onChange={(metric) => { onChange({ ...filters, metric }); }}
      />
      <Group label="Show on the calendar">
        {MARKS.map((mark) => (
          <Checkbox
            key={mark.key}
            label={mark.label}
            checked={filters.marks[mark.key]}
            disabled={disabled}
            onChange={(checked) => { onChange({ ...filters, marks: { ...filters.marks, [mark.key]: checked } }); }}
          />
        ))}
      </Group>
      <Group label="Include in the numbers">
        {INCLUDE.map((item) => (
          <Checkbox
            key={item.key}
            label={item.label}
            checked={filters.include[item.key]}
            disabled={disabled}
            onChange={(checked) => { onChange({ ...filters, include: { ...filters.include, [item.key]: checked } }); }}
          />
        ))}
      </Group>
      <Group label="Years">
        {props.years.map((year) => (
          <Checkbox
            key={year}
            label={String(year)}
            checked={filters.years.includes(year)}
            disabled={disabled}
            {...(props.keepOneYear ? { describedBy: KEEP_ONE_ID } : {})}
            onChange={(checked) => { props.onYear(year, checked); }}
          />
        ))}
        {props.keepOneYear ? <Text nativeID={KEEP_ONE_ID} style={styles.help}>{KEEP_ONE_YEAR}</Text> : null}
      </Group>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  block: { gap: theme.space[5] },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: theme.space[10], rowGap: theme.space[5] },
  group: { gap: theme.space[1], minWidth: 0 },
  legend: { ...theme.type.ui, color: c.white },
  help: { ...theme.type.small, color: c.text2 },
});
