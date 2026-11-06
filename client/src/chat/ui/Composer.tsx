import { useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, TextInput, View, type TextInputKeyPressEvent } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { formatCount } from '../../portal/format';
import { webAria } from '../../portal/ui/aria';
import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';
import { described } from './described';

// The composer (spec P25). The label is drawn from tablet up and is the input's name on phones, where the
// composer is one row. Under it, the privacy line: leave out guest names. The input grows from one line to 200px,
// then scrolls; from 3,600 characters a counter shows. On web Enter sends and Shift+Enter is a new line, and Enter
// while an input method is composing does nothing; on native Return is a new line and the button sends. The button
// is Send, or Stop while a reply streams.

export const MAX_MESSAGE = 4000;
const COUNTER_FROM = 3600;
const MAX_HEIGHT = 200;
const INPUT_BORDER = 1;
export const COMPOSER_LABEL = 'Ask about your sales, or tell TownwiseAI what it can’t see';

export interface ComposerHandle { focus: () => void }

interface KeyEvent {
  key: string;
  shiftKey?: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  preventDefault: () => void;
}

export function Composer(props: {
  /** Lets the page focus the input (a Tell suggestion). */
  focusRef?: React.Ref<ComposerHandle>;
  draft: string;
  onChange: (text: string) => void;
  streaming: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
  /** "Leave out guest names. TownwiseAI answers from …" */
  help: string;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { phone } = useBreakpoint();
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const readOnly = props.readOnlyId !== null;
  useImperativeHandle(props.focusRef, () => ({ focus: () => { input.current?.focus(); } }), []);
  // A web textarea doesn't grow: it starts at one line (`rows`) and takes its text's height, within the 44px
  // minimum and the maximum. Native multiline inputs size themselves.
  useLayoutEffect(() => {
    const node = Platform.OS === 'web' ? (input.current as unknown as HTMLTextAreaElement | null) : null;
    if (node === null) return;
    node.style.setProperty('height', '');
    node.style.setProperty('height', `${String(node.scrollHeight + 2 * INPUT_BORDER)}px`);
  }, [phone, props.draft]);

  function onKeyPress(event: TextInputKeyPressEvent): void {
    if (Platform.OS !== 'web') return;
    const key = event as unknown as KeyEvent;
    if (key.key !== 'Enter' || key.shiftKey === true) return;
    if (key.nativeEvent.isComposing === true || key.nativeEvent.keyCode === 229) return;
    key.preventDefault();
    if (props.canSend) props.onSend();
  }

  const helpId = 'composer-help';
  let action: React.JSX.Element;
  if (props.streaming) action = <Button label="Stop" disabled={readOnly} {...described(props.readOnlyId)} onPress={props.onStop} />;
  else action = <Button label="Send" disabled={readOnly || !props.canSend} {...described(props.readOnlyId)} onPress={props.onSend} />;
  const field = (
    <TextInput
      ref={input}
      accessibilityLabel={COMPOSER_LABEL}
      value={props.draft}
      onChangeText={props.onChange}
      onKeyPress={onKeyPress}
      editable={!readOnly}
      {...webAria({ 'aria-readonly': readOnly ? true : undefined, 'aria-describedby': readOnly ? `${props.readOnlyId ?? ''} ${helpId}` : helpId })}
      multiline
      {...(Platform.OS === 'web' ? { rows: 1 } : {})}
      maxLength={MAX_MESSAGE}
      placeholder={phone ? 'Ask TownwiseAI' : 'Ask about a closure, an event or an unusual day'}
      placeholderTextColor={theme.color.text3}
      style={[styles.input, phone ? styles.inputInRow : null, readOnly ? styles.inputReadOnly : null]}
    />
  );
  const counter = props.draft.length >= COUNTER_FROM
    ? <Text style={styles.counter}>{`${formatCount(props.draft.length)} of ${formatCount(MAX_MESSAGE)}`}</Text>
    : null;
  const help = <Text nativeID={helpId} style={styles.help}>{props.help}</Text>;
  if (phone) {
    return (
      <View style={styles.composer}>
        <View style={styles.row}>{field}{action}</View>
        {counter}
        {help}
      </View>
    );
  }
  return (
    <View style={styles.composer}>
      <Text style={styles.label}>{COMPOSER_LABEL}</Text>
      {field}
      {counter}
      <View style={styles.foot}>
        <View style={styles.helpBox}>{help}</View>
        {action}
      </View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  composer: { gap: theme.space[2], paddingTop: theme.space[3] },
  row: { flexDirection: 'row', alignItems: 'flex-end', columnGap: theme.space[2] },
  label: { ...theme.type.ui, color: c.white },
  input: {
    ...theme.type.sub, minHeight: 44, maxHeight: MAX_HEIGHT, paddingHorizontal: 12, paddingVertical: 10, color: c.white,
    backgroundColor: c.ground, borderWidth: INPUT_BORDER, borderColor: c.line, borderRadius: 0, textAlignVertical: 'top',
  },
  inputInRow: { flex: 1, minWidth: 0 },
  inputReadOnly: { color: c.text3, borderColor: c.border },
  counter: { ...theme.type.mono, color: c.text2 },
  foot: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space[4] },
  helpBox: { flex: 1, minWidth: 0 },
  help: { ...theme.type.small, color: c.text2 },
});
