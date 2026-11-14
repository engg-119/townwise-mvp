import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View,
  type TextInputContentSizeChangeEvent, type TextInputKeyPressEvent,
} from 'react-native';

import { useReducedMotion } from '../../motion';
import { formatCount } from '../../portal/format';
import { useBreakpoint } from '../../portal/hooks';
import { ids, webAria } from '../../portal/ui/aria';
import { theme } from '../../theme';
import { composerKey, EXAMPLE_MS, nextExample } from '../composerKeys';
import { ChatButton } from './controls';
import { ArrowUp, Expand, Shrink, StopSquare } from './icons';

// The TownwiseAI composer: one rounded box (spec 15.6's chat-page exception) with 5px inside its border, a row of
// [leading] [input] [button], the button a 44px circle drawn as an icon (an up arrow to send, a square to stop),
// that becomes the input above [leading] ... [button] once the text needs a second line. Then Expand, at the box's
// top right, makes the input 60% of the window tall until Shrink or until the draft is sent (emptied). The input grows to 200px,
// then scrolls; from 3,600 characters a counter shows; the help line sits under the box. The input's name is the
// label (nothing visible). On web Enter sends (not while a reply streams, not while an input method composes),
// Shift+Enter is a new line, and Tab in an empty composer accepts the shown example; on native Return is a new
// line and the button sends. The examples rotate on web from 641px, never under reduced motion. Files attached to the
// message (web, D36) show as a first row inside the box, above the input, and the placeholder then asks about them.

export const MAX_MESSAGE = 4000;
const COUNTER_FROM = 3600;
const MAX_HEIGHT = 200;
const ONE_LINE_BOX = 44;
const INPUT_PADDING = 20;
export const COMPOSER_LABEL = 'Ask about your sales, or tell TownwiseAI what it can’t see';
const STATIC_PLACEHOLDER = 'Ask about a closure, an event or an unusual day';
export const ATTACHED_PLACEHOLDER = 'Ask about the attached file';

export interface ComposerHandle { focus: () => void }

export interface ComposerProps {
  /** Lets the page focus the input (a Tell suggestion). */
  focusRef?: React.Ref<ComposerHandle>;
  draft: string;
  onChange: (text: string) => void;
  streaming: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
  onStopAndSend: () => void;
  /** "Leave out guest names. TownwiseAI answers from …" under the pill. */
  help: string;
  /** Rotating placeholder examples (web, from 641px); [] keeps the static placeholder. */
  examples: readonly string[];
  readOnlyId: string | null;
  /** 'landing': centered in an empty conversation; 'dock': under the thread. Same box either way. */
  placement: 'landing' | 'dock';
  /**
   * A leading slot inside the pill, before the input: the + that attaches files (ComposerFiles), on web while stored
   * files are on. Rendered only when given.
   */
  leading?: React.ReactNode;
  /**
   * The attachments slot: the message's file chips (ComposerFiles), a first row inside the box, in normal flow above
   * the input. Rendered only when given.
   */
  attachments?: React.ReactNode;
  /** Files are on the message: the placeholder asks about them, and no example shows. */
  attached?: boolean;
  /** Another line Send is described by: why it waits (a file still uploading). */
  sendDescribedBy?: string | null;
}

interface KeyEvent {
  key: string;
  shiftKey?: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  preventDefault: () => void;
}

const web = Platform.OS === 'web';

function ActionButton(props: {
  /** The button's name: Send, Stop or Stop and send. */
  label: string;
  icon: 'send' | 'stop';
  disabled: boolean;
  describedBy: string | null;
  onPress: () => void;
}): React.JSX.Element {
  const { disabled } = props;
  const color = disabled ? c.text3 : c.onCta;
  // On web the same element carries aria-disabled (react-native-web would turn `disabled` into the attribute and
  // drop focus); the press handler is simply absent.
  const ref = useRef<React.ComponentRef<typeof Pressable>>(null);
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
      accessibilityLabel={props.label}
      {...(Platform.OS === 'web' ? {} : { disabled })}
      accessibilityState={{ disabled }}
      {...webAria({ 'aria-describedby': props.describedBy ?? undefined })}
      {...(disabled ? {} : { onPress: props.onPress })}
      style={[styles.button, disabled ? styles.buttonDisabled : null]}
    >
      {props.icon === 'send' ? <ArrowUp color={color} /> : <StopSquare color={color} />}
    </Pressable>
  );
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const { phone } = useBreakpoint();
  const reduced = useReducedMotion();
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);
  const [grown, setGrown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState(0);
  // Never under the usual maximum, so an unknown (0) window height changes nothing.
  const tall = Math.max(MAX_HEIGHT, Math.round(useWindowDimensions().height * 0.6));
  const readOnly = props.readOnlyId !== null;
  const empty = props.draft === '';
  // Sending empties the draft, and the box goes back to its size.
  if (empty && expanded) setExpanded(false);
  const attached = props.attached === true;
  const rotating = web && !phone && !attached && props.examples.length > 0;
  const example = rotating ? (props.examples[index % props.examples.length] ?? null) : null;
  useImperativeHandle(props.focusRef, () => ({ focus: () => { input.current?.focus(); } }), []);

  // A web textarea doesn't grow: it starts at one line (`rows`) and takes its text's height, within the 44px
  // minimum and the maximum. Native multiline inputs size themselves.
  useLayoutEffect(() => {
    const node = web ? (input.current as unknown as HTMLTextAreaElement | null) : null;
    if (node === null) return;
    node.style.setProperty('height', '');
    node.style.setProperty('height', `${String(node.scrollHeight)}px`);
  }, [phone, props.draft]);

  // The box takes its second-line layout once the text needs it and keeps it until the draft is empty again (the
  // input is wider in the grown layout, so the same text could otherwise flip back and forth). The size comes from
  // a ResizeObserver on web and onContentSizeChange on native, both calls from outside React.
  const draftRef = useRef(props.draft);
  useLayoutEffect(() => { draftRef.current = props.draft; });
  const measured = useCallback((height: number): void => {
    if (height > ONE_LINE_BOX) setGrown(true);
    else if (draftRef.current === '') setGrown(false);
  }, []);
  useEffect(() => {
    const node = web ? (input.current as unknown as HTMLTextAreaElement | null) : null;
    if (node === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => { measured(node.scrollHeight); });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [measured]);

  // The examples swap at once while the draft is empty; reduced motion keeps the first one.
  useEffect(() => {
    if (!rotating || !empty || reduced !== false || props.examples.length < 2) return;
    const timer = setInterval(() => { setIndex((current) => nextExample(current, props.examples.length)); }, EXAMPLE_MS);
    return () => { clearInterval(timer); };
  }, [rotating, empty, reduced, props.examples.length]);

  function onContentSizeChange(event: TextInputContentSizeChangeEvent): void {
    if (!web) measured(event.nativeEvent.contentSize.height + INPUT_PADDING);
  }

  function onKeyPress(event: TextInputKeyPressEvent): void {
    if (!web) return;
    const key = event as unknown as KeyEvent;
    const composing = key.nativeEvent.isComposing === true || key.nativeEvent.keyCode === 229;
    const action = composerKey(
      { key: key.key, shiftKey: key.shiftKey === true, isComposing: key.nativeEvent.isComposing === true, ...(key.nativeEvent.keyCode === undefined ? {} : { keyCode: key.nativeEvent.keyCode }) },
      { draft: props.draft, canSend: props.canSend && !readOnly, streaming: props.streaming, example },
    );
    if (key.key === 'Enter' && key.shiftKey !== true && !composing) key.preventDefault();
    if (action === 'send') props.onSend();
    else if (action === 'accept_example' && example !== null) {
      key.preventDefault();
      props.onChange(example);
    }
  }

  const helpId = 'composer-help';
  const hasText = props.draft.trim() !== '';
  const sendDescribedBy = ids(props.readOnlyId, props.sendDescribedBy) ?? null;
  let button: React.JSX.Element;
  if (props.streaming && hasText) button = <ActionButton label="Stop and send" icon="send" disabled={readOnly || !props.canSend} describedBy={sendDescribedBy} onPress={props.onStopAndSend} />;
  else if (props.streaming) button = <ActionButton label="Stop" icon="stop" disabled={readOnly} describedBy={props.readOnlyId} onPress={props.onStop} />;
  else button = <ActionButton label="Send" icon="send" disabled={readOnly || !props.canSend} describedBy={sendDescribedBy} onPress={props.onSend} />;

  let placeholder = phone ? 'Ask TownwiseAI' : (example ?? STATIC_PLACEHOLDER);
  if (attached) placeholder = ATTACHED_PLACEHOLDER;
  const field = (
    <TextInput
      ref={input}
      accessibilityLabel={COMPOSER_LABEL}
      value={props.draft}
      onChangeText={props.onChange}
      onKeyPress={onKeyPress}
      onContentSizeChange={onContentSizeChange}
      onFocus={() => { setFocused(true); }}
      onBlur={() => { setFocused(false); }}
      editable={!readOnly}
      {...webAria({ 'aria-readonly': readOnly ? true : undefined, 'aria-describedby': readOnly ? `${props.readOnlyId ?? ''} ${helpId}` : helpId })}
      multiline
      // The box draws the focus ring (boxFocused), so the portal's square one is left off this field.
      {...(web ? { rows: 1, dataSet: { ring: 'box' } } : {})}
      maxLength={MAX_MESSAGE}
      placeholder={placeholder}
      placeholderTextColor={theme.color.text3}
      style={[styles.input, grown ? styles.inputGrown : null, expanded ? { minHeight: tall, maxHeight: tall } : null, readOnly ? styles.inputReadOnly : null]}
    />
  );
  const counter = props.draft.length >= COUNTER_FROM
    ? <Text style={styles.counter}>{`${formatCount(props.draft.length)} of ${formatCount(MAX_MESSAGE)}`}</Text>
    : null;
  // One flat row of keyed children so the input is never remounted (and never loses focus) when the box grows or a
  // file is attached; grown, the input takes the whole first line and the rest wraps beneath it. The attachments come
  // first, a whole line of their own (leaving Expand its corner).
  const leading = props.leading === undefined || props.leading === null
    ? null
    : <View key="leading" style={styles.leading}>{props.leading}</View>;
  const files = props.attachments === undefined || props.attachments === null
    ? null
    : <View key="attachments" testID="composer-attachments" style={[styles.attachments, grown ? styles.attachmentsGrown : null]}>{props.attachments}</View>;
  const fieldKeyed = <View key="field" style={grown ? styles.fieldGrown : styles.fieldRow}>{field}</View>;
  const size = grown ? (
    <View key="size" style={styles.size}>
      <ChatButton
        variant="arrow"
        round
        label={expanded ? 'Shrink the message box' : 'Expand the message box'}
        icon={(color) => (expanded ? <Shrink color={color} /> : <Expand color={color} />)}
        onPress={() => { setExpanded((value) => !value); }}
      />
    </View>
  ) : null;
  const box = (
    <View style={[styles.box, grown || files !== null ? styles.boxGrown : null, focused ? styles.boxFocused : null]}>
      {grown
        ? [files, fieldKeyed, leading, <View key="button" style={styles.buttonEnd}>{button}</View>, size]
        : [files, leading, fieldKeyed, <View key="button" style={styles.buttonEnd}>{button}</View>]}
    </View>
  );
  return (
    <View style={[styles.composer, props.placement === 'landing' ? styles.landing : null]}>
      {box}
      {counter}
      <Text nativeID={helpId} style={styles.help}>{props.help}</Text>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  // box-none: the transparent top padding and the gaps pass wheel, touch and click through to the thread behind the dock;
  // the box, the counter and the help line (children) still take them. A click in a gap can reach thread content
  // under the dock skirt; accepted trade-off.
  composer: { gap: theme.space[2], paddingTop: theme.space[3], alignSelf: 'stretch', pointerEvents: 'box-none' },
  landing: { width: '100%' },
  box: {
    minHeight: 56, borderRadius: 28, borderWidth: 1, borderColor: c.line, backgroundColor: c.ground,
    padding: 5, flexDirection: 'row', alignItems: 'flex-end', columnGap: theme.space[2],
  },
  boxGrown: { flexWrap: 'wrap' },
  boxFocused: { borderColor: c.mint, outlineWidth: 2, outlineColor: c.mintRing, outlineStyle: 'solid' },
  input: {
    ...theme.type.sub, minHeight: ONE_LINE_BOX, maxHeight: MAX_HEIGHT, paddingHorizontal: 12, paddingVertical: 10, color: c.white,
    backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0, textAlignVertical: 'top', outlineWidth: 0,
  },
  fieldRow: { flex: 1, minWidth: 0 },
  // Grown, the input leaves room at its top right for Expand, which sits over it.
  inputGrown: { paddingRight: 52 },
  size: { position: 'absolute', top: 5, right: 5 },
  fieldGrown: { width: '100%' },
  attachments: { flexBasis: '100%', minWidth: 0 },
  // Grown, Expand sits at the box's top right, over this row: the chips leave it room.
  attachmentsGrown: { paddingRight: 48 },
  buttonEnd: { marginLeft: 'auto' },
  inputReadOnly: { color: c.text3 },
  leading: { alignSelf: 'flex-end', justifyContent: 'center', minHeight: 44 },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.cta },
  buttonDisabled: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.border },
  counter: { ...theme.type.mono, color: c.text2 },
  help: { ...theme.type.small, color: c.text2, paddingHorizontal: theme.space[2] },
});
