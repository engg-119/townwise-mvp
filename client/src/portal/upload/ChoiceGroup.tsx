import { useId } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { ids, webAria } from '../ui/aria';
import { Messages } from '../ui/feedback';

// A row of pressed-state buttons under a legend (the shell's `.tgl` in a fieldset): the pressed one takes the
// mint fill and a ground label, as pressed controls do (spec 15.6). Field messages print under it in the ruled
// list.

export interface Choice<T extends string> { value: T; label: string }

function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

export function ChoiceGroup<T extends string>(props: {
  legend: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  helper?: string;
  messages?: readonly string[];
  /** The messages' id, for a control elsewhere that they explain. */
  messagesId?: string;
}): React.JSX.Element {
  const id = useId().replace(/:/g, '');
  const messages = props.messages ?? [];
  const messagesId = props.messagesId ?? `${id}-msgs`;
  const describedBy = ids(props.helper !== undefined && `${id}-help`, messages.length > 0 && messagesId);
  return (
    <View role="group" aria-labelledby={`${id}-legend`} style={styles.field}>
      <Text nativeID={`${id}-legend`} style={styles.legend}>{props.legend}</Text>
      <View style={styles.row}>
        {props.choices.map((choice) => {
          const pressed = choice.value === props.value;
          return (
            <Pressable
              key={choice.value}
              role="button"
              accessibilityState={{ selected: pressed }}
              {...webAria({ 'aria-pressed': pressed, 'aria-describedby': describedBy })}
              onPress={() => { props.onChange(choice.value); }}
              style={[styles.button, pressed ? styles.pressed : null]}
            >
              {(state) => (
                <Text style={[styles.label, !pressed && hovered(state) ? styles.hover : null, pressed ? styles.labelPressed : null]}>
                  {choice.label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
      {props.helper === undefined ? null : <Text nativeID={`${id}-help`} style={styles.help}>{props.helper}</Text>}
      {messages.length === 0 ? null : <Messages nativeID={messagesId} items={messages} />}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  field: { gap: theme.space[2], minWidth: 0 },
  legend: { ...theme.type.ui, color: c.white },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  button: {
    minWidth: 44, minHeight: 44, paddingHorizontal: 10, justifyContent: 'center', borderWidth: 1, borderColor: c.line, borderRadius: 0,
  },
  pressed: { backgroundColor: c.mint, borderColor: c.mint },
  label: { ...theme.type.ui, color: c.text2 },
  hover: { color: c.white },
  labelPressed: { color: c.onMint },
  help: { ...theme.type.small, color: c.text2 },
});
