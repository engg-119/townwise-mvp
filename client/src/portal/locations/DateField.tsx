import { FormField } from '../ui/FormField';

// A calendar date on iOS and Android: the client has no date picker (adding one is a new dependency), so it is a
// FormField that takes YYYY-MM-DD. DateField.web.tsx is the browser's own date input.

export interface DateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  messages?: readonly string[];
  /** The messages come back from a submit: announced, as FormField's `alert`. */
  alert?: boolean;
}

export function DateField(props: DateFieldProps): React.JSX.Element {
  return (
    <FormField
      label={props.label}
      value={props.value}
      onChangeText={props.onChange}
      placeholder="YYYY-MM-DD"
      keyboardType="numbers-and-punctuation"
      autoCorrect={false}
      maxLength={10}
      numeric
      {...(props.helper === undefined ? {} : { helper: props.helper })}
      {...(props.messages === undefined ? {} : { messages: props.messages })}
      {...(props.alert === undefined ? {} : { alert: props.alert })}
    />
  );
}
