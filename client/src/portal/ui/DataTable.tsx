import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';

// Tables in NumbersTable styling (spec 15.7, shell.md 7.6): mono 12/16 with tabular figures, 1px `border` rules,
// heads in `text3`, values in `text2`, rows at least 44px with a `raised` hover, inside a focusable region named
// for what it holds. At 640px and below each row becomes stacked label and value pairs.

export interface Column {
  key: string;
  label: string;
  /** Right-aligned (counts, money). */
  numeric?: boolean;
  /** The column's share of the width; 1 by default. */
  flex?: number;
  /** A head screen readers hear but the table does not print (row actions). */
  hiddenLabel?: boolean;
}

export interface Row {
  key: string;
  /** A string prints in the table's mono style; anything else renders as given. */
  cells: Readonly<Record<string, React.ReactNode>>;
  /** The selected-row idiom: `raised`, a `border` outline. */
  selected?: boolean;
}

function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

function Cell(props: { value: React.ReactNode; numeric: boolean; first: boolean }): React.JSX.Element | null {
  const { value } = props;
  if (typeof value === 'string' || typeof value === 'number') {
    return <Text style={[styles.value, props.first ? styles.first : null, props.numeric ? styles.numeric : null]}>{value}</Text>;
  }
  return <>{value}</>;
}

function empty(value: React.ReactNode): boolean {
  return value === null || value === undefined || value === '' || value === false;
}

export function DataTable(props: { label: string; columns: readonly Column[]; rows: readonly Row[] }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const { columns, rows } = props;
  if (phone) {
    return (
      <View role="region" aria-label={props.label} focusable style={styles.region}>
        <View role="list">
          {rows.map((row) => (
            <View key={row.key} role="listitem" style={[styles.stackedRow, row.selected === true ? styles.selected : null]}>
              {columns.map((column, index) => (empty(row.cells[column.key]) ? null : (
                <View key={column.key} style={styles.pair}>
                  <Text style={[styles.head, styles.pairLabel]}>{column.label}</Text>
                  <View style={styles.pairValue}><Cell value={row.cells[column.key]} numeric={false} first={index === 0} /></View>
                </View>
              )))}
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View role="region" aria-label={props.label} focusable style={styles.region}>
      <View role="table">
        <View role="row" style={styles.headRow}>
          {columns.map((column) => (
            <View key={column.key} role="columnheader" style={[styles.cell, { flex: column.flex ?? 1 }]}>
              <Text
                style={[styles.head, column.numeric === true ? styles.numeric : null, column.hiddenLabel === true ? styles.hidden : null]}
              >
                {column.label}
              </Text>
            </View>
          ))}
        </View>
        {rows.map((row) => (
          <Pressable
            key={row.key}
            role="row"
            focusable={false}
            style={(state) => [styles.row, hovered(state) || row.selected === true ? styles.raised : null, row.selected === true ? styles.selected : null]}
          >
            {columns.map((column, index) => (
              <View key={column.key} role="cell" style={[styles.cell, { flex: column.flex ?? 1 }, column.numeric === true ? styles.cellNumeric : null]}>
                <Cell value={row.cells[column.key]} numeric={column.numeric === true} first={index === 0} />
              </View>
            ))}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A two-column definition list (`.dl`), in mono for data checks (`.dl-m`); it stacks on phones. */
export function DefinitionList(props: { items: readonly { term: string; value: React.ReactNode }[]; mono?: boolean }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const mono = props.mono === true;
  return (
    <View style={styles.dl}>
      {props.items.map((item) => (
        <View key={item.term} style={phone ? styles.dlStacked : styles.dlRow}>
          <Text style={[mono ? styles.dlMono : styles.dlText, styles.term, phone ? null : styles.termWide]}>{item.term}</Text>
          {typeof item.value === 'string' ? (
            <Text style={[mono ? styles.dlMono : styles.dlText, styles.definition]}>{item.value}</Text>
          ) : (
            <View style={styles.definitionBox}>{item.value}</View>
          )}
        </View>
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  region: { minWidth: 0 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  row: { flexDirection: 'row', minHeight: 44, borderBottomWidth: 1, borderBottomColor: c.border },
  raised: { backgroundColor: c.raised },
  selected: { borderWidth: 1, borderColor: c.border },
  cell: { minWidth: 0, justifyContent: 'center', paddingVertical: 6, paddingLeft: 8, paddingRight: 16 },
  cellNumeric: { alignItems: 'flex-end' },
  head: { ...theme.type.mono, color: c.text3, paddingVertical: 2 },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  first: { color: c.white },
  numeric: { textAlign: 'right' },
  hidden: { opacity: 0 },
  stackedRow: { paddingVertical: theme.space[2], borderBottomWidth: 1, borderBottomColor: c.border },
  pair: { flexDirection: 'row', columnGap: theme.space[3], minHeight: 32, paddingVertical: 4, paddingHorizontal: 8 },
  pairLabel: { flex: 2 },
  pairValue: { flex: 3, minWidth: 0 },
  dl: { gap: theme.space[2] },
  dlRow: { flexDirection: 'row', columnGap: theme.space[6] },
  dlStacked: { gap: 0, marginBottom: theme.space[3] },
  dlText: { ...theme.type.small },
  dlMono: { ...theme.type.mono, fontVariant: ['tabular-nums'] },
  term: { color: c.white },
  termWide: { width: 200 },
  definition: { color: c.text2, flex: 1, minWidth: 0 },
  definitionBox: { flex: 1, minWidth: 0 },
});
