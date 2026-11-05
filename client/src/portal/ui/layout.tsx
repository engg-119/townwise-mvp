import { Children } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Eyebrow, Heading } from './text';

// The grid and surfaces of spec 15.2: content at most 1280px wide with the grid's side margins, a reading
// column (columns 1 to 7) beside a side column (9 to 12) from 1024px, panels, and sections ruled apart.

/** The content grid's width and side margins (`.wrap`). */
export function Wrap(props: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const { margin } = useBreakpoint();
  return <View style={[styles.wrap, { paddingHorizontal: margin, maxWidth: 1280 + 2 * margin }, props.style]}>{props.children}</View>;
}

/** The page body under the header (`.cnt`): 32px above, 64px below. */
export function Content(props: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.content}>{props.children}</View>;
}

/**
 * The reading column (columns 1 to 7) and the side column (9 to 12) from 1024px; one column, side last, below.
 * `side` holds help text and summaries.
 */
export function Columns(props: { main: React.ReactNode; side?: React.ReactNode; gap?: number }): React.JSX.Element {
  const { desktop } = useBreakpoint();
  const gap = props.gap ?? theme.space[5];
  if (!desktop) {
    return <View style={{ gap }}>{props.main}{props.side}</View>;
  }
  return (
    <View style={[styles.row, { columnGap: theme.space.gutter }]}>
      <View style={styles.main}>{props.main}</View>
      <View style={styles.spacer} />
      <View style={styles.side}>{props.side}</View>
    </View>
  );
}

/** A `panel` surface: 1px `border`, square corners, 20px padding (16px on phones). */
export function Panel(props: { children: React.ReactNode; style?: StyleProp<ViewStyle>; label?: string }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View
      {...(props.label === undefined ? {} : { role: 'region' as const, 'aria-label': props.label })}
      style={[styles.panel, { padding: phone ? theme.space[4] : theme.space[5] }, props.style]}
    >
      {props.children}
    </View>
  );
}

/**
 * A content block (`.blk`): an optional kicker and h2, then its content. Blocks after the first are ruled
 * apart: 32px, a 1px `border` rule, 32px.
 */
export function Section(props: {
  kicker?: string;
  title?: string;
  first?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.section, props.first === true ? null : styles.ruled]}>
      {props.kicker === undefined && props.title === undefined ? null : (
        <View style={styles.sectionHead}>
          {props.kicker === undefined ? null : <Eyebrow>{props.kicker}</Eyebrow>}
          {props.title === undefined ? null : <Heading>{props.title}</Heading>}
        </View>
      )}
      {props.children}
    </View>
  );
}

/** A column of small groups, 16px apart (`.stack`). */
export function Stack(props: { children: React.ReactNode; gap?: number; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return <View style={[{ gap: props.gap ?? theme.space[4] }, props.style]}>{props.children}</View>;
}

/** Fields in pairs that fold to one column on phones and in the reading column below 1024px (`.two`). */
export function Pair(props: { children: React.ReactNode }): React.JSX.Element {
  const { width } = useBreakpoint();
  if (width < 560) return <View style={styles.pairStacked}>{props.children}</View>;
  return (
    <View style={styles.pair}>
      {Children.toArray(props.children).map((child, index) => <View key={index} style={styles.half}>{child}</View>)}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  wrap: { width: '100%', alignSelf: 'center' },
  content: { paddingTop: theme.space[8], paddingBottom: theme.space[16] },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  main: { flex: 7, minWidth: 0 },
  spacer: { flex: 1 },
  side: { flex: 4, minWidth: 0 },
  panel: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 0, gap: theme.space[4] },
  section: { gap: theme.space[5] },
  ruled: { marginTop: theme.space[8], paddingTop: theme.space[8], borderTopWidth: 1, borderTopColor: c.border },
  sectionHead: { gap: theme.space[2] },
  pair: { flexDirection: 'row', columnGap: theme.space[5], alignItems: 'flex-start' },
  pairStacked: { gap: theme.space[5] },
  half: { flex: 1, minWidth: 0 },
});
