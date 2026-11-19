import { useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { DataView } from './dataView';

// Your data's "View" (D61): Organized or Newest first as two buttons in a radio group with one tab stop, the arrow
// keys moving the choice (web), in the look of Sales data's MetricSwitch (written here so this folder doesn't import
// analytics/). Viewing is a read, so it works under view-as too.

export const VIEW_OPTIONS: readonly { value: DataView; label: string }[] = [
  { value: 'organized', label: 'Organized' },
  { value: 'newest', label: 'Newest first' },
];

export const VIEW_LABEL = 'View';

type Host = React.ComponentRef<typeof View>;

export function ViewSwitch(props: { value: DataView; onChange: (view: DataView) => void }): React.JSX.Element {
  const refs = useRef<(Host | null)[]>([]);

  function onKeyDown(event: { key: string; preventDefault: () => void }): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!forward && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = VIEW_OPTIONS.findIndex((option) => option.value === props.value);
    const index = (at + (forward ? 1 : VIEW_OPTIONS.length - 1)) % VIEW_OPTIONS.length;
    const next = VIEW_OPTIONS[index];
    if (next === undefined) return;
    props.onChange(next.value);
    (refs.current[index] as unknown as { focus?: () => void } | null)?.focus?.();
  }

  return (
    <View role="radiogroup" aria-label={VIEW_LABEL} {...(Platform.OS === 'web' ? ({ onKeyDown } as object) : {})} style={styles.group}>
      <Text style={styles.legend}>{VIEW_LABEL}</Text>
      <View style={styles.row}>
        {VIEW_OPTIONS.map((option, index) => {
          const on = option.value === props.value;
          return (
            <Pressable
              key={option.value}
              ref={(element) => { refs.current[index] = element; }}
              role="radio"
              accessibilityState={{ checked: on }}
              {...(Platform.OS === 'web' ? { tabIndex: on ? 0 : -1, 'aria-checked': on } : {})}
              onPress={() => { if (!on) props.onChange(option.value); }}
              style={[styles.button, on ? styles.on : null]}
            >
              <Text style={[styles.label, on ? styles.labelOn : null]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
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
  label: { ...theme.type.ui, color: c.white },
  labelOn: { color: c.onMint },
});
