import { ScrollView, StyleSheet, View } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { theme } from '../../theme';
import type { Suggestion } from '../suggestions';
import { ChatButton } from './controls';
import { described } from './described';

// The quick-start chips of the landing (spec P25): pills (the chat page's rounding exception, D26) in a group
// "Suggestions", wrapping from 641px and in a row that scrolls sideways on phones. Ask chips send; Tell chips put their
// words in the composer. Disabled in place under view-as.

export function Suggestions(props: {
  items: readonly Suggestion[];
  readOnlyId: string | null;
  /** While a conversation loads or a reply streams, or once the month's budget is used up. */
  busy: boolean;
  onAsk: (text: string) => void;
  onTell: (text: string) => void;
}): React.JSX.Element | null {
  const { phone } = useBreakpoint();
  if (props.items.length === 0) return null;
  const off = props.readOnlyId !== null || props.busy;
  const chips = props.items.map((item) => (
    <ChatButton
      key={item.label}
      variant="chip"
      label={item.label}
      disabled={off}
      {...described(props.readOnlyId)}
      onPress={() => { (item.kind === 'ask' ? props.onAsk : props.onTell)(item.text); }}
    />
  ));
  return (
    <View role="group" aria-label="Suggestions">
      {phone ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>{chips}</ScrollView>
      ) : (
        <View style={[styles.row, styles.wrap]}>{chips}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', columnGap: theme.space[2], rowGap: theme.space[2] },
  wrap: { flexWrap: 'wrap' },
});
