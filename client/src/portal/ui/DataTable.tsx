import { createContext, useContext, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';

// Tables in NumbersTable styling (spec 15.7, shell.md 7.6): mono 12/16 with tabular figures, 1px `border` rules,
// heads in `text3`, values in `text2`, rows at least 44px with a `raised` hover, inside a focusable region named
// for what it holds. At 640px and below each row becomes stacked pairs, each label above its value so the value
// has the full width. From 641px to 1023px the table keeps a minimum width and its region scrolls sideways instead
// of squeezing the columns; from 1024px it fills its column with no minimum, so a desktop table does not scroll
// sideways. A table too wide to read sideways (`stack="belowDesktop"`, the Overview's organizations) stacks its rows
// below 1024px too, so no column sits off-screen. The last row has no rule under it: a Section that follows draws its own.
//
// A row with an `href` opens it from a press anywhere on it. Its one way in for the keyboard and screen readers is
// the <RowLink> the caller puts in one of its cells (the item's name): the row itself is not focusable, so the table
// keeps its rows and cells, and the row shows `raised` while that link has focus, as on hover. A control of its own
// in such a row (a ZIP's “See what's inside”) still does only what it says: the innermost press wins. On web a press
// that ends a text selection (a drag across the row) selects and opens nothing. The link's name is underlined, as the
// portal's other links are, so a phone's stacked card shows it opens. A row with an `onPress` instead does that in
// place (a driver's days under Biggest drivers), the same way: a press anywhere on it, its way in a control the caller
// puts in a cell, which raises the row while focused through useRowFocus. A row with neither keeps the default cursor
// and is no tab stop.

/**
 * The least width of one unit of column flex below 1024px: a 9-character mono word (“Locations”, 64.8px at 12px)
 * plus the cell's 24px of padding, with a few pixels to spare. So a head of 9 characters or fewer stays on one line
 * in a column of flex 1 or more; a narrower column (flex 0.8 is 73.6px) can still wrap one.
 */
export const MIN_FLEX_WIDTH = 92;

/**
 * The flex of a column of email addresses, which have no spaces to wrap at. Below 1024px its 3 units are at least
 * 276px: a 35-character address in 12px mono (252px) and the cell's 24px of padding, on one line.
 */
export const EMAIL_FLEX = 3;

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
  /** Where a press anywhere on the row leads. Give one of its cells a <RowLink> to the same place. */
  href?: string;
  /**
   * What a press anywhere on the row does in place, when it has no `href`. Give one of its cells a control that does the
   * same for the keyboard and screen readers, and let it raise the row while focused (useRowFocus).
   */
  onPress?: () => void;
}

/** Tells a linked row that its link took or lost focus. */
const RowFocus = createContext<((focused: boolean) => void) | null>(null);

/** For a row's own control (a row with `onPress`): call with true on focus and false on blur to raise the row. */
export function useRowFocus(): ((focused: boolean) => void) | null {
  return useContext(RowFocus);
}

/**
 * A linked row's link: the row's one focusable element, named `accessibilityLabel` when given (else `label`), and
 * printed as the first column prints.
 */
export function RowLink(props: { href: string; label: string; accessibilityLabel?: string }): React.JSX.Element {
  const focus = useContext(RowFocus);
  return (
    <Link href={props.href} asChild>
      {/* A child of Link asChild takes one plain style object (ui/hover.ts). */}
      <Pressable
        role="link"
        {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
        onFocus={() => { focus?.(true); }}
        onBlur={() => { focus?.(false); }}
        style={styles.rowLink}
      >
        <Text style={styles.rowLinkText}>{props.label}</Text>
      </Pressable>
    </Link>
  );
}

/** A row that opens `href`, or runs `onPress`, from a press anywhere on it, raised on hover and while its control has focus. */
function LinkedRow(props: {
  href: string | undefined;
  onPress: (() => void) | undefined;
  role: 'row' | 'listitem';
  style: (raised: boolean) => StyleProp<ViewStyle>;
  children: React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const [focused, setFocused] = useState(false);
  return (
    <RowFocus.Provider value={setFocused}>
      <Pressable
        role={props.role}
        // Pressable makes itself a tab stop on web unless told otherwise; the row's RowLink is its one.
        tabIndex={-1}
        focusable={false}
        onPress={() => {
          if (selecting()) return;
          if (props.href !== undefined) router.push(props.href);
          else props.onPress?.();
        }}
        style={(state) => props.style(focused || hovered(state))}
      >
        {props.children}
      </Pressable>
    </RowFocus.Provider>
  );
}

/** Web: whether text is selected, so the press that ended a drag across a row only selected it. */
function selecting(): boolean {
  return Platform.OS === 'web' && (globalThis.getSelection()?.toString() ?? '') !== '';
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

export function DataTable(props: {
  label: string;
  columns: readonly Column[];
  rows: readonly Row[];
  /** Stack the rows below 1024px, not only on phones: for a table whose columns would not fit there. */
  stack?: 'belowDesktop';
}): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const { columns, rows } = props;
  // The last row drops its rule unless it is selected: borderBottomWidth would beat the outline's later borderWidth.
  const ruleless = (row: Row, index: number) => (index === rows.length - 1 && row.selected !== true ? styles.lastRow : null);
  if (props.stack === 'belowDesktop' ? !desktop : phone) {
    return (
      <View role="region" aria-label={props.label} focusable style={styles.region}>
        <View role="list">
          {rows.map((row, rowIndex) => {
            const style = (raised: boolean): StyleProp<ViewStyle> => [
              styles.stackedRow, ruleless(row, rowIndex), raised ? styles.raised : null, row.selected === true ? styles.selected : null,
            ];
            const pairs = columns.map((column, index) => (empty(row.cells[column.key]) ? null : (
              <View key={column.key} style={styles.pair}>
                <Text style={styles.head}>{column.label}</Text>
                <View style={styles.pairValue}><Cell value={row.cells[column.key]} numeric={false} first={index === 0} /></View>
              </View>
            )));
            return row.href === undefined && row.onPress === undefined ? (
              <View key={row.key} role="listitem" style={style(false)}>{pairs}</View>
            ) : (
              <LinkedRow key={row.key} href={row.href} onPress={row.onPress} role="listitem" style={style}>{pairs}</LinkedRow>
            );
          })}
        </View>
      </View>
    );
  }
  const flex = columns.reduce((sum, column) => sum + (column.flex ?? 1), 0);
  // No minimum from 1024px: the console's Split column (652px at 1280) is narrower than an 8-unit table's 736px.
  const minWidth = desktop ? null : { minWidth: Math.ceil(flex * MIN_FLEX_WIDTH) };
  return (
    <ScrollView
      horizontal
      role="region"
      aria-label={props.label}
      focusable
      style={styles.scroller}
      contentContainerStyle={[styles.scrollContent, minWidth]}
    >
      <View role="table" style={styles.table}>
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
        {rows.map((row, rowIndex) => {
          const style = (raised: boolean): StyleProp<ViewStyle> => [
            styles.row, ruleless(row, rowIndex), raised || row.selected === true ? styles.raised : null,
            row.selected === true ? styles.selected : null,
          ];
          const cells = columns.map((column, index) => (
            <View key={column.key} role="cell" style={[styles.cell, { flex: column.flex ?? 1 }, column.numeric === true ? styles.cellNumeric : null]}>
              <Cell value={row.cells[column.key]} numeric={column.numeric === true} first={index === 0} />
            </View>
          ));
          return row.href === undefined && row.onPress === undefined ? (
            <Pressable key={row.key} role="row" tabIndex={-1} focusable={false} style={(state) => [style(hovered(state)), styles.plainRow]}>{cells}</Pressable>
          ) : (
            <LinkedRow key={row.key} href={row.href} onPress={row.onPress} role="row" style={style}>{cells}</LinkedRow>
          );
        })}
      </View>
    </ScrollView>
  );
}

/**
 * A two-column definition list (`.dl`), in mono for data checks (`.dl-m`). On phones each term sits above its value
 * and the pairs are spaced only by their 12px margin, with no row gap, as on the boards.
 */
export function DefinitionList(props: { items: readonly { term: string; value: React.ReactNode }[]; mono?: boolean }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const mono = props.mono === true;
  return (
    <View style={phone ? null : styles.dl}>
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
  // The region scrolls sideways; its content is the region's width, and below 1024px never less than the table's
  // minimum.
  scroller: { flexGrow: 0, minWidth: 0 },
  scrollContent: { width: '100%' },
  table: { flex: 1 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  row: { flexDirection: 'row', minHeight: 44, borderBottomWidth: 1, borderBottomColor: c.border },
  lastRow: { borderBottomWidth: 0 },
  raised: { backgroundColor: c.raised },
  selected: { borderWidth: 1, borderColor: c.border },
  cell: { minWidth: 0, justifyContent: 'center', paddingVertical: 6, paddingLeft: 8, paddingRight: 16 },
  cellNumeric: { alignItems: 'flex-end' },
  head: { ...theme.type.mono, color: c.text3, paddingVertical: 2 },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  first: { color: c.white },
  numeric: { textAlign: 'right' },
  hidden: { opacity: 0 },
  rowLink: { alignSelf: 'flex-start' },
  rowLinkText: { ...theme.type.mono, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  plainRow: { cursor: 'auto' as const },
  stackedRow: { paddingVertical: theme.space[2], borderBottomWidth: 1, borderBottomColor: c.border },
  pair: { rowGap: 2, paddingVertical: 4, paddingHorizontal: 8 },
  pairValue: { minWidth: 0 },
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
