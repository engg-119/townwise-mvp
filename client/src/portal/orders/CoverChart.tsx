import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Heading, Mono, Small } from '../ui/text';
import type { SupplierOrder } from './api';
import { coverRows } from './cover';

// "Will it last?" under a supplier's order on Orders (P30): a bar per item, the count in gray then this order in mint,
// with a white mark at the use Townwise expects before the following delivery and a gray mark at that use with
// Townwise's cushion. A bar that stops short of the white mark is an item likely to run out. Plain views, so it draws
// on web and native alike. The bars and the key are hidden from screen readers: each row's sentence carries the same
// numbers. Nothing shows for an order with no row (no fresh count or no item sales, and so the sample bar).

const HIDDEN = { 'aria-hidden': true, importantForAccessibility: 'no-hide-descendants', accessibilityElementsHidden: true } as const;

function share(part: number): `${number}%` {
  return `${Math.round(part * 1000) / 10}%`;
}

export function CoverChart(props: { order: SupplierOrder }): React.JSX.Element | null {
  const rows = coverRows(props.order);
  if (rows.length === 0) return null;
  return (
    <View style={styles.chart}>
      <Heading level={3}>Will it last?</Heading>
      <Small>What you would have after this order, against what Townwise expects you to use before the following delivery.</Small>
      <View {...HIDDEN} style={styles.key}>
        <View style={styles.keyItem}><View style={[styles.swatch, styles.onHand]} /><Mono>On hand</Mono></View>
        <View style={styles.keyItem}><View style={[styles.swatch, styles.ordered]} /><Mono>This order</Mono></View>
        <View style={styles.keyItem}><View style={[styles.keyMark, styles.useMark]} /><Mono>Expected use</Mono></View>
        <View style={styles.keyItem}><View style={[styles.keyMark, styles.cushionMark]} /><Mono>With a cushion</Mono></View>
      </View>
      {rows.map((row) => (
        <View key={row.itemId} style={styles.row}>
          <Small white>{row.name}</Small>
          <View {...HIDDEN} style={styles.track}>
            <View style={[styles.onHand, { width: share(row.onHandPart) }]} />
            <View style={[styles.ordered, { width: share(row.orderPart) }]} />
            <View style={[styles.mark, styles.useMark, { left: share(row.usePoint) }]} />
            {row.cushionPoint === null ? null : <View style={[styles.mark, styles.cushionMark, { left: share(row.cushionPoint) }]} />}
          </View>
          <Small white={row.status === 'short'}>{row.text}</Small>
        </View>
      ))}
    </View>
  );
}

const BAR = 12;
const MARK = 2;

const styles = StyleSheet.create({
  chart: { gap: theme.space[3] },
  key: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[4], rowGap: theme.space[1] },
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  swatch: { width: BAR, height: BAR },
  keyMark: { width: MARK, height: BAR + 8 },
  row: { gap: theme.space[2] },
  // The marks stand 4px above and below the bar, and the last sits inside the track's right edge.
  track: { flexDirection: 'row', height: BAR, marginVertical: 4, marginRight: MARK, backgroundColor: theme.color.raised },
  onHand: { backgroundColor: theme.color.line },
  ordered: { backgroundColor: theme.color.mint },
  mark: { position: 'absolute', top: -4, bottom: -4, width: MARK },
  useMark: { backgroundColor: theme.color.white },
  cushionMark: { backgroundColor: theme.color.text3 },
});
