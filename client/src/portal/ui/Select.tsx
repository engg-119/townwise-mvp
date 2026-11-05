import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { FieldFrame, fieldStyles, useFieldIds, type FieldChrome } from './FormField';
import { isGroup, labelOf, type SelectOption, type SelectProps } from './selectTypes';
import { Button } from './Button';

// The select on iOS and Android: a FormField-styled control that opens the options in a sheet, grouped as the
// web <select>'s optgroups are (Select.web.tsx). Nothing animates. Under view-as it shows its value and does
// not open.

export function Select(props: SelectProps): React.JSX.Element {
  const fieldIds = useFieldIds();
  const [open, setOpen] = useState(false);
  const readOnly = props.readOnly === true;
  const current = labelOf(props.items, props.value) ?? props.placeholder ?? '';
  const chrome: FieldChrome = props;

  function choose(value: string): void {
    setOpen(false);
    if (value !== props.value) props.onChange(value);
  }

  function renderChoice(option: SelectOption): React.JSX.Element {
    const selected = option.value === props.value;
    return (
      <Pressable
        key={option.value}
        role="radio"
        accessibilityState={{ checked: selected }}
        onPress={() => { choose(option.value); }}
        style={(state) => [styles.option, state.pressed || selected ? styles.optionOn : null]}
      >
        <Text style={[styles.optionText, selected ? styles.optionSelected : null]}>{option.label}</Text>
      </Pressable>
    );
  }

  return (
    <FieldFrame {...chrome} ids={fieldIds}>
      <Pressable
        role="button"
        accessibilityLabel={props.label}
        accessibilityValue={{ text: current }}
        aria-disabled={readOnly}
        {...(props.helper === undefined ? {} : { accessibilityHint: props.helper })}
        {...(readOnly ? {} : { onPress: () => { setOpen(true); } })}
        style={[fieldStyles.input, styles.control, props.compact === true ? styles.compact : null, readOnly ? fieldStyles.readOnly : null]}
      >
        <Text numberOfLines={1} style={[styles.value, readOnly ? styles.valueReadOnly : null]}>{current}</Text>
        <View style={styles.chevron} />
      </Pressable>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => { setOpen(false); }}>
        <View style={styles.backdrop}>
          <View role="dialog" aria-label={props.label} style={styles.sheet}>
            <Text role="heading" style={styles.sheetTitle}>{props.label}</Text>
            <ScrollView style={styles.list} role="radiogroup">
              {props.placeholder === undefined ? null : renderChoice({ value: '', label: props.placeholder })}
              {props.items.map((item) => (isGroup(item) ? (
                <View key={item.label}>
                  <Text style={styles.group}>{item.label}</Text>
                  {item.options.map(renderChoice)}
                </View>
              ) : renderChoice(item)))}
            </ScrollView>
            <Button variant="link" label="Cancel" onPress={() => { setOpen(false); }} />
          </View>
        </View>
      </Modal>
    </FieldFrame>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  control: { flexDirection: 'row', alignItems: 'center', paddingRight: 16 },
  compact: { maxWidth: 280 },
  value: { ...theme.type.sub, color: c.white, flex: 1 },
  valueReadOnly: { color: c.text3 },
  chevron: {
    width: 7, height: 7, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: c.text2, transform: [{ rotate: '45deg' }],
    marginLeft: 12, marginTop: -4,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(8, 10, 13, 0.8)', justifyContent: 'center', padding: theme.space[4] },
  sheet: {
    maxHeight: '80%', backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, padding: theme.space[4], gap: theme.space[3],
  },
  sheetTitle: { ...theme.type.h3Phone, color: c.white },
  list: { flexGrow: 0 },
  group: { ...theme.type.label, color: c.text3, paddingTop: theme.space[4], paddingBottom: theme.space[2] },
  option: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.space[3], borderWidth: 1, borderColor: 'transparent' },
  optionOn: { backgroundColor: c.raised, borderColor: c.border },
  optionText: { ...theme.type.sub, color: c.text2 },
  optionSelected: { color: c.mint },
});
