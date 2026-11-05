import { useId, useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { theme } from '../../theme';
import { ids, webAria } from './aria';
import { Messages } from './feedback';

// FormField (spec 15.7): a `ui` white label, a `ground` input with a 1px `line` border, square corners, at least
// 44px tall with 16px text, a `small` helper tied by aria-describedby, and field messages in the numbered ruled
// list with aria-invalid on the field. Focus turns the border mint (the ring itself is the shell's focus-visible
// style on web). Under view-as the field is read-only and described by the read-only line.

export interface FieldChrome {
  label: string;
  helper?: string;
  /** Field messages; any message marks the field invalid. */
  messages?: readonly string[];
  /** View-as: the field shows its value and cannot change. */
  readOnly?: boolean;
  /** The id of the ReadOnlyLine that explains why. */
  readOnlyId?: string;
}

export function useFieldIds(): { label: string; helper: string; messages: string } {
  const id = useId().replace(/:/g, '');
  return { label: `${id}-label`, helper: `${id}-help`, messages: `${id}-msgs` };
}

export function FieldFrame(props: FieldChrome & { ids: ReturnType<typeof useFieldIds>; children: React.ReactNode }): React.JSX.Element {
  const { messages = [] } = props;
  return (
    <View style={styles.field}>
      <Text nativeID={props.ids.label} style={styles.label}>{props.label}</Text>
      {props.children}
      {props.helper === undefined ? null : <Text nativeID={props.ids.helper} style={styles.help}>{props.helper}</Text>}
      {messages.length === 0 ? null : <Messages nativeID={props.ids.messages} items={messages} />}
    </View>
  );
}

/** The ids a field is described by: its helper, its messages and the read-only line. */
export function describedBy(chrome: FieldChrome, fieldIds: ReturnType<typeof useFieldIds>): string | undefined {
  return ids(
    chrome.helper !== undefined && fieldIds.helper,
    (chrome.messages?.length ?? 0) > 0 && fieldIds.messages,
    chrome.readOnly === true && chrome.readOnlyId,
  );
}

export interface FormFieldProps extends FieldChrome, Omit<TextInputProps, 'style' | 'readOnly' | 'editable'> {
  /** Numbers and dates: mono with tabular figures (`.inp-n`). */
  numeric?: boolean;
}

export function FormField(props: FormFieldProps): React.JSX.Element {
  const { label, helper, messages, readOnly, readOnlyId, numeric, multiline, onFocus, onBlur, ...input } = props;
  const fieldIds = useFieldIds();
  const [focused, setFocused] = useState(false);
  const invalid = (messages?.length ?? 0) > 0;
  const chrome: FieldChrome = {
    label,
    ...(helper === undefined ? {} : { helper }),
    ...(messages === undefined ? {} : { messages }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(readOnlyId === undefined ? {} : { readOnlyId }),
  };
  return (
    <FieldFrame {...chrome} ids={fieldIds}>
      <TextInput
        accessibilityLabel={label}
        {...(helper === undefined ? {} : { accessibilityHint: helper })}
        autoCapitalize="none"
        placeholderTextColor={theme.color.text3}
        {...input}
        editable={readOnly !== true}
        multiline={multiline === true}
        {...webAria({
          'aria-invalid': invalid ? true : undefined,
          'aria-describedby': describedBy(chrome, fieldIds),
          'aria-readonly': readOnly === true ? true : undefined,
        })}
        onFocus={(event) => { setFocused(true); onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); onBlur?.(event); }}
        style={[
          styles.input,
          numeric === true ? styles.numeric : null,
          multiline === true ? styles.textarea : null,
          focused && readOnly !== true ? styles.focused : null,
          readOnly === true ? styles.readOnly : null,
        ]}
      />
    </FieldFrame>
  );
}

const c = theme.color;

export const fieldStyles = StyleSheet.create({
  input: {
    ...theme.type.sub, fontSize: 16, minHeight: 44, paddingHorizontal: 12, color: c.white, backgroundColor: c.ground,
    borderWidth: 1, borderColor: c.line, borderRadius: 0,
  },
  focused: { borderColor: c.mint },
  readOnly: { color: c.text3, borderColor: c.border },
});

const styles = StyleSheet.create({
  field: { gap: theme.space[2], minWidth: 0 },
  label: { ...theme.type.ui, color: c.white },
  help: { ...theme.type.small, color: c.text2 },
  input: fieldStyles.input,
  numeric: { fontFamily: theme.type.mono.fontFamily, fontVariant: ['tabular-nums'] },
  textarea: { minHeight: 132, paddingVertical: 10, textAlignVertical: 'top' },
  focused: fieldStyles.focused,
  readOnly: fieldStyles.readOnly,
});
