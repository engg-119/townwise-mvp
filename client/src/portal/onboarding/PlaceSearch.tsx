import { useId, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from '../../theme';
import { useFocusOnMount } from '../places/focus';
import { FieldFrame, fieldStyles, useFieldIds } from '../ui/FormField';
import { MAX_SEARCH_LENGTH } from './places';
import { fieldFocus, PlaceSearchShell, type PlaceFieldProps, type PlaceSearchProps } from './PlaceSearchParts';
import { usePlaceSearch } from './usePlaceSearch';

// The Google Places search on iOS and Android (PlaceSearch.web.tsx is the web's combobox): a search field, and under
// it each suggestion as a button named by the place and its town, then the confirm card (PlaceSearchParts.tsx). The
// status line under the field says how many places match the text searched, once per answer. The screen reader moves
// to the field when it comes back after a pick (Search again) or when the page opened the search from a button.
// Nothing animates.

export type { PlaceSearchProps } from './PlaceSearchParts';

export function PlaceSearch(props: PlaceSearchProps): React.JSX.Element {
  const state = usePlaceSearch(props.api);
  const statusId = `${useId().replace(/:/g, '')}-status`;
  return <PlaceSearchShell props={props} state={state} statusId={statusId} field={<NativeField props={props} state={state} statusId={statusId} />} />;
}

function NativeField({ props, state }: PlaceFieldProps): React.JSX.Element {
  const ids = useFieldIds();
  const [focused, setFocused] = useState(false);
  const input = useFocusOnMount<React.ComponentRef<typeof TextInput>>(fieldFocus(props, state));
  return (
    <FieldFrame label={props.label} {...(props.helper === undefined ? {} : { helper: props.helper })} ids={ids}>
      <TextInput
        ref={input}
        accessibilityLabel={props.label}
        {...(props.helper === undefined ? {} : { accessibilityHint: props.helper })}
        value={state.query}
        onChangeText={state.setQuery}
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
      {state.suggestions.length === 0 ? null : (
        <View style={styles.list}>
          {state.suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.placeId}
              role="button"
              accessibilityLabel={suggestion.detail === '' ? suggestion.name : `${suggestion.name}, ${suggestion.detail}`}
              onPress={() => { state.pick(suggestion); }}
              style={(pressed) => [styles.option, pressed.pressed ? styles.optionOn : null]}
            >
              <Text style={styles.name}>{suggestion.name}</Text>
              {suggestion.detail === '' ? null : <Text style={styles.detail}>{suggestion.detail}</Text>}
            </Pressable>
          ))}
        </View>
      )}
    </FieldFrame>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  option: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.space[3], paddingVertical: theme.space[2],
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  optionOn: { backgroundColor: c.raised },
  name: { ...theme.type.sub, color: c.white },
  detail: { ...theme.type.small, color: c.text2 },
});
