import { useId, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from '../../theme';
import { useFocusOnMount } from '../places/focus';
import { CheckMark } from '../ui/Checkbox';
import { FieldFrame, fieldStyles, useFieldIds } from '../ui/FormField';
import { MAX_SEARCH_LENGTH } from './places';
import { PlaceChecklistShell, type ChecklistFieldProps, type PlaceChecklistProps } from './PlaceChecklistParts';

// The places checklist on iOS and Android (PlaceChecklist.web.tsx is the web's): PlaceSearch's field, with each
// suggestion a checkbox named by the place and its town, its drawn box before the name; then the checked places
// (PlaceChecklistParts.tsx). Checking keeps the field and its focus, so the person can check several from one answer
// and search again. Nothing animates.

export type { PlaceChecklistProps } from './PlaceChecklistParts';

export function PlaceChecklist(props: PlaceChecklistProps): React.JSX.Element {
  const statusId = `${useId().replace(/:/g, '')}-status`;
  return <PlaceChecklistShell props={props} statusId={statusId} field={<NativeField props={props} state={props.state} statusId={statusId} />} />;
}

function NativeField({ props, state }: ChecklistFieldProps): React.JSX.Element {
  const ids = useFieldIds();
  const [focused, setFocused] = useState(false);
  const input = useFocusOnMount<React.ComponentRef<typeof TextInput>>(props.autoFocus === true);
  const off = props.disabled === true;
  const { search } = state;
  return (
    <FieldFrame label={props.label} {...(props.helper === undefined ? {} : { helper: props.helper })} ids={ids}>
      <TextInput
        ref={input}
        accessibilityLabel={props.label}
        {...(props.helper === undefined ? {} : { accessibilityHint: props.helper })}
        value={search.query}
        onChangeText={search.setQuery}
        editable={!off}
        autoCapitalize="words"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="search"
        maxLength={MAX_SEARCH_LENGTH}
        placeholderTextColor={theme.color.text3}
        onFocus={() => { setFocused(true); }}
        onBlur={() => { setFocused(false); }}
        style={[fieldStyles.input, focused ? fieldStyles.focused : null]}
      />
      {search.suggestions.length === 0 ? null : (
        <View style={styles.list}>
          {search.suggestions.map((suggestion) => {
            const option = state.optionOf(suggestion);
            const disabled = off || option.disabled;
            return (
              <Pressable
                key={suggestion.placeId}
                accessibilityRole="checkbox"
                accessibilityLabel={suggestion.detail === '' ? suggestion.name : `${suggestion.name}, ${suggestion.detail}`}
                accessibilityState={{ checked: option.checked, disabled }}
                disabled={disabled}
                onPress={() => { state.toggle(suggestion); }}
                style={(pressed) => [styles.option, pressed.pressed ? styles.optionOn : null]}
              >
                <CheckMark checked={option.checked} disabled={disabled} />
                <View style={styles.text}>
                  <Text style={[styles.name, disabled ? styles.nameOff : null]}>{suggestion.name}</Text>
                  {suggestion.detail === '' ? null : <Text style={styles.detail}>{suggestion.detail}</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </FieldFrame>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  option: {
    flexDirection: 'row', alignItems: 'center', columnGap: 10, minHeight: 44, paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[2], borderBottomWidth: 1, borderBottomColor: c.border,
  },
  optionOn: { backgroundColor: c.raised },
  text: { flexShrink: 1 },
  name: { ...theme.type.sub, color: c.white },
  nameOff: { color: c.text3 },
  detail: { ...theme.type.small, color: c.text2 },
});
