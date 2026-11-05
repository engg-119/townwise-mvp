import { useState } from 'react';

import { theme } from '../../theme';
import { describedBy, FieldFrame, useFieldIds, type FieldChrome } from '../ui/FormField';
import type { DateFieldProps } from './DateField';

// A calendar date on web: the browser's <input type="date"> (shell.md 7.5, `.inp.inp-n`), which reads and writes
// YYYY-MM-DD, in the FormField anatomy: a `ground` fill, a 1px `line` border turning mint on focus, mono figures,
// the helper and field messages tied by aria-describedby, and aria-invalid with a message.

const c = theme.color;

export function DateField(props: DateFieldProps): React.JSX.Element {
  const fieldIds = useFieldIds();
  const [focused, setFocused] = useState(false);
  const chrome: FieldChrome = {
    label: props.label,
    ...(props.helper === undefined ? {} : { helper: props.helper }),
    ...(props.messages === undefined ? {} : { messages: props.messages }),
  };
  const invalid = (props.messages?.length ?? 0) > 0;
  return (
    <FieldFrame {...chrome} ids={fieldIds}>
      <input
        type="date"
        aria-labelledby={fieldIds.label}
        aria-describedby={describedBy(chrome, fieldIds)}
        aria-invalid={invalid ? true : undefined}
        value={props.value}
        min="2010-01-01"
        onChange={(event) => { props.onChange(event.target.value); }}
        onFocus={() => { setFocused(true); }}
        onBlur={() => { setFocused(false); }}
        style={{
          boxSizing: 'border-box', width: '100%', minHeight: 44, margin: 0, padding: '0 12px', background: c.ground, color: c.white,
          border: `1px solid ${focused ? c.mint : c.line}`, borderRadius: 0, fontFamily: theme.font.mono, fontSize: 16,
          lineHeight: '24px', fontVariantNumeric: 'tabular-nums', colorScheme: 'dark',
        }}
      />
    </FieldFrame>
  );
}
