import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useAction } from '../../portal/hooks';
import { webAria } from '../../portal/ui/aria';
import { ConfirmDialog } from '../../portal/ui/ConfirmDialog';
import { FormField } from '../../portal/ui/FormField';
import { theme } from '../../theme';
import type { ConversationSummary } from '../api';
import { formatDay } from '../format';
import { ChatButton, focusLost, type ChatButtonHandle } from './controls';
import { described } from './described';

// The History dropdown: a square `panel` under the header's History button, at most 360px and 60% of the window tall
// and scrolling inside (on web the header floats it over the thread). Each row opens its conversation and has Rename
// and Delete. Rename turns the title into a field (Enter saves, Escape cancels); Delete asks first. The open
// conversation carries a mint 6px square and aria-current. Escape closes the list (the header returns focus to
// History) unless a field or the dialog has it; on web so does a press outside it and History, which leaves focus
// where that press put it. On web, focus never falls to the page: a closed field gives it back to its row's Rename,
// and after a delete (its row, Delete and all, is gone) the header gives it to History.

type Host = React.ComponentRef<typeof View>;

/** The list's tallest: 360px, or 60% of the window when that is less. A small dropdown, not a sheet. */
export function historyMaxHeight(windowHeight: number): number {
  return Math.min(360, Math.round(windowHeight * 0.6));
}

const DELETE_BODY = 'TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.';
const NAME_MESSAGE = 'Use 1 to 60 characters.';
const MAX_TITLE = 60;

export function HistoryMenu(props: {
  id: string;
  conversations: readonly ConversationSummary[];
  openId: string | null;
  streaming: boolean;
  readOnlyId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** Web: a press outside the list and `anchor` closes it without moving focus. */
  onDismiss: () => void;
  /** The History button, whose own press opens and closes the list. */
  anchor: React.RefObject<Host | null>;
  onDelete: (id: string) => Promise<void>;
  /** A delete went through and its dialog has gone (web: where focus goes now). */
  onDeleted: () => void;
  onRename: (id: string, title: string) => Promise<void>;
}): React.JSX.Element {
  const { height } = useWindowDimensions();
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const busy = deleting !== null || renaming !== null;
  const { onClose, onDismiss, anchor } = props;
  const root = useRef<Host>(null);
  // Each row's Rename, by conversation id, for focus when its field closes.
  const renameButtons = useRef(new Map<string, ChatButtonHandle>());
  const wasRenaming = useRef<string | null>(null);
  // The dialog is closing after a delete that went through, not a Cancel (which returns focus to Delete itself).
  const deleted = useRef(false);
  const remove = useAction(async (id: string) => {
    await props.onDelete(id);
    deleted.current = true;
    setDeleting(null);
  });
  const locked = props.readOnlyId !== null || props.streaming;

  useEffect(() => {
    const closed = wasRenaming.current;
    wasRenaming.current = renaming;
    if (renaming === null && closed !== null && focusLost()) renameButtons.current.get(closed)?.focus();
  }, [renaming]);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose, busy]);

  // Not while a field or the delete dialog is open: the dialog is drawn outside the list, and a press in it must not
  // close the list under it.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onDown = (event: Event): void => {
      const target = event.target as Node | null;
      const inside = (host: Host | null): boolean => target !== null && (host as unknown as Node | null)?.contains(target) === true;
      if (!busy && !inside(root.current) && !inside(anchor.current)) onDismiss();
    };
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('pointerdown', onDown); };
  }, [onDismiss, anchor, busy]);

  return (
    <View ref={root} nativeID={props.id} role="region" aria-label="History" style={[styles.list, { maxHeight: historyMaxHeight(height) }]}>
      <ScrollView>
        {props.conversations.length === 0 ? <Text style={styles.muted}>No conversations yet.</Text> : null}
        {props.conversations.map((conversation) => {
          const day = formatDay(conversation.updatedAt);
          const current = conversation.id === props.openId;
          return (
            <View key={conversation.id} style={styles.row}>
              {renaming === conversation.id ? (
                <RenameField
                  conversation={conversation}
                  onRename={props.onRename}
                  onDone={() => { setRenaming(null); }}
                />
              ) : (
                <>
                  <Pressable
                    role="button"
                    accessibilityLabel={day === '' ? conversation.title : `${conversation.title}, ${day}`}
                    {...webAria({ 'aria-current': current ? 'true' : undefined })}
                    onPress={() => { props.onOpen(conversation.id); }}
                    style={(press) => [styles.rowMain, press.pressed && styles.rowPressed]}
                  >
                    <View style={styles.titleLine}>
                      {current ? <View style={styles.mark} /> : null}
                      <Text style={styles.rowTitle} numberOfLines={1}>{conversation.title}</Text>
                    </View>
                    <Text style={styles.rowDate}>{day}</Text>
                  </Pressable>
                  <ChatButton
                    variant="link"
                    label="Rename"
                    accessibilityLabel={`Rename ${conversation.title}`}
                    disabled={locked}
                    {...described(props.readOnlyId)}
                    onPress={() => { setRenaming(conversation.id); }}
                    focusRef={(handle: ChatButtonHandle | null) => {
                      if (handle === null) renameButtons.current.delete(conversation.id);
                      else renameButtons.current.set(conversation.id, handle);
                    }}
                  />
                  <ChatButton
                    variant="link"
                    label="Delete"
                    accessibilityLabel={`Delete ${conversation.title}`}
                    disabled={locked}
                    {...described(props.readOnlyId)}
                    onPress={() => { setDeleting(conversation); }}
                  />
                </>
              )}
            </View>
          );
        })}
      </ScrollView>
      <ConfirmDialog
        visible={deleting !== null}
        title="Delete this conversation?"
        body={DELETE_BODY}
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => { if (deleting !== null) remove.run(deleting.id); }}
        onCancel={() => { setDeleting(null); }}
        onDismiss={() => {
          if (!deleted.current) return;
          deleted.current = false;
          props.onDeleted();
        }}
      />
    </View>
  );
}

function RenameField(props: {
  conversation: ConversationSummary;
  onRename: (id: string, title: string) => Promise<void>;
  onDone: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(props.conversation.title);
  const [message, setMessage] = useState<string | null>(null);
  const saving = useRef(false);

  function save(): void {
    if (saving.current) return;
    const title = value.trim();
    if (title.length < 1 || title.length > MAX_TITLE) {
      setMessage(NAME_MESSAGE);
      return;
    }
    if (title === props.conversation.title) {
      props.onDone();
      return;
    }
    saving.current = true;
    props.onRename(props.conversation.id, title).then(
      () => { props.onDone(); },
      () => {
        saving.current = false;
        setMessage('Couldn’t rename. Try again.');
      },
    );
  }

  return (
    <View style={styles.rename}>
      <FormField
        label="Conversation name"
        value={value}
        autoFocus
        autoCapitalize="sentences"
        autoComplete="off"
        autoCorrect={false}
        messages={message === null ? [] : [message]}
        onChangeText={(text) => { setValue(text); setMessage(null); }}
        onSubmitEditing={save}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === 'Escape') props.onDone();
        }}
      />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border, paddingHorizontal: theme.space[4] },
  muted: { ...theme.type.small, color: c.text3, paddingVertical: theme.space[3] },
  row: {
    flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3], borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border,
  },
  rowMain: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: theme.space[2], gap: 2 },
  rowPressed: { backgroundColor: c.raised },
  titleLine: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[2] },
  mark: { width: 6, height: 6, backgroundColor: c.mint },
  rowTitle: { ...theme.type.ui, color: c.white, flexShrink: 1 },
  rowDate: { ...theme.type.mono, color: c.text3 },
  rename: { flex: 1, minWidth: 0, paddingVertical: theme.space[2] },
});
