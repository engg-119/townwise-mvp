import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Panel } from '../ui/layout';
import { Eyebrow, Heading } from '../ui/text';

// Home's grid of blocks (spec P11): every card is a `panel` on one 12-column grid with the gutter between them. From
// 1024px a row sets its blocks side by side by their spans, and every block in a row grows to the row's height, so
// edges line up; below 1024px the blocks stack. A block's head is its eyebrow (with an optional tag) and its h2.

export const GUTTER = theme.space.gutter;

/** One card: a named `panel` region with its head, growing to the height of its row. */
export function Block(props: {
  label: string;
  eyebrow?: string;
  title?: string;
  tag?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Panel label={props.label} style={styles.grow}>
      {props.eyebrow === undefined && props.title === undefined ? null : (
        <View style={styles.head}>
          {props.eyebrow === undefined ? null : (
            <View style={styles.eyebrowRow}>
              <Eyebrow>{props.eyebrow}</Eyebrow>
              {props.tag}
            </View>
          )}
          {props.title === undefined ? null : <Heading>{props.title}</Heading>}
        </View>
      )}
      {props.children}
    </Panel>
  );
}

export interface BlockItem {
  key: string;
  /** Columns of 12 from 1024px. */
  span: number;
  /** Null leaves the block out; the others keep their spans. */
  node: React.ReactNode;
}

/**
 * A row of blocks: side by side by span from 1024px (from 641px when `tablet`, for small tiles), each as tall as the
 * row; stacked below.
 */
export function BlockRow(props: { items: readonly BlockItem[]; tablet?: boolean }): React.JSX.Element | null {
  const { phone, desktop } = useBreakpoint();
  const side = props.tablet === true ? !phone : desktop;
  const shown = props.items.filter((item) => item.node !== null && item.node !== false);
  if (shown.length === 0) return null;
  return (
    <View style={side ? styles.row : styles.stack}>
      {shown.map((item) => (
        <View key={item.key} style={side ? [styles.cell, { flex: item.span }] : null}>{item.node}</View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flexGrow: 1 },
  head: { gap: theme.space[2] },
  eyebrowRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  row: { flexDirection: 'row', alignItems: 'stretch', columnGap: GUTTER },
  stack: { gap: GUTTER },
  cell: { minWidth: 0 },
});
