import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { webAria } from '../../portal/ui/aria';
import { theme } from '../../theme';
import type { ConversationSummary } from '../api';
import { formatDay } from '../format';
import { ChevronDown } from './icons';
import { Replying } from './Replying';

// Previous chats on the new chat page (spec P25 build note, 2026-11-18; owner: "if a response is going then that chat
// should show up below the questions in the chat box on the new page in a previous chats dropdown"). The page draws it
// under the suggestion chips only while a reply runs in another chat (the list's `running`), and reads the list every
// 3 seconds meanwhile, so it goes by itself once none runs. A disclosure, closed at first: open, it lists the recent
// chats, the running ones first with Replying (Replying.tsx: a turning ring, a still square under reduced motion),
// each a button that opens that chat, reattaching its live turn. [CONFIRM: "Previous chats" shows only while a reply
// runs elsewhere, listing recent chats with the running one first]

/** How many chats the list holds: every running one, then the most recent others. */
export const PREVIOUS_MAX = 5;
const LIST_ID = 'chat-previous-list';

// react-native-web reports hover in the press state; React Native's types do not declare it.
function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

/** The chats listed: the running ones first, then the rest in the list's own order (most recent first). */
export function previousChats(conversations: readonly ConversationSummary[]): ConversationSummary[] {
  const running = conversations.filter((item) => item.running);
  const rest = conversations.filter((item) => !item.running);
  return [...running, ...rest].slice(0, Math.max(PREVIOUS_MAX, running.length));
}

export function PreviousChats(props: { conversations: readonly ConversationSummary[]; onOpen: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View testID="chat-previous" style={styles.wrap}>
      <Pressable
        role="button"
        accessibilityLabel="Previous chats"
        accessibilityState={{ expanded: open }}
        {...webAria({ 'aria-expanded': open, 'aria-controls': LIST_ID })}
        onPress={() => { setOpen(!open); }}
        style={(state) => [styles.row, hovered(state) ? styles.hover : null]}
      >
        <Text style={styles.words}>Previous chats</Text>
        <View style={styles.push} />
        <ChevronDown color={c.text2} up={open} />
      </Pressable>
      {open ? (
        <View nativeID={LIST_ID} testID={LIST_ID}>
          {previousChats(props.conversations).map((item) => (
            <Pressable
              key={item.id}
              role="button"
              accessibilityLabel={item.running ? `${item.title}, Replying` : `${item.title}, ${formatDay(item.updatedAt)}`}
              onPress={() => { props.onOpen(item.id); }}
              style={(state) => [styles.item, hovered(state) ? styles.hover : null]}
            >
              <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
              {item.running ? <Replying /> : <Text style={styles.date}>{formatDay(item.updatedAt)}</Text>}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  wrap: { borderTopWidth: theme.stroke.hairline, borderBottomWidth: theme.stroke.hairline, borderColor: c.border },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[2], minHeight: 44 },
  hover: { backgroundColor: c.raised },
  words: { ...theme.type.ui, color: c.white },
  push: { flex: 1 },
  item: {
    flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3], minHeight: 44, paddingLeft: theme.space[3],
    borderTopWidth: theme.stroke.hairline, borderTopColor: c.border,
  },
  title: { ...theme.type.small, color: c.white, flexShrink: 1 },
  date: { ...theme.type.mono, color: c.text3 },
});
