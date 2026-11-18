import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { PLACES_SOURCE, PlaceRow } from '../places/PlaceCard';
import { PlaceMap } from '../places/PlaceMap';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { CHECKLIST_COPY, checklistStatus } from './checklist';
import { suggestionLabel } from './places';
import { StatusLine } from './PlaceSearchParts';
import type { CheckedRow, PlaceChecklistState } from './usePlaceChecklist';

// What PlaceChecklist shows on both platforms around its field (PlaceChecklist.tsx on native, PlaceChecklist.web.tsx
// on web): the status line under the field, Google's credit, the lines that say why a place wasn't checked, the limit
// line, one map with a lettered pin for each checked place, then the checked places in check order, each with its
// pin's letter (D57) and Remove, and where they came from. The map sits under the field, so appearing never moves the field or its open list; it takes no
// focus, and with no map it is nothing at all. The field and its suggestions are each platform's own. The way out to the manual fields is the page's.

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

export function PlaceChecklistShell(p: { props: PlaceChecklistProps; field: React.ReactNode; statusId: string; onRemove?: () => void }): React.JSX.Element {
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
      <PlaceMap map={state.map} label={mapLabel(state)} frame={styles.map} onFailed={state.mapFailed} />
      {empty ? null : (
        <Stack gap={8}>
          {state.rows.map((row) => {
            // Named as its suggestion's box is, by place and town: several locations of one business often share a name.
            const { name } = row.suggestion;
            const named = suggestionLabel(row.suggestion);
            return (
              <PlaceRow
                key={row.key}
                label={named}
                loadingText={`Getting ${name} from Google Maps…`}
                place={row.status === 'checked' ? row.place : null}
                pin={state.letterOf(row.key)}
              >
                {row.status === 'checked' ? props.rowExtra?.(row) : null}
                <View style={styles.remove}>
                  <Button
                    variant="link"
                    label="Remove"
                    accessibilityLabel={`Remove ${named}`}
                    disabled={off}
                    onPress={() => { state.remove(row.key); p.onRemove?.(); }}
                  />
                </View>
              </PlaceRow>
            );
          })}
        </Stack>
      )}
      {empty ? null : <Small>{PLACES_SOURCE}</Small>}
    </Stack>
  );
}

/** “Map of {name}” for one place, “Map of your {n} places” for several. */
function mapLabel(state: PlaceChecklistState): string {
  const [first] = state.places;
  if (state.places.length === 1 && first !== undefined) return `Map of ${first.name}`;
  return `Map of your ${String(state.places.length)} places`;
}

const styles = StyleSheet.create({
  remove: { alignItems: 'flex-start' },
  map: { width: '100%', maxWidth: 640 },
});
