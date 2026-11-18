import { Children } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Panel } from '../ui/layout';
import { Eyebrow, Small } from '../ui/text';
import type { Tile } from './overview';

// The Overview's eight stat tiles (P32, design decision 7): each a panel with its label, its figure in the `value` type
// and under it its change against the window before in words, never by color (or, for the forecast tiles, what the
// figure counts). With no figure the words stand alone, in white. Four to a row from 1024px, two from 641px, one on
// phones. The skeleton (skeleton/console.tsx OverviewSkeleton) lays its shapes out in the same grid. The mono figure's
// thousands separator is set in the sans face, whose comma is narrow, so “1,234” does not read “1 , 234”.

/** Four tiles to a row from 1024px, two from 641px, one at 640px and below. */
export function TileGrid(props: { children: React.ReactNode }): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const perRow = phone ? 1 : desktop ? 4 : 2;
  return (
    <View style={styles.grid}>
      {Children.toArray(props.children).map((child, index) => (
        <View key={index} style={[styles.cell, { flexBasis: `${String(100 / perRow)}%` }]}>{child}</View>
      ))}
    </View>
  );
}

/** The figure's text, its commas in the sans face. */
function figureParts(value: string): React.ReactNode[] {
  return value.split(',').flatMap((part, index) => (index === 0 ? [part] : [<Text key={index} style={styles.separator}>,</Text>, part]));
}

export function StatTiles(props: { tiles: readonly Tile[] }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <TileGrid>
      {props.tiles.map((tile) => (
        <Panel key={tile.key} style={styles.tile}>
          <Eyebrow>{tile.label}</Eyebrow>
          {tile.value === null ? null : (
            <View style={styles.figure}>
              <Text style={[phone ? theme.type.valuePhone : theme.type.value, styles.value]}>{figureParts(tile.value)}</Text>
              {tile.of === null ? null : <Small>{tile.of}</Small>}
            </View>
          )}
          <Small white={tile.value === null}>{tile.detail}</Small>
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
  separator: { fontFamily: theme.type.small.fontFamily },
});
