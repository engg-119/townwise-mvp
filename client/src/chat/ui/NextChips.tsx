import { ScrollView, StyleSheet, View } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { theme } from '../../theme';
import { ChatButton } from './controls';
import { described } from './described';

// The three suggested next questions under the newest settled reply (owner decision 6): pill outline buttons in a
// group "Suggested next questions", wrapping from 641px and in a row that scrolls sideways inside itself on phones.
// One press sends. Disabled in place under view-as, and while the chat can't send (the page says when).

export function NextChips(props: {
  prompts: readonly string[];
  /** A reply streams, a version or conversation loads, or the month's budget is used up. */
  disabled: boolean;
  readOnlyId: string | null;
  onAsk: (text: string) => void;
}): React.JSX.Element | null {
  const { phone } = useBreakpoint();
  if (props.prompts.length === 0) return null;
  const off = props.disabled || props.readOnlyId !== null;
  // Keyed by place: the model's three prompts need not differ.
  const chips = props.prompts.map((prompt, index) => (
    <ChatButton
      key={index}
      variant="chip"
      label={prompt}
      disabled={off}
      {...described(props.readOnlyId)}
      onPress={() => { props.onAsk(prompt); }}
    />
  ));
  return (
    <View role="group" aria-label="Suggested next questions">
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
