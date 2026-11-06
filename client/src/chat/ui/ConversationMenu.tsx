import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAction } from '../../portal/hooks';
import { webAria } from '../../portal/ui/aria';
import { Button } from '../../portal/ui/Button';
import { ConfirmDialog } from '../../portal/ui/ConfirmDialog';
import { theme } from '../../theme';
import type { ConversationSummary } from '../api';
import { formatDay } from '../format';
import { described } from './described';

// The chatbox's header (spec P25): the open conversation's title, then Conversations and New chat, both off
// while a reply streams. Conversations opens the list under the header: each row opens its conversation, and its
// Delete asks first. Escape closes the list on web and focus goes back to the button. Deleting the open
// conversation starts a new one; notes saved from it stay.

type Host = React.ComponentRef<typeof View>;

const DELETE_BODY = 'TownwiseAI’s replies and your messages in it are deleted. Notes you saved from it stay.';

export function ConversationHeader(props: {
  title: string;
  conversations: readonly ConversationSummary[];
  openId: string | null;
  streaming: boolean;
  readOnlyId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const button = useRef<Host>(null);
  const remove = useAction(async (id: string) => {
    await props.onDelete(id);
    setDeleting(null);
  });
  const readOnly = props.readOnlyId !== null;

  function close(): void {
    setOpen(false);
    if (Platform.OS === 'web') button.current?.focus();
  }

  useEffect(() => {
    if (!open || Platform.OS !== 'web' || deleting !== null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [open, deleting]);

  return (
    <View style={styles.header}>
      <View style={styles.bar}>
        <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
        <View style={styles.controls}>
          <Pressable
            ref={button}
            role="button"
            aria-expanded={open}
            {...(props.streaming ? { 'aria-disabled': true } : { onPress: () => { if (open) close(); else setOpen(true); } })}
            accessibilityState={{ disabled: props.streaming, expanded: open }}
            style={styles.link}
          >
            <Text style={[styles.linkText, props.streaming ? styles.linkOff : null]}>Conversations</Text>
          </Pressable>
          <Button
            variant="link"
            label="New chat"
            disabled={props.streaming || readOnly}
            {...described(props.readOnlyId)}
            onPress={() => {
              setOpen(false);
              props.onNew();
            }}
          />
        </View>
      </View>
      {open ? (
        <View style={styles.list} role="region" aria-label="Conversations">
          {props.conversations.length === 0 ? <Text style={styles.muted}>No conversations yet.</Text> : null}
          {props.conversations.map((conversation) => {
            const day = formatDay(conversation.updatedAt);
            const current = conversation.id === props.openId;
            return (
              <View key={conversation.id} style={styles.row}>
                <Pressable
                  role="button"
                  accessibilityLabel={day === '' ? conversation.title : `${conversation.title}, ${day}`}
                  {...webAria({ 'aria-current': current ? 'true' : undefined })}
                  onPress={() => {
                    setOpen(false);
                    props.onOpen(conversation.id);
                  }}
                  style={(press) => [styles.rowMain, press.pressed && styles.rowPressed]}
                >
                  <Text style={[styles.rowTitle, current ? styles.rowCurrent : null]} numberOfLines={1}>{conversation.title}</Text>
                  <Text style={styles.rowDate}>{day}</Text>
                </Pressable>
                <Button
                  variant="link"
                  label="Delete"
                  accessibilityLabel={`Delete ${conversation.title}`}
                  disabled={readOnly || props.streaming}
                  {...described(props.readOnlyId)}
                  onPress={() => { setDeleting(conversation); }}
                />
              </View>
            );
          })}
        </View>
      ) : null}
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
      />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  header: { gap: theme.space[2], borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border, paddingBottom: theme.space[2] },
  bar: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[4] },
  title: { ...theme.type.ui, color: c.white, flex: 1, minWidth: 0 },
  controls: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[4] },
  link: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  linkText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  linkOff: { color: c.text3, textDecorationColor: c.border },
  list: { backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border, paddingHorizontal: theme.space[4] },
  muted: { ...theme.type.small, color: c.text3, paddingVertical: theme.space[3] },
  row: {
    flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3], borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border,
  },
  rowMain: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: theme.space[2], gap: 2 },
  rowPressed: { backgroundColor: c.raised },
  rowTitle: { ...theme.type.ui, color: c.white },
  rowCurrent: { color: c.mint },
  rowDate: { ...theme.type.small, color: c.text3 },
});
