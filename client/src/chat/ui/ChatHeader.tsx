import { useLayoutEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';
import type { ConversationSummary } from '../api';
import { described } from './described';
import { HistoryMenu } from './HistoryMenu';

// The chat's header: the open conversation's title on the left; History, New chat and Questions and activity on the
// right (they wrap under the title on phones). History and New chat are off while a reply streams, so the open
// conversation can't change under it; the panel button is never off. History is a disclosure over HistoryMenu:
// Escape closes it and focus goes back to the button.

type Host = React.ComponentRef<typeof View>;

export const NEW_CONVERSATION = 'New conversation';

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
  title: string;
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
  const { phone } = useBreakpoint();
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

  return (
    <View style={styles.header}>
      <View style={styles.bar}>
        <Text style={[styles.title, phone ? styles.titleFull : null]} numberOfLines={1}>
          {props.title === '' ? NEW_CONVERSATION : props.title}
        </Text>
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
        <HistoryMenu
          id={menuId}
          conversations={props.conversations}
          openId={props.openId}
          streaming={props.streaming}
          readOnlyId={props.readOnlyId}
          onOpen={(id) => {
            setOpened(false);
            props.onOpen(id);
          }}
          onClose={close}
          onDelete={props.onDelete}
          onRename={props.onRename}
        />
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  header: { gap: theme.space[2], borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border, paddingBottom: theme.space[2] },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4] },
  title: { ...theme.type.ui, color: c.text2, flex: 1, minWidth: 0 },
  titleFull: { flexBasis: '100%' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4] },
  link: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  linkText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  linkOff: { color: c.text3, textDecorationColor: c.border },
});
