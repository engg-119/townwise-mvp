import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { describedBy, FieldFrame, useFieldIds, type FieldChrome } from './FormField';
import { isGroup, type SelectProps } from './selectTypes';

// The select on web: a real <select> with <optgroup>s (shell.md 7.5), styled like a FormField input with the
// shell's drawn chevron. Under view-as it carries aria-disabled, stays focusable, and ignores changes.

const c = theme.color;

export function Select(props: SelectProps): React.JSX.Element {
  const fieldIds = useFieldIds();
  const [focused, setFocused] = useState(false);
  const readOnly = props.readOnly === true;
  const chrome: FieldChrome = props;
  const invalid = (props.messages?.length ?? 0) > 0;
  const border = readOnly ? c.border : focused ? c.mint : c.line;
  return (
    <FieldFrame {...chrome} ids={fieldIds}>
      <View style={[styles.box, props.compact === true ? styles.compact : null]}>
        <select
          aria-labelledby={fieldIds.label}
          aria-describedby={describedBy(chrome, fieldIds)}
          aria-invalid={invalid ? true : undefined}
          aria-disabled={readOnly ? true : undefined}
          value={props.value}
          onChange={(event) => { if (!readOnly) props.onChange(event.target.value); }}
          onFocus={() => { setFocused(true); }}
          onBlur={() => { setFocused(false); }}
          style={{
            appearance: 'none', WebkitAppearance: 'none', width: '100%', minHeight: 44, margin: 0, padding: '0 40px 0 12px',
            background: c.ground, color: readOnly ? c.text3 : c.white, border: `1px solid ${border}`, borderRadius: 0,
            fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px', cursor: readOnly ? 'default' : 'pointer',
          }}
        >
          {props.placeholder === undefined ? null : <option value="">{props.placeholder}</option>}
          {props.items.map((item) => (isGroup(item) ? (
            <optgroup key={item.label} label={item.label}>
              {item.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </optgroup>
          ) : <option key={item.value} value={item.value}>{item.label}</option>))}
        </select>
        <View style={styles.chevron} />
      </View>
    </FieldFrame>
  );
}

const styles = StyleSheet.create({
  box: { position: 'relative', justifyContent: 'center' },
  compact: { maxWidth: 280 },
  chevron: {
    position: 'absolute', right: 16, pointerEvents: 'none', width: 7, height: 7, borderRightWidth: 1.5, borderBottomWidth: 1.5,
    borderColor: c.text2, transform: [{ translateY: -2 }, { rotate: '45deg' }],
  },
});
