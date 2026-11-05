import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { webAria } from '../ui/aria';

// Pieces the console pages share (spec 15.4, shell.md 6.3, 7.6, 7.7): filter tabs styled as the location tabs,
// the table with its detail panel (right of it from 1200px, columns 8 to 12; below it under 1200px), the selected
// row's name (the selected-row idiom: 6px mint square and mint name, `aria-current="true"`), table cells with a
// second line, and row actions.

function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

export interface FilterTab {
  label: string;
  href: string;
  current: boolean;
}

/** The Requests filters (Pending {n}, Approved, Rejected, Withdrawn), with `aria-current="page"` on the current one. */
export function FilterTabs(props: { label: string; tabs: readonly FilterTab[] }): React.JSX.Element {
  return (
    <View role="navigation" aria-label={props.label} style={styles.tabs}>
      {props.tabs.map((tab) => (
        <Link key={tab.href} href={tab.href as Href} asChild>
          <Pressable
            role="link"
            accessibilityState={{ selected: tab.current }}
            {...webAria({ 'aria-current': tab.current ? 'page' : undefined })}
            style={(state) => [styles.tab, tab.current ? styles.tabOn : hovered(state) ? styles.tabHover : null]}
          >
            <View style={[styles.square, tab.current ? styles.squareOn : null]} />
            <Text style={[styles.tabText, tab.current ? styles.mint : null]}>{tab.label}</Text>
          </Pressable>
        </Link>
      ))}
    </View>
  );
}

/** A console table and the selected row's detail: side by side from 1200px, the detail below under it. */
export function Split(props: { table: React.ReactNode; detail: React.ReactNode }): React.JSX.Element {
  const { width } = useBreakpoint();
  if (width < 1200) return <View style={styles.stacked}>{props.table}{props.detail}</View>;
  return (
    <View style={styles.split}>
      <View style={styles.splitTable}>{props.table}</View>
      <View style={styles.splitDetail}>{props.detail}</View>
    </View>
  );
}

/** The first cell of a selectable row: a link that selects it; selected, it takes the mint square and name. */
export function RowName(props: { label: string; href: string; selected: boolean }): React.JSX.Element {
  return (
    <Link href={props.href} asChild>
      <Pressable role="link" {...webAria({ 'aria-current': props.selected ? 'true' : undefined })} style={styles.rowName}>
        {(state) => (
          <>
            <View style={[styles.square, props.selected ? styles.squareOn : null]} />
            <Text style={[styles.name, props.selected ? styles.mint : hovered(state) ? styles.nameHover : null]}>{props.label}</Text>
          </>
        )}
      </Pressable>
    </Link>
  );
}

/** A plain link in a table cell (an organization's name). */
export function CellLink(props: { label: string; href: string }): React.JSX.Element {
  return <Link href={props.href} style={styles.cellLink}>{props.label}</Link>;
}

/** A cell's value with a second line under it (“Added by Townwise staff”, “You”, a role). */
export function CellLines(props: { main: string; note?: string | null; white?: boolean }): React.JSX.Element {
  return (
    <View>
      <Text style={[styles.value, props.white === true ? styles.white : null]}>{props.main}</Text>
      {props.note === undefined || props.note === null || props.note === '' ? null : <Text style={styles.note}>{props.note}</Text>}
    </View>
  );
}

/** Row actions (`.ra`): wrapping, 16px apart. */
export function RowActions(props: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.actions}>{props.children}</View>;
}

/** A line of facts under a header (“Active”, “Created {date}”, a link), wrapping. */
export function Facts(props: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.facts}>{props.children}</View>;
}

const c = theme.color;

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, rowGap: 4, padding: 4, marginHorizontal: -4, borderBottomWidth: 1, borderBottomColor: c.border },
  tab: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: 'transparent' },
  tabHover: { backgroundColor: c.raised },
  tabOn: { backgroundColor: c.raised, borderColor: c.border },
  tabText: { ...theme.type.ui, color: c.text2 },
  square: { width: 6, height: 6 },
  squareOn: { backgroundColor: c.mint },
  mint: { color: c.mint },
  stacked: { gap: theme.space[6] },
  split: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  splitTable: { flex: 7, minWidth: 0 },
  splitDetail: { flex: 5, minWidth: 0 },
  rowName: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44 },
  name: { ...theme.type.mono, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line, flexShrink: 1 },
  nameHover: { textDecorationColor: c.white },
  cellLink: { ...theme.type.mono, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  white: { color: c.white },
  note: { ...theme.type.small, color: c.text2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 4 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 4 },
});
