import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { versionsOf, type TreeNode } from '../tree';
import type { ChatMessage, TuningChat } from '../useTuningChat';
import { Announce, ChatButton, Hidden, type ChatButtonHandle } from './controls';

// The ‹ n/m › navigator under a message or reply with more than one version (owner decision 3, "Edit sent
// messages"): a group "Versions" with "Previous version", the mono "{n}/{m}" read as "Version {n} of {m}", and "Next
// version". Its ends, and both arrows while a reply streams, are aria-disabled and stay focusable. Square, like every
// control on the chat page but the composer, bubbles and chips.
//
// A version switch reads the whole path again, so the message that shows the other version is drawn anew and the
// arrow that was pressed is gone. useVersionNav keeps focus there anyway: the press is held here until the
// navigator of a version of the same node (same conversation, parent and role) appears, which focuses the same
// arrow and says "Showing version {n} of {m}.". The press is let go once its switch has settled without that.

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
  /** What the navigator's polite live region says: "Showing version 2 of 3." after a switch; empty otherwise. */
  announcement?: string;
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
      <Announce text={props.announcement ?? ''} />
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
 */
export function useVersionNav(chat: TuningChat, message: ChatMessage, tree: readonly TreeNode[]): {
  versions: { index: number; count: number } | null;
  focusRef: React.RefObject<VersionNavHandle | null>;
  announcement: string;
  onStep: (step: -1 | 1) => void;
} {
  const focusRef = useRef<VersionNavHandle>(null);
  const pressed = useRef<HeldPress | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const found = message.nodeId === null ? null : versionsOf(tree, message.nodeId);
  const versions = found !== null && found.count > 1 ? { index: found.index, count: found.count } : null;
  const index = versions?.index ?? 0;
  const count = versions?.count ?? 0;
  const { state } = chat;
  const group = `${state.conversationId ?? ''}\n${message.role}\n${message.parentId ?? ''}`;

  // The navigator a held press leads to takes focus on the same arrow and says which version shows. The words go in
  // after the region is on the page, so a screen reader hears them.
  useEffect(() => {
    if (count < 2) return;
    const step = take(group);
    if (step === null) return;
    if (Platform.OS === 'web') focusRef.current?.focus(step);
    const words = `Showing version ${String(index)} of ${String(count)}.`;
    setTimeout(() => {
      setAnnouncement(words);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(words);
    }, 0);
  }, [group, index, count]);

  // A switch that settled with this message still drawn (it failed, or the same element shows the other version)
  // lets go of its press, so no later navigator takes focus for it. Any change of the chat's state is a chance to
  // see that, since a fast answer can start and settle the switch in one render.
  useEffect(() => {
    if (pressed.current === null || state.switching) return;
    release(pressed.current);
    pressed.current = null;
  }, [state]);

  return {
    versions,
    focusRef,
    announcement,
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
