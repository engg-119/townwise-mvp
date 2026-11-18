import { Children } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Panel } from '../ui/layout';
import { Eyebrow, Small } from '../ui/text';
import type { Tile } from './overview';

// The Overview's six stat tiles (P32, design decision 7): each a panel with its label, its figure in the `value` type
// and its change against the window before in words under it, never by color. Three to a row from 1024px, two from
// 641px, one on phones. The skeleton (skeleton/console.tsx OverviewSkeleton) lays its shapes out in the same grid.

/** Three tiles to a row from 1024px, two from 641px, one at 640px and below. */
export function TileGrid(props: { children: React.ReactNode }): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const perRow = phone ? 1 : desktop ? 3 : 2;
  return (
    <View style={styles.grid}>
      {Children.toArray(props.children).map((child, index) => (
        <View key={index} style={[styles.cell, { flexBasis: `${String(100 / perRow)}%` }]}>{child}</View>
      ))}
    </View>
  );
}

export function StatTiles(props: { tiles: readonly Tile[] }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <TileGrid>
      {props.tiles.map((tile) => (
        <Panel key={tile.key} style={styles.tile}>
          <Eyebrow>{tile.label}</Eyebrow>
          <View style={styles.figure}>
            <Text style={[phone ? theme.type.valuePhone : theme.type.value, styles.value]}>{tile.value}</Text>
            {tile.of === null ? null : <Small>{tile.of}</Small>}
          </View>
          <Small>{tile.change}</Small>
        </Panel>
      ))}
    </TileGrid>
  );
}

const styles = StyleSheet.create({
  // Each cell's padding makes the gutters, and the grid's negative margin takes back the outer half.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -theme.space.gutter / 2, rowGap: theme.space.gutter },
  cell: { flexGrow: 0, flexShrink: 0, minWidth: 0, paddingHorizontal: theme.space.gutter / 2 },
  tile: { flexGrow: 1, gap: theme.space[3] },
  figure: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: theme.space[2] },
  value: { color: theme.color.white, fontVariant: ['tabular-nums'] },
});
