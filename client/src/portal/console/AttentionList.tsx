import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { LinkButton } from '../ui/Button';
import { Small } from '../ui/text';
import type { AttentionLine } from './overview';

// The Overview's Needs attention (P32, design decision 5): what a staff member should act on now, independent of the
// window, in plain words, each with a link to where it is acted on. Ruled rows as the console's tables are; the link sits
// at the row's end from 641px and under its words on phones. Nothing is colored to say it is urgent.

export function AttentionList(props: { lines: readonly AttentionLine[] }): React.JSX.Element {
  const { phone } = useBreakpoint();
  if (props.lines.length === 0) return <Small>Nothing needs attention.</Small>;
  return (
    <View role="list" aria-label="Needs attention" style={styles.list}>
      {props.lines.map((line) => (
        <View key={line.key} role="listitem" style={[styles.item, phone ? styles.itemPhone : styles.itemWide]}>
          <Small white style={styles.text}>{line.text}</Small>
          {line.link === null ? null : <LinkButton href={line.link.href} label={line.link.label} />}
        </View>
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { borderTopWidth: 1, borderTopColor: c.border },
  item: { borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: theme.space[2], minHeight: 44 },
  itemWide: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[5] },
  itemPhone: { gap: theme.space[1] },
  text: { flexShrink: 1, flexGrow: 1, paddingVertical: theme.space[2] },
});
