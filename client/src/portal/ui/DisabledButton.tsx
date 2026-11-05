import { Pressable, StyleSheet, Text } from 'react-native';

import { theme } from '../../theme';
import type { ButtonVariant } from './Button';

// A disabled control on iOS and Android: disabled for the screen reader (accessibilityState) and to the touch,
// in place, with a `text3` label and a `border` outline (spec 15.7). DisabledButton.web.tsx keeps it focusable.

export interface DisabledButtonProps {
  label: string;
  variant: ButtonVariant;
  accessibilityLabel?: string;
  describedBy?: string;
  block: boolean;
}

export function DisabledButton(props: DisabledButtonProps): React.JSX.Element {
  return (
    <Pressable
      role="button"
      disabled
      {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
      style={[box[props.variant], props.block ? styles.block : styles.inline]}
    >
      <Text style={label[props.variant]}>{props.label}</Text>
    </Pressable>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  inline: { alignSelf: 'flex-start' },
  block: { alignSelf: 'stretch' },
});

const box = StyleSheet.create({
  primary: {
    minHeight: 44, paddingHorizontal: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised,
    borderWidth: 1, borderColor: c.border,
  },
  outline: { minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  link: { minHeight: 44, minWidth: 44, alignItems: 'flex-start', justifyContent: 'center' },
});

const label = StyleSheet.create({
  primary: { ...theme.type.button, color: c.text3 },
  outline: { ...theme.type.ui, color: c.text3, textAlign: 'center' },
  link: { ...theme.type.ui, color: c.text3, textDecorationLine: 'underline', textDecorationColor: c.border },
});
