import { useLayoutEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';
import type { ConversationSummary } from '../api';
import { described } from './described';
import { HistoryMenu } from './HistoryMenu';

// The chat's header: History, New chat and Questions and activity at the right, wrapping on narrow phones. It shows
// no title and draws no rule, so the thread gets the height; History's list marks the open conversation. History
// and New chat are off while a reply streams, so the open conversation can't change under it; the panel button is
// never off. History is a disclosure over HistoryMenu: Escape or opening a conversation closes it and focus goes
// back to the button, as it does after a delete.

type Host = React.ComponentRef<typeof View>;

/**
 * "Questions and activity", with " ({n})" while n questions are open: it opens and closes the panel (a column from
 * 1024px, a sheet below) and is never off. The page also shows it alone while TownwiseAI is off or can't load, since
 * the panel works either way (spec 10.12).
 */
export function PanelButton(props: {
  open: boolean;
  openQuestions: number | null;
  onPress: () => void;
  /** Where the panel sheet returns focus to (web). */
  buttonRef?: React.RefObject<Host | null>;
}): React.JSX.Element {
  const count = props.openQuestions !== null && props.openQuestions > 0 ? ` (${String(props.openQuestions)})` : '';
  return (
    <Pressable
      ref={props.buttonRef ?? null}
      role="button"
      aria-expanded={props.open}
      accessibilityState={{ expanded: props.open }}
      onPress={props.onPress}
      style={styles.link}
    >
      <Text style={styles.linkText}>{`Questions and activity${count}`}</Text>
    </Pressable>
  );
}

export function ChatHeader(props: {
  conversations: readonly ConversationSummary[];
  openId: string | null;
  streaming: boolean;
  readOnlyId: string | null;
  panelOpen: boolean;
  openQuestions: number | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onTogglePanel: () => void;
  /** Where the panel sheet returns focus to (web). */
  panelButtonRef?: React.RefObject<Host | null>;
}): React.JSX.Element {
  const [opened, setOpened] = useState(false);
  // A reply that starts streaming shuts the list.
  const open = opened && !props.streaming;
  const button = useRef<Host>(null);
  const menuId = 'chat-history-menu';

  function close(): void {
    setOpened(false);
    if (Platform.OS === 'web') button.current?.focus();
  }

  // Like Button's disabled state: aria-disabled on the same element, which keeps its focus (web).
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = button.current as unknown as { setAttribute: (n: string, v: string) => void; removeAttribute: (n: string) => void } | null;
    if (props.streaming) element?.setAttribute('aria-disabled', 'true');
    else element?.removeAttribute('aria-disabled');
  }, [props.streaming]);

  // On web History floats over the thread instead of pushing it down. Native keeps it in the flow: Android does not
  // deliver a touch to a child drawn outside its parent's box.
  const float = Platform.OS === 'web';

  return (
    <View style={[styles.header, float ? styles.raised : null]}>
      <View style={styles.bar}>
        <View testID="chat-header-controls" style={styles.controls}>
          <Pressable
            ref={button}
            role="button"
            aria-expanded={open}
            aria-controls={menuId}
            {...(props.streaming ? {} : { onPress: () => { if (open) close(); else setOpened(true); } })}
            accessibilityState={{ ...(Platform.OS === 'web' ? {} : { disabled: props.streaming }), expanded: open }}
            style={styles.link}
          >
            <Text style={[styles.linkText, props.streaming ? styles.linkOff : null]}>History</Text>
          </Pressable>
          <Button
            variant="link"
            label="New chat"
            disabled={props.streaming || props.readOnlyId !== null}
            {...described(props.readOnlyId)}
            onPress={() => {
              setOpened(false);
              props.onNew();
            }}
          />
          <PanelButton
            open={props.panelOpen}
            openQuestions={props.openQuestions}
            onPress={props.onTogglePanel}
            {...(props.panelButtonRef === undefined ? {} : { buttonRef: props.panelButtonRef })}
          />
        </View>
      </View>
      {open ? (
        <View testID="chat-history-popover" style={float ? styles.popover : null}>
          <HistoryMenu
            id={menuId}
            conversations={props.conversations}
            openId={props.openId}
            streaming={props.streaming}
            readOnlyId={props.readOnlyId}
            onOpen={(id) => {
              // The row goes with the list: focus goes back to History.
              close();
              props.onOpen(id);
            }}
            onClose={close}
            onDismiss={() => { setOpened(false); }}
            anchor={button}
            onDeleted={() => { if (Platform.OS === 'web') button.current?.focus(); }}
            onDelete={props.onDelete}
            onRename={props.onRename}
          />
        </View>
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  header: { gap: theme.space[2] },
  // Above the thread, which follows it, so the popover is drawn over it.
  raised: { position: 'relative', zIndex: 2 },
  popover: { position: 'absolute', top: '100%', right: 0, width: 360, maxWidth: '100%', marginTop: theme.space[1] },
  bar: { flexDirection: 'row', justifyContent: 'flex-end' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4] },
  link: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  linkText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  linkOff: { color: c.text3, textDecorationColor: c.border },
});
