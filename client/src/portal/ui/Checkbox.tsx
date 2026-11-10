import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

// A checkbox (home.md 4.2, spec 15.7): a 44px row with a 16px square box and its label. Checked takes the mint
// fill with an `onMint` check, which spec 15.6 allows for a pressed control. Disabled keeps its place, reads
// `text3`, and pressing it does nothing. Native is a Pressable with the checkbox role and its checked and disabled
// state; Checkbox.web.tsx is a real <input type="checkbox"> inside a <label>. CheckMark is the drawn box alone, for a
// control that is a checkbox of its own (the places checklist's suggestions); it is native only.

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Ids of the lines that explain the box, such as "Keep at least one year." (web). */
  describedBy?: string;
}

export function Checkbox(props: CheckboxProps): React.JSX.Element {
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.checked, disabled }}
      disabled={disabled}
      onPress={() => { props.onChange(!props.checked); }}
      style={styles.row}
    >
      <CheckMark checked={props.checked} disabled={disabled} />
      <Text style={[styles.label, disabled ? styles.labelOff : null]}>{props.label}</Text>
    </Pressable>
  );
}

/** The 16px box, with the mint fill and check while checked. */
export function CheckMark(props: { checked: boolean; disabled: boolean }): React.JSX.Element {
  return (
    <View style={[styles.box, props.checked ? styles.on : null, props.disabled ? styles.off : null]}>
      {props.checked ? <View style={styles.check} /> : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 10, minHeight: 44, alignSelf: 'flex-start' },
  box: { width: 16, height: 16, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: c.mint, borderColor: c.mint },
  off: { borderColor: c.border },
  // A drawn check: two sides of a rotated rectangle, as the select's chevron is drawn.
  check: {
    width: 5, height: 9, marginTop: -2, borderRightWidth: 2, borderBottomWidth: 2, borderColor: c.onMint,
    transform: [{ rotate: '45deg' }],
  },
  label: { ...theme.type.ui, color: c.white },
  labelOff: { color: c.text3 },
});
