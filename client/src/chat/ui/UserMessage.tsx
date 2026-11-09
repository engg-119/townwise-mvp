import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View, type TextInputKeyPressEvent, type TextStyle } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { theme } from '../../theme';
import { composerKey } from '../composerKeys';
import type { TreeNode } from '../tree';
import { messageText, type ChatMessage, type TuningChat } from '../useTuningChat';
import { MAX_MESSAGE } from './Composer';
import { ChatButton, Hidden, type ChatButtonHandle } from './controls';
import { described } from './described';
import { useVersionNav, VersionNav } from './VersionNav';

// The person's message (owner decisions 1 and 3): a hidden "You said", then a right-aligned rounded bubble (radius
// 16, `panel` with a 1px `border`, never mint; at most 70% of the column from 641px and 85% on phones), and under it
// Edit and, when the message has other versions, the version navigator. Edit swaps the bubble for a field, "Edit your
// message" (4,000 characters; on web Enter sends and Escape cancels), with Save and send and Cancel; focus moves into
// the field, and back to Edit when it is cancelled. Save and send sends the edit as a new version of the message
// (useTuningChat's editMessage), which takes this message and everything after it off the page.

const web = Platform.OS === 'web';
// react-native-web passes overflowWrap through; the native style types don't list it.
const wrap = web ? ({ overflowWrap: 'anywhere' } as TextStyle) : null;

interface KeyEvent {
  key: string;
  shiftKey?: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  preventDefault: () => void;
}

export function UserMessage(props: {
  message: ChatMessage;
  tree: readonly TreeNode[];
  chat: TuningChat;
  readOnlyId: string | null;
  /** A reply streams or a version or conversation loads: Edit and the version navigator are off. */
  busy: boolean;
  /** After Save and send, so the page can move focus to the composer. */
  onEdited?: () => void;
}): React.JSX.Element {
  const { message, chat } = props;
  const { phone } = useBreakpoint();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const field = useRef<React.ComponentRef<typeof TextInput>>(null);
  const editButton = useRef<ChatButtonHandle>(null);
  const returning = useRef(false);
  const nav = useVersionNav(chat, message, props.tree);
  const words = messageText(message);
  // An edit is a turn: off while the chat is busy, under view-as, and once the month's budget is used up.
  const canEdit = !props.busy && props.readOnlyId === null && chat.state.budget?.exhausted !== true;
  const sendable = canEdit && draft.trim() !== '';

  useEffect(() => {
    if (editing) {
      field.current?.focus();
      return;
    }
    if (!returning.current) return;
    returning.current = false;
    if (web) editButton.current?.focus();
  }, [editing]);

  function cancel(): void {
    returning.current = true;
    setEditing(false);
  }

  function save(): void {
    if (!sendable) return;
    chat.editMessage(message.key, draft.trim());
    props.onEdited?.();
  }

  function onKeyPress(event: TextInputKeyPressEvent): void {
    if (!web) return;
    const key = event as unknown as KeyEvent;
    if (key.key === 'Escape') {
      cancel();
      return;
    }
    const isComposing = key.nativeEvent.isComposing === true;
    const keyCode = key.nativeEvent.keyCode;
    if (key.key === 'Enter' && key.shiftKey !== true && !isComposing && keyCode !== 229) key.preventDefault();
    const action = composerKey(
      { key: key.key, shiftKey: key.shiftKey === true, isComposing, ...(keyCode === undefined ? {} : { keyCode }) },
      { draft, canSend: sendable, streaming: false, example: null },
    );
    if (action === 'send') save();
  }

  const paragraphs = words.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <View style={styles.message}>
      <Hidden>You said</Hidden>
      {editing ? (
        <View style={styles.editor}>
          <TextInput
            ref={field}
            accessibilityLabel="Edit your message"
            value={draft}
            onChangeText={setDraft}
            onKeyPress={onKeyPress}
            onFocus={() => { setFocused(true); }}
            onBlur={() => { setFocused(false); }}
            multiline
            {...(web ? { rows: 3 } : {})}
            maxLength={MAX_MESSAGE}
            style={[styles.field, focused ? styles.fieldFocused : null]}
          />
          <View style={styles.row}>
            <ChatButton variant="outline" label="Save and send" disabled={!sendable} {...described(props.readOnlyId)} onPress={save} />
            <ChatButton variant="link" label="Cancel" onPress={cancel} />
          </View>
        </View>
      ) : (
        <>
          <View testID="user-bubble" style={[styles.bubble, { maxWidth: phone ? '85%' : '70%' }]}>
            {paragraphs.map((paragraph, index) => <Text key={index} selectable style={[styles.text, wrap]}>{paragraph}</Text>)}
          </View>
          {/* Only a saved message can be edited or have versions. */}
          {message.nodeId === null ? null : (
            <View style={styles.row}>
              <ChatButton
                focusRef={editButton}
                variant="link"
                label="Edit"
                disabled={!canEdit}
                {...described(props.readOnlyId)}
                onPress={() => {
                  setDraft(words);
                  setEditing(true);
                }}
              />
              {nav.versions === null ? null : (
                <VersionNav
                  index={nav.versions.index}
                  count={nav.versions.count}
                  disabled={props.busy}
                  onStep={nav.onStep}
                  focusRef={nav.focusRef}
                  announcement={nav.announcement}
                />
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  message: { alignItems: 'flex-end', gap: theme.space[1], minWidth: 0 },
  // The chat page's rounding exception (spec 15.6): the person's bubble only.
  bubble: {
    gap: theme.space[3], paddingHorizontal: theme.space[4], paddingVertical: theme.space[3], backgroundColor: c.panel,
    borderWidth: theme.stroke.hairline, borderColor: c.border, borderRadius: 16, minWidth: 0,
  },
  text: { ...theme.type.sub, color: c.white },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', columnGap: theme.space[4] },
  editor: { alignSelf: 'stretch', gap: theme.space[2] },
  field: {
    ...theme.type.sub, minHeight: 88, paddingHorizontal: 12, paddingVertical: 10, color: c.white, backgroundColor: c.ground,
    borderWidth: 1, borderColor: c.line, borderRadius: 0, textAlignVertical: 'top',
  },
  fieldFocused: { borderColor: c.mint },
});
