import { useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { webAria } from '../ui/aria';
import type { Metric } from './words';

// "Colour by" (home.md 4.2): Guests or Net sales as two pressed buttons in a radio group with one tab stop; the
// arrow keys move the choice (web). The look of the note form's ChoiceGroup, written here so this folder does not
// import upload/, which another session owns. A metric with no data is disabled, and its helper says why.

const OPTIONS: readonly { value: Metric; label: string; missing: string }[] = [
  { value: 'guests', label: 'Guests', missing: 'No guest counts in your history.' },
  { value: 'netSales', label: 'Net sales', missing: 'No net sales in your history.' },
];

type Host = React.ComponentRef<typeof View>;

export function MetricSwitch(props: {
  value: Metric;
  available: Readonly<Record<Metric, boolean>>;
  onChange: (metric: Metric) => void;
  disabled?: boolean;
  nativeID: string;
}): React.JSX.Element {
  const refs = useRef<(Host | null)[]>([]);
  const enabled = OPTIONS.filter((option) => props.disabled !== true && props.available[option.value]);
  const helper = OPTIONS.find((option) => !props.available[option.value])?.missing ?? null;
  const helperId = helper === null ? undefined : `${props.nativeID}-help`;

  function onKeyDown(event: { key: string; preventDefault: () => void }): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!forward && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = enabled.findIndex((option) => option.value === props.value);
    const next = enabled[(at + (forward ? 1 : enabled.length - 1)) % Math.max(1, enabled.length)];
    if (next === undefined || next.value === props.value) return;
    props.onChange(next.value);
    (refs.current[OPTIONS.indexOf(next)] as unknown as { focus?: () => void } | null)?.focus?.();
  }

  return (
    <View
      role="radiogroup"
      aria-label="Colour by"
      {...(Platform.OS === 'web' ? ({ onKeyDown } as object) : {})}
      style={styles.group}
    >
      <Text style={styles.legend}>Colour by</Text>
      <View style={styles.row}>
        {OPTIONS.map((option, index) => {
          const on = option.value === props.value;
          const off = props.disabled === true || !props.available[option.value];
          return (
            <Pressable
              key={option.value}
              ref={(element) => { refs.current[index] = element; }}
              role="radio"
              accessibilityState={{ checked: on, disabled: off }}
              {...webAria({ 'aria-describedby': off ? helperId : undefined })}
              {...(Platform.OS === 'web' ? { tabIndex: on && !off ? 0 : -1, 'aria-checked': on, 'aria-disabled': off || undefined } : { disabled: off })}
              onPress={() => { if (!off && !on) props.onChange(option.value); }}
              style={[styles.button, on ? styles.on : null, off && !on ? styles.offBox : null]}
            >
              <Text style={[styles.label, on ? styles.labelOn : null, off && !on ? styles.labelOff : null]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {helper === null ? null : <Text nativeID={helperId} style={styles.help}>{helper}</Text>}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  group: { gap: theme.space[2], minWidth: 0 },
  legend: { ...theme.type.ui, color: c.white },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  button: {
    minHeight: 44, minWidth: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    borderColor: c.line, backgroundColor: 'transparent',
  },
  on: { backgroundColor: c.mint, borderColor: c.mint },
  offBox: { borderColor: c.border },
  label: { ...theme.type.ui, color: c.white },
  labelOn: { color: c.onMint },
  labelOff: { color: c.text3 },
  help: { ...theme.type.small, color: c.text2 },
});
