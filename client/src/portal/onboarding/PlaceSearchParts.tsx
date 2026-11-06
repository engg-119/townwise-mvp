import { useEffect } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import type { ApiClient } from '../../api/client';
import { theme } from '../../theme';
import { PlaceCard } from '../places/PlaceCard';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { usable, type FoundPlace, type UsablePlace } from './places';
import { searchStatus, type PlaceSearchState } from './usePlaceSearch';

// What PlaceSearch shows on both platforms around its field (PlaceSearch.tsx on native, PlaceSearch.web.tsx on web):
// the status line under the field, the error, Google's credit and the way out to the manual fields; then, once a place
// is picked, a loading line and the confirm card. The field and its suggestions are each platform's own.

export interface PlaceSearchProps {
  api: ApiClient;
  /** The field's label, such as “Search for your restaurant or bar”. */
  label: string;
  helper?: string;
  /** The confirm card's primary: “Looks right”, “Use this place”. */
  confirmLabel: string;
  /** While the page saves the confirmed place (P16): the primary's label and state. */
  pendingLabel?: string;
  pending?: boolean;
  /** A line on the card about what confirming does, such as a town change. */
  note?: (place: FoundPlace) => string | null;
  onConfirm: (place: UsablePlace) => void;
  /** The text link to the manual fields, or back: “Can’t find it? Enter it yourself”, “Cancel”. */
  manualLabel: string;
  onManual: () => void;
  /** 503 places_unavailable: the page shows its manual fields with its own line. */
  onUnavailable: () => void;
}

/** The field's part: the input and its suggestions, given the state and the status line's id. */
export interface PlaceFieldProps {
  props: PlaceSearchProps;
  state: PlaceSearchState;
  statusId: string;
}

export function PlaceSearchShell(p: { props: PlaceSearchProps; state: PlaceSearchState; field: React.ReactNode; statusId: string }): React.JSX.Element {
  const { props, state } = p;
  const { onUnavailable } = props;
  useEffect(() => {
    if (state.unavailable) onUnavailable();
  }, [state.unavailable, onUnavailable]);

  if (state.found !== null) {
    const place = state.found;
    return (
      <PlaceCard place={place} note={props.note?.(place) ?? null}>
        <Actions>
          {usable(place) ? (
            <Button
              label={props.pending === true ? (props.pendingLabel ?? props.confirmLabel) : props.confirmLabel}
              disabled={props.pending === true}
              onPress={() => { props.onConfirm(place); }}
            />
          ) : null}
          <Button variant="outline" label="Search again" disabled={props.pending === true} onPress={state.again} />
          <Button variant="link" label={props.manualLabel} disabled={props.pending === true} onPress={props.onManual} />
        </Actions>
      </PlaceCard>
    );
  }
  if (state.picking !== null) return <LoadingLine text={`Getting ${state.picking.name} from Google Maps…`} />;
  return (
    <Stack gap={12}>
      {p.field}
      <StatusLine id={p.statusId} text={searchStatus(state)} />
      {state.suggestions.length > 0 ? <Small>Results from Google Maps.</Small> : null}
      {state.error === null ? null : <ErrorNotice error={state.error} onRetry={() => { state.setQuery(state.query); }} />}
      <View style={styles.manual}>
        <Button variant="link" label={props.manualLabel} onPress={props.onManual} />
      </View>
    </Stack>
  );
}

/**
 * The status under the field, in a polite live region that each answer replaces whole, so a screen reader hears it
 * once. iOS reads no live region, so it is told.
 */
function StatusLine(props: { id: string; text: string | null }): React.JSX.Element {
  const { text } = props;
  useEffect(() => {
    if (text !== null && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
  return (
    <Text nativeID={props.id} role="status" aria-live="polite" accessibilityLiveRegion="polite" style={styles.status}>
      {text ?? ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  status: { ...theme.type.small, color: theme.color.text2 },
  manual: { alignItems: 'flex-start' },
});
