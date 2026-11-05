import type { CSSProperties } from 'react';

import { theme } from '../../theme';
import type { DisabledButtonProps } from './DisabledButton';

// A disabled control on web, as the shell's markup has it (shell.md 7.4): <button aria-disabled="true">, never
// the disabled attribute, so it stays in the tab order and screen readers reach it and the line that explains it.
// react-native-web cannot render that: its role="button" is a <button>, and its disabled prop adds the attribute.
// Pressing it does nothing.

const c = theme.color;

const BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, margin: 0, borderRadius: 0,
  background: 'transparent', color: c.text3, cursor: 'default', boxSizing: 'border-box', fontFamily: theme.font.sans,
};

const VARIANT: Record<DisabledButtonProps['variant'], CSSProperties> = {
  primary: { ...BASE, padding: '0 17px', background: c.raised, border: `1px solid ${c.border}`, fontSize: 15, lineHeight: '20px', fontWeight: 600 },
  outline: { ...BASE, padding: '0 14px', border: `1px solid ${c.border}`, fontSize: 14, lineHeight: '20px', fontWeight: 500 },
  link: {
    ...BASE, padding: 0, minWidth: 44, border: 0, justifyContent: 'flex-start', fontSize: 14, lineHeight: '20px', fontWeight: 500,
    textDecoration: 'underline', textDecorationColor: c.border, textUnderlineOffset: 3,
  },
};

export function DisabledButton(props: DisabledButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-disabled="true"
      aria-label={props.accessibilityLabel}
      aria-describedby={props.describedBy}
      style={{ ...VARIANT[props.variant], alignSelf: props.block ? 'stretch' : 'flex-start', width: props.block ? '100%' : undefined }}
    >
      {props.label}
    </button>
  );
}
