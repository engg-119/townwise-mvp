import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { webAria } from '../../portal/ui/aria';
import { theme } from '../../theme';
import type { ConversationSummary } from '../api';
import { HistoryMenu } from './HistoryMenu';
import { HistoryIcon, NewChatIcon, QuestionsIcon } from './icons';

// The chat's header: History, New chat and Questions and activity at the right, wrapping on narrow phones. Each is a
// 44px icon named by its words (owner request, 2026-11-18: "use icons for the new chat and history buttons and the
// questions and activity instead of just saying them"), and on web hovering or focusing it shows those words in a
// tooltip under it, never over it (the rule of the chart tooltips: keep a tooltip off what it describes); native reads
// the name. The open questions are a badge on Questions and activity's icon, and its name says them. It shows no
// title and draws no rule, so the thread gets the height; History's list marks the open conversation. History
// and New chat work while a reply streams (owner request, 2026-11-18): leaving the conversation only stops following
// its reply, which runs on (useTuningChat). New chat is off under view-as; the panel button is never off. History is a
// disclosure over HistoryMenu: Escape or opening a conversation closes it and focus goes back to the button, as it
// does after a delete.

type Host = React.ComponentRef<typeof View>;

const web = Platform.OS === 'web';

/**
 * A header control: a 44px square holding `icon` in the color its words would have, named `name`. On web, hover or
 * focus shows `tip` in a tooltip under it (aria-hidden: the name already says it). A disabled one keeps its place and
 * its focus, as ChatButton's: aria-disabled on web, no press handler.
 */
function HeaderButton(props: {
  name: string;
  tip: string;
  icon: (color: string) => React.ReactNode;
  /** A count drawn on the icon (the name says it too); none when null or 0. */
  badge?: number | null;
  expanded?: boolean;
  controls?: string;
  disabled?: boolean;
  describedBy?: string | undefined;
  onPress: () => void;
  hostRef?: React.RefObject<Host | null> | undefined;
}): React.JSX.Element {
  const own = useRef<Host>(null);
  const ref = props.hostRef ?? own;
  const disabled = props.disabled === true;
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    if (!web) return;
    const element = ref.current as unknown as Element | null;
    if (disabled) element?.setAttribute('aria-disabled', 'true');
    else element?.removeAttribute('aria-disabled');
  }, [disabled, ref]);
  const badge = props.badge ?? 0;
  return (
    <View style={styles.anchor}>
      <Pressable
        ref={ref}
        role="button"
        accessibilityLabel={props.name}
        {...(web ? {} : {
          disabled,
          accessibilityState: { disabled, ...(props.expanded === undefined ? {} : { expanded: props.expanded }) },
        })}
        {...webAria({ 'aria-expanded': props.expanded, 'aria-controls': props.controls, 'aria-describedby': props.describedBy })}
        {...(disabled ? {} : { onPress: props.onPress })}
        onHoverIn={() => { setHover(true); }}
        onHoverOut={() => { setHover(false); }}
        onFocus={() => { setFocused(true); }}
        onBlur={() => { setFocused(false); }}
        style={[styles.icon, hover && !disabled ? styles.iconHover : null, disabled ? styles.inert : null]}
      >
        {props.icon(disabled ? c.text3 : c.white)}
        {badge > 0 ? (
          <View testID="chat-badge" aria-hidden style={styles.badge}>
            <Text style={styles.badgeText}>{String(badge)}</Text>
          </View>
        ) : null}
      </Pressable>
      {web && (hover || focused) ? (
        <View testID="chat-tooltip" aria-hidden style={TIP}>
          <Text style={styles.tipText}>{props.tip}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The panel button's words: "Questions and activity", with " ({n})" while n questions are open. */
export function panelName(openQuestions: number | null): string {
  return `Questions and activity${openQuestions !== null && openQuestions > 0 ? ` (${String(openQuestions)})` : ''}`;
}

/**
 * Questions and activity's icon, its open questions a badge: it opens and closes the panel and is never off. The page
 * also shows it alone while TownwiseAI is off or can't load, since the panel works either way (spec 10.12).
 */
export function PanelButton(props: {
  open: boolean;
  openQuestions: number | null;
  onPress: () => void;
  /** Where the panel sheet returns focus to (web). */
  buttonRef?: React.RefObject<Host | null>;
}): React.JSX.Element {
  return (
    <HeaderButton
      name={panelName(props.openQuestions)}
      tip="Questions and activity"
      icon={(color) => <QuestionsIcon color={color} />}
      badge={props.openQuestions}
      expanded={props.open}
      onPress={props.onPress}
      hostRef={props.buttonRef}
    />
  );
}

export function ChatHeader(props: {
  conversations: readonly ConversationSummary[];
  openId: string | null;
  /** A reply streams: History's Rename and Delete wait for it. */
  streaming: boolean;
  readOnlyId: string | null;
  panelOpen: boolean;
  openQuestions: number | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onTogglePanel: () => void;
  /** History opened or closed (its list is read again every 3 seconds while open and a conversation is replying). */
  onListOpen?: (open: boolean) => void;
  /** Where the panel sheet returns focus to (web). */
  panelButtonRef?: React.RefObject<Host | null>;
}): React.JSX.Element {
  const [open, setOpened] = useState(false);
  const button = useRef<Host>(null);
  const { onListOpen } = props;
  useEffect(() => {
    onListOpen?.(open);
  }, [open, onListOpen]);
  useEffect(() => () => { onListOpen?.(false); }, [onListOpen]);
  const menuId = 'chat-history-menu';

  function close(): void {
    setOpened(false);
    if (Platform.OS === 'web') button.current?.focus();
  }

  // On web History floats over the thread instead of pushing it down. Native keeps it in the flow: Android does not
  // deliver a touch to a child drawn outside its parent's box.
  const float = Platform.OS === 'web';

  return (
    <View style={[styles.header, float ? styles.raised : null]}>
      <View style={styles.bar}>
        <View testID="chat-header-controls" style={styles.controls}>
          <HeaderButton
            name="History"
            tip="History"
            icon={(color) => <HistoryIcon color={color} />}
            expanded={open}
            controls={menuId}
            hostRef={button}
            onPress={() => { if (open) close(); else setOpened(true); }}
          />
          <HeaderButton
            name="New chat"
            tip="New chat"
            icon={(color) => <NewChatIcon color={color} />}
            disabled={props.readOnlyId !== null}
            describedBy={props.readOnlyId ?? undefined}
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

/** The header while the page loads (AgentChat's skeleton): its three icons' 44px squares, in the header's own row. */
export function ChatHeaderSkeleton(): React.JSX.Element {
  return (
    <View testID="skeleton-chat-header" style={styles.header}>
      <View style={styles.bar}>
        <View style={styles.controls}>
          <IconShape />
          <IconShape />
          <IconShape />
        </View>
      </View>
    </View>
  );
}

/** A header icon in a skeleton: the 44px square, its icon a `raised` block. */
export function IconShape(): React.JSX.Element {
  return <View style={styles.icon}><View style={styles.iconBar} /></View>;
}

const c = theme.color;

// Under its button, right-aligned with it (the header's controls sit at the page's right edge), over what follows, one
// line as wide as its words (web only, where it is drawn).
const TIP = {
  position: 'absolute', top: '100%', right: 0, marginTop: theme.space[1], zIndex: 3, pointerEvents: 'none', width: 'max-content',
  paddingVertical: 6, paddingHorizontal: 10, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
} as unknown as ViewStyle;

const styles = StyleSheet.create({
  header: { gap: theme.space[2] },
  // Above the thread, which follows it, so the popover is drawn over it.
  raised: { position: 'relative', zIndex: 2 },
  popover: { position: 'absolute', top: '100%', right: 0, width: 360, maxWidth: '100%', marginTop: theme.space[1] },
  bar: { flexDirection: 'row', justifyContent: 'flex-end' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[2] },
  anchor: { position: 'relative' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconHover: { backgroundColor: c.raised },
  /** No pointer cursor on a control that does nothing. */
  inert: { cursor: 'auto' as const },
  iconBar: { width: 20, height: 20, backgroundColor: c.raised },
  badge: {
    position: 'absolute', top: 4, right: 2, minWidth: 16, height: 16, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.mint,
  },
  badgeText: { ...theme.type.mono, fontSize: 11, lineHeight: 16, color: c.onMint },
  tipText: { ...theme.type.small, color: c.white },
});
