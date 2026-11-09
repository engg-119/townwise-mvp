import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { PLACES_SOURCE, PlaceRow } from '../places/PlaceCard';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { CHECKLIST_COPY, checklistStatus } from './checklist';
import { StatusLine } from './PlaceSearchParts';
import type { CheckedRow, PlaceChecklistState } from './usePlaceChecklist';

// What PlaceChecklist shows on both platforms around its field (PlaceChecklist.tsx on native, PlaceChecklist.web.tsx
// on web): the status line under the field, Google's credit, the lines that say why a place wasn't checked, the limit
// line, then the checked places in check order, each with Remove, and where they came from. The field and its
// suggestions are each platform's own. The way out to the manual fields is the page's.

export interface PlaceChecklistProps {
  /** usePlaceChecklist's state, which the page reads too. */
  state: PlaceChecklistState;
  /** The field's label, such as “Search for your restaurant or bar”. */
  label: string;
  helper?: string;
  /** Focus the field when it appears. */
  autoFocus?: boolean;
  /** While the page saves: the boxes, Remove and the field do nothing. */
  disabled?: boolean;
  /** A search 503 while nothing is checked or loading: the page shows its manual fields with its own line. */
  onUnavailable: () => void;
  /** What the page adds to a checked row, such as its Name field (P10). */
  rowExtra?: (row: CheckedRow) => React.ReactNode;
}

/** The field's part: the input and its suggestions, given the state and the status line's id. */
export interface ChecklistFieldProps {
  props: PlaceChecklistProps;
  state: PlaceChecklistState;
  statusId: string;
}

export function PlaceChecklistShell(p: { props: PlaceChecklistProps; field: React.ReactNode; statusId: string }): React.JSX.Element {
  const { props } = p;
  const { state, onUnavailable } = props;
  const { search } = state;
  const empty = state.rows.length === 0;
  const off = props.disabled === true;
  // A search 503 hands over once, and only while nothing is checked or loading, so nothing checked is lost.
  const handedOver = useRef(false);
  useEffect(() => {
    if (!search.unavailable || !empty || handedOver.current) return;
    handedOver.current = true;
    onUnavailable();
  }, [search.unavailable, empty, onUnavailable]);

  return (
    <Stack gap={12}>
      {p.field}
      <StatusLine id={p.statusId} text={checklistStatus(search)} />
      {search.suggestions.length > 0 ? <Small>Results from Google Maps.</Small> : null}
      {search.error === null ? null : <ErrorNotice error={search.error} onRetry={() => { search.setQuery(search.query); }} />}
      {state.notice === null ? null : <ErrorNotice message={state.notice} />}
      {state.error === null ? null : <ErrorNotice error={state.error} />}
      {state.full ? <Small>{CHECKLIST_COPY.limit}</Small> : null}
      {empty ? null : (
        <Stack gap={8}>
          {state.rows.map((row) => (
            <PlaceRow key={row.key} label={row.suggestion.name} place={row.status === 'checked' ? row.place : null}>
              {row.status === 'checked' ? props.rowExtra?.(row) : null}
              <View style={styles.remove}>
                <Button
                  variant="link"
                  label="Remove"
                  accessibilityLabel={`Remove ${row.suggestion.name}`}
                  disabled={off}
                  onPress={() => { state.remove(row.key); }}
                />
              </View>
            </PlaceRow>
          ))}
        </Stack>
      )}
      {empty ? null : <Small>{PLACES_SOURCE}</Small>}
    </Stack>
  );
}

const styles = StyleSheet.create({
  remove: { alignItems: 'flex-start' },
});
