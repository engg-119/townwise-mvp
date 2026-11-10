import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { versionsOf, type TreeNode } from '../tree';
import type { ChatMessage, TuningChat } from '../useTuningChat';
import { ChatButton, focusLost, Hidden, type ChatButtonHandle } from './controls';

// The ‹ n/m › navigator under a message or reply with more than one version (owner decision 3, "Edit sent
// messages"): a group "Versions" with "Previous version", the mono "{n}/{m}" read as "Version {n} of {m}", and "Next
// version". Its ends, and both arrows while a reply streams, are aria-disabled and stay focusable. Square, like every
// control on the chat page but the composer, bubbles and chips.
//
// A version switch reads the whole path again, so the message that shows the other version is drawn anew and the
// arrow that was pressed is gone. useVersionNav keeps focus there anyway: the press is held here until the
// navigator of a version of the same node (same conversation, parent and role) appears, which focuses the same
// arrow, unless the person has moved focus meanwhile, and has the page say "Showing version {n} of {m}." in its
// polite region (a region drawn with the new navigator would be filled as it appears, which screen readers skip). The
// press is let go once its switch has settled without that, or once its arrow is gone and no navigator took it.

export interface VersionNavHandle {
  /** Focuses an arrow: "Previous version" (-1, the default) or "Next version" (1). */
  focus: (arrow?: -1 | 1) => void;
}

export function VersionNav(props: {
  /** Counts from 1. */
  index: number;
  count: number;
  /** While a reply streams or another version loads. */
  disabled: boolean;
  onStep: (step: -1 | 1) => void;
  focusRef?: React.Ref<VersionNavHandle>;
}): React.JSX.Element {
  const { index, count, disabled, onStep } = props;
  const previous = useRef<ChatButtonHandle>(null);
  const next = useRef<ChatButtonHandle>(null);
  useImperativeHandle(props.focusRef, () => ({
    focus: (arrow = -1) => { (arrow === 1 ? next : previous).current?.focus(); },
  }), []);
  return (
    <View role="group" aria-label="Versions" style={styles.nav}>
      <ChatButton
        focusRef={previous}
        variant="arrow"
        label="‹"
        accessibilityLabel="Previous version"
        disabled={disabled || index <= 1}
        onPress={() => { onStep(-1); }}
      />
      <Text aria-hidden style={styles.count}>{`${String(index)}/${String(count)}`}</Text>
      <Hidden>{`Version ${String(index)} of ${String(count)}`}</Hidden>
      <ChatButton
        focusRef={next}
        variant="arrow"
        label="›"
        accessibilityLabel="Next version"
        disabled={disabled || index >= count}
        onPress={() => { onStep(1); }}
      />
    </View>
  );
}

interface HeldPress { group: string; step: -1 | 1 }

/** The arrow last pressed, until the navigator it leads to takes focus or its switch settles without one. */
const held: { press: HeldPress | null } = { press: null };

function hold(press: HeldPress): void {
  held.press = press;
}

function take(group: string): (-1 | 1) | null {
  const press = held.press;
  if (press?.group !== group) return null;
  held.press = null;
  return press.step;
}

function release(press: HeldPress): void {
  if (held.press === press) held.press = null;
}

/** Tests only: a held press outlives the test that made it. */
export function resetVersionFocus(): void {
  held.press = null;
}

/**
 * A message's or reply's versions and its navigator's behavior: null versions when it has no siblings (or isn't
 * saved yet), `onStep` to show the version before or after, and the focus and announcement that follow a switch.
 * `onAnnounce` is the page's: see ReplyView's prop of that name.
 */
export function useVersionNav(chat: TuningChat, message: ChatMessage, tree: readonly TreeNode[], onAnnounce: (words: string) => void): {
  versions: { index: number; count: number } | null;
  focusRef: React.RefObject<VersionNavHandle | null>;
  onStep: (step: -1 | 1) => void;
} {
  const focusRef = useRef<VersionNavHandle>(null);
  const pressed = useRef<HeldPress | null>(null);
  // The newest callback, without making a new one mean a new switch to say.
  const announce = useRef(onAnnounce);
  useLayoutEffect(() => { announce.current = onAnnounce; });
  const found = message.nodeId === null ? null : versionsOf(tree, message.nodeId);
  const versions = found !== null && found.count > 1 ? { index: found.index, count: found.count } : null;
  const index = versions?.index ?? 0;
  const count = versions?.count ?? 0;
  const { state } = chat;
  const group = `${state.conversationId ?? ''}\n${message.role}\n${message.parentId ?? ''}`;

  // The navigator a held press leads to takes focus on the same arrow, if focus went with the arrow that was pressed
  // (not if the person moved it, say into the composer, while the version loaded), and says which version shows.
  useEffect(() => {
    if (count < 2) return;
    const step = take(group);
    if (step === null) return;
    if (Platform.OS === 'web' && focusLost()) focusRef.current?.focus(step);
    announce.current(`Showing version ${String(index)} of ${String(count)}.`);
  }, [group, index, count]);

  // A switch that settled with this message still drawn (it failed, or the same element shows the other version)
  // lets go of its press, so no later navigator takes focus for it. Any change of the chat's state is a chance to
  // see that, since a fast answer can start and settle the switch in one render.
  useEffect(() => {
    if (pressed.current === null || state.switching) return;
    release(pressed.current);
    pressed.current = null;
  }, [state]);

  // A press whose arrow went is good only for the commit that took it away: a navigator that commit drew has taken it
  // by the time this runs. Otherwise (another conversation opened, or New chat, before the version came) it is let go,
  // so a navigator drawn later, back in this conversation, takes no focus and says nothing.
  useEffect(() => () => {
    const press = pressed.current;
    if (press !== null) void Promise.resolve().then(() => { release(press); });
  }, []);

  return {
    versions,
    focusRef,
    onStep: (step) => {
      const press = { group, step };
      pressed.current = press;
      hold(press);
      chat.showVersion(message.key, step);
    },
  };
}

const c = theme.color;

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center' },
  count: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2, minWidth: 28, textAlign: 'center' },
});
