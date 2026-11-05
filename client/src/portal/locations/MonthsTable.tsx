import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatCount, formatDate } from '../format';
import { useBreakpoint, useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { DataTable } from '../ui/DataTable';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { fetchSalesDays, type SalesDay, type SalesMonth } from './api';
import { formatMonth, monthRange } from './dates';
import { cellOf } from './sales';

// By month on Sales data (spec P12): Month, Days, Guests, Net sales in NumbersTable styling, inside a focusable
// region. Selecting a month opens its days below its row (GET .../sales/days for that month) and takes the
// selected-row idiom; selecting it again closes them. At 640px and below each row stacks into label and value
// pairs, as DataTable does.

const COLUMNS = [
  { key: 'days', label: 'Days' },
  { key: 'guests', label: 'Guests' },
  { key: 'net', label: 'Net sales' },
] as const;

function valuesOf(month: SalesMonth): Record<(typeof COLUMNS)[number]['key'], string> {
  return { days: formatCount(month.dayCount), guests: cellOf(month.guests, false), net: cellOf(month.netSalesCents, true) };
}

function MonthDays(props: { locationId: string; month: string }): React.JSX.Element {
  const { api } = usePortal();
  const { state, reload } = useLoad(useCallback(
    () => fetchSalesDays(api, props.locationId, monthRange(props.month)),
    [api, props.locationId, props.month],
  ));
  const name = formatMonth(props.month);
  if (state.status === 'loading') return <LoadingLine text={`Loading ${name}`} minHeight={88} />;
  if (state.status === 'failed') return <ErrorNotice error={state.error} onRetry={reload} />;
  return <DaysTable label={`Days in ${name}`} days={state.data} />;
}

/** Date, Guests, Net sales, one row per day. */
export function DaysTable(props: { label: string; days: readonly SalesDay[] }): React.JSX.Element {
  return (
    <DataTable
      label={props.label}
      columns={[
        { key: 'date', label: 'Date', flex: 1.4 },
        { key: 'guests', label: 'Guests', numeric: true },
        { key: 'net', label: 'Net sales', numeric: true },
      ]}
      rows={props.days.map((day) => ({
        key: day.date,
        cells: { date: formatDate(day.date), guests: cellOf(day.guests, false), net: cellOf(day.netSalesCents, true) },
      }))}
    />
  );
}

function MonthButton(props: { month: string; open: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      role="button"
      aria-expanded={props.open}
      onPress={props.onPress}
      style={styles.monthButton}
    >
      <View style={[styles.square, props.open ? styles.squareOn : null]} />
      <Text style={[styles.monthText, props.open ? styles.monthTextOn : null]}>{formatMonth(props.month)}</Text>
    </Pressable>
  );
}

export function MonthsTable(props: { locationId: string; months: readonly SalesMonth[] }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (month: string): void => { setOpen((current) => (current === month ? null : month)); };
  return (
    <View role="region" aria-label="Sales by month" focusable style={styles.region}>
      {phone ? null : (
        <View style={styles.headRow}>
          <View style={[styles.cell, styles.first]}><Text style={styles.head}>Month</Text></View>
          {COLUMNS.map((column) => (
            <View key={column.key} style={[styles.cell, styles.numeric]}><Text style={[styles.head, styles.right]}>{column.label}</Text></View>
          ))}
        </View>
      )}
      {props.months.map((month) => {
        const isOpen = open === month.month;
        const values = valuesOf(month);
        return (
          <View key={month.month} style={[styles.row, isOpen ? styles.selected : null]}>
            {phone ? (
              <View style={styles.stacked}>
                <MonthButton month={month.month} open={isOpen} onPress={() => { toggle(month.month); }} />
                {COLUMNS.map((column) => (
                  <View key={column.key} style={styles.pair}>
                    <Text style={[styles.head, styles.pairLabel]}>{column.label}</Text>
                    <Text style={[styles.value, styles.pairValue]}>{values[column.key]}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.line}>
                <View style={[styles.cell, styles.first]}>
                  <MonthButton month={month.month} open={isOpen} onPress={() => { toggle(month.month); }} />
                </View>
                {COLUMNS.map((column) => (
                  <View key={column.key} style={[styles.cell, styles.numeric]}>
                    <Text style={[styles.value, styles.right]}>{values[column.key]}</Text>
                  </View>
                ))}
              </View>
            )}
            {isOpen ? (
              <View style={phone ? styles.daysPhone : styles.days}>
                <MonthDays locationId={props.locationId} month={month.month} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  region: { minWidth: 0 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  row: { borderBottomWidth: 1, borderBottomColor: c.border, borderWidth: 1, borderColor: 'transparent' },
  selected: { backgroundColor: c.raised, borderColor: c.border },
  line: { flexDirection: 'row', minHeight: 44 },
  cell: { flex: 1, minWidth: 0, justifyContent: 'center', paddingVertical: 6, paddingLeft: 8, paddingRight: 16 },
  first: { flex: 1.4 },
  numeric: { alignItems: 'flex-end' },
  head: { ...theme.type.mono, color: c.text3, paddingVertical: 2 },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  right: { textAlign: 'right' },
  monthButton: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, alignSelf: 'flex-start' },
  square: { width: 6, height: 6 },
  squareOn: { backgroundColor: c.mint },
  monthText: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  monthTextOn: { color: c.mint, textDecorationColor: c.mint },
  stacked: { paddingVertical: theme.space[2], paddingHorizontal: 8 },
  pair: { flexDirection: 'row', columnGap: theme.space[3], minHeight: 32, paddingVertical: 4 },
  pairLabel: { flex: 2 },
  pairValue: { flex: 3, minWidth: 0 },
  days: { paddingLeft: 22, paddingRight: 8, paddingBottom: 16 },
  daysPhone: { paddingHorizontal: 8, paddingBottom: 8 },
});
