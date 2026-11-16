import { useId } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ChipSource } from '../../portal/sources/site';
import { SourceChips } from '../../portal/ui/SourceChip';
import { theme } from '../../theme';
import type { SourceLink } from '../tools';

// The pages a reply cites from its web searches (spec D37, P25), under its Based on line: “Sources”, then one source
// chip per page (portal/ui/SourceChip.tsx, D40), as TownwiseAI's tool cards show theirs: the site's name and logo from
// the committed manifest, or for a site it lacks the host without `www.` and the globe. The chips are a group named by
// “Sources” (a row of chips is no list). On web each opens in a new tab with noopener and noreferrer, as the reply's
// own links do (Markdown.tsx); on native the system browser opens it. Only https links reach here (src/chat/api.ts),
// and a logo is a committed asset, so nothing loads from another site and the CSP is unchanged.

export function ReplySources(props: { sources: readonly SourceLink[] }): React.JSX.Element | null {
  const id = `sources-${useId().replace(/:/g, '')}`;
  if (props.sources.length === 0) return null;
  const sources = props.sources.map((source): ChipSource => ({ url: source.url }));
  return (
    <View style={styles.block}>
      <Text id={id} nativeID={id} style={styles.label}>Sources</Text>
      <View role="group" aria-labelledby={id} style={styles.chips}>
        <SourceChips sources={sources} target="_blank" rel="noopener noreferrer" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4], minWidth: 0 },
  label: { ...theme.type.small, color: theme.color.text2 },
  chips: { flexShrink: 1, minWidth: 0 },
});
