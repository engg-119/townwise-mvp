import { useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { webAria } from '../../portal/ui/aria';
import { theme } from '../../theme';

// The small controls of TownwiseAI's messages (the B6 message views): a button that can take focus from code and
// show a pressed state, which the portal's Button does neither of; text read by assistive technology and not drawn;
// a check that focus went with a control taken off the page; and a polite live region. Like Button, a disabled
// control keeps its place and its focus: aria-disabled on the same element on web (never the disabled attribute), no
// press handler, a `text3` label. Square, except `chip`, the chat page's pill (spec 15.6's TownwiseAI exception:
// radius 22 at 44px).

export interface ChatButtonHandle { focus: () => void }

type Variant = 'link' | 'outline' | 'chip' | 'arrow';
type Host = React.ComponentRef<typeof View>;

const web = Platform.OS === 'web';

// react-native-web reports hover in the press state; React Native's types do not declare it.
function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

export function ChatButton(props: {
  label: string;
  /** The accessible name when the label is a glyph ("‹" is "Previous version"). */
  accessibilityLabel?: string;
  variant: Variant;
  disabled?: boolean;
  /** A toggle (Helpful, Not helpful): aria-pressed on web, checked on native, and the mint fill when pressed. */
  pressed?: boolean;
  /** The read-only line's id under view-as. */
  describedBy?: string | null;
  onPress: () => void;
  focusRef?: React.Ref<ChatButtonHandle>;
}): React.JSX.Element {
  const { variant } = props;
  const disabled = props.disabled === true;
  const pressed = props.pressed === true;
  const ref = useRef<Host>(null);
  useImperativeHandle(props.focusRef, () => ({ focus: () => { ref.current?.focus(); } }), []);
  useLayoutEffect(() => {
    if (!web) return;
    const element = ref.current as unknown as Element | null;
    if (disabled) element?.setAttribute('aria-disabled', 'true');
    else element?.removeAttribute('aria-disabled');
  }, [disabled]);
  return (
    <Pressable
      ref={ref}
      role="button"
      {...(web ? {} : { disabled, accessibilityState: { disabled, ...(props.pressed === undefined ? {} : { checked: pressed }) } })}
      {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
      {...webAria({ 'aria-pressed': props.pressed, 'aria-describedby': props.describedBy ?? undefined })}
      {...(disabled ? {} : { onPress: props.onPress })}
      style={(state) => [
        boxes[variant],
        !disabled && hovered(state) ? boxHover[variant] : null,
        disabled && !pressed ? boxOff[variant] : null,
        pressed ? styles.pressed : null,
        disabled ? styles.inert : null,
      ]}
    >
      {(state) => (
        <Text
          style={[
            labels[variant],
            !disabled && hovered(state) ? labelHover[variant] : null,
            disabled && !pressed ? labelOff[variant] : null,
            pressed ? styles.pressedLabel : null,
          ]}
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

/** Read by screen readers, not drawn (a speaker label, "Version 2 of 3"). */
export function Hidden(props: { children: string }): React.JSX.Element {
  return <Text style={styles.hidden}>{props.children}</Text>;
}

/**
 * Web only: nothing holds focus, as when the focused control was taken off the page (the browser hands focus to the
 * body). Code that restores focus after a control went away checks this first, so it never takes focus from wherever
 * the person has since moved it.
 */
export function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/** A polite live region that is there before it speaks; it says `text` when that changes from empty. */
export function Announce(props: { text: string }): React.JSX.Element {
  return (
    <View style={styles.hidden} aria-live="polite" accessibilityLiveRegion="polite">
      <Text>{props.text}</Text>
    </View>
  );
}

const c = theme.color;

const box = { minHeight: 44, alignItems: 'center', justifyContent: 'center' } as const;

const boxes = StyleSheet.create({
  link: { ...box, minWidth: 44, alignItems: 'flex-start' },
  outline: { ...box, paddingHorizontal: 14, borderWidth: 1, borderColor: c.line, borderRadius: 0, backgroundColor: 'transparent' },
  chip: { ...box, paddingHorizontal: 16, borderWidth: 1, borderColor: c.line, borderRadius: 22, backgroundColor: 'transparent' },
  arrow: { ...box, minWidth: 44 },
});

const boxHover = StyleSheet.create({
  link: {},
  outline: { borderColor: c.white },
  chip: { borderColor: c.white },
  arrow: { backgroundColor: c.raised },
});

const boxOff = StyleSheet.create({
  link: {},
  outline: { borderColor: c.border },
  chip: { borderColor: c.border },
  arrow: {},
});

const labels = StyleSheet.create({
  link: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  outline: { ...theme.type.ui, color: c.white, textAlign: 'center' },
  chip: { ...theme.type.ui, color: c.white, textAlign: 'center' },
  arrow: { ...theme.type.ui, fontSize: 20, color: c.white },
});

const labelHover = StyleSheet.create({
  link: { color: c.mint, textDecorationColor: c.mint },
  outline: {},
  chip: {},
  arrow: {},
});

const labelOff = StyleSheet.create({
  link: { color: c.text3, textDecorationColor: c.border },
  outline: { color: c.text3 },
  chip: { color: c.text3 },
  arrow: { color: c.text3 },
});

const styles = StyleSheet.create({
  // The chosen rating: mint, as a pressed control (the `.tgl` pressed state, spec P14 C6).
  pressed: { backgroundColor: c.mint, borderColor: c.mint },
  pressedLabel: { color: c.onMint },
  /** No pointer cursor on a control that does nothing. */
  inert: { cursor: 'auto' },
  hidden: { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden' },
});
