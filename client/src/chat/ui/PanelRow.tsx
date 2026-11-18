import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { SkeletonWords } from '../../portal/skeleton/kit';
import { webAria } from '../../portal/ui/aria';
import { theme } from '../../theme';
import { CountBadge, PANEL_ID, panelName } from './ChatHeader';
import { ChevronDown, QuestionsIcon } from './icons';

// Questions and activity at 640px and below (spec P25 build note, 2026-11-18; owner: "we should likely put the
// questions and activity back to the right side of the screen and it should only appear on the new chat page"): there
// is no column at that width, so on the new chat page it is a collapsed row under the suggestion chips, its icon, its
// words and the open questions as a badge, with a chevron. The row is a disclosure (aria-expanded, aria-controls) that
// opens the panel in place under it, in the landing's own scroll. [CONFIRM: at 640px and below Questions and activity
// sits under the suggestions as a collapsed row]

// react-native-web reports hover in the press state; React Native's types do not declare it.
function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

export function PanelRow(props: {
  open: boolean;
  openQuestions: number | null;
  onPress: () => void;
  /** The panel, drawn under the row while it is open. */
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View testID="chat-panel-row" style={styles.wrap}>
      <Pressable
        role="button"
        accessibilityLabel={panelName(props.openQuestions)}
        accessibilityState={{ expanded: props.open }}
        {...webAria({ 'aria-expanded': props.open, 'aria-controls': PANEL_ID })}
        onPress={props.onPress}
        style={(state) => [styles.row, hovered(state) ? styles.rowHover : null]}
      >
        <QuestionsIcon color={c.white} />
        <Text style={styles.words}>Questions and activity</Text>
        <CountBadge count={props.openQuestions} inline />
        <View style={styles.push} />
        <ChevronDown color={c.text2} up={props.open} />
      </Pressable>
      {props.open ? <View nativeID={PANEL_ID} testID="agent-side" style={styles.region}>{props.children}</View> : null}
    </View>
  );
}

/** The row in the page's skeleton: the same box, its icon a `raised` block and its words a bar. */
export function PanelRowSkeleton(): React.JSX.Element {
  return (
    <View testID="skeleton-panel-row" style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.iconBar} />
        <Text style={styles.words}><SkeletonWords>Questions and activity</SkeletonWords></Text>
      </View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  wrap: { borderTopWidth: theme.stroke.hairline, borderBottomWidth: theme.stroke.hairline, borderColor: c.border },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[2], minHeight: 44 },
  rowHover: { backgroundColor: c.raised },
  words: { ...theme.type.ui, color: c.white },
  push: { flex: 1 },
  iconBar: { width: 20, height: 20, backgroundColor: c.raised },
  region: { paddingTop: theme.space[4], paddingBottom: theme.space[6] },
});
