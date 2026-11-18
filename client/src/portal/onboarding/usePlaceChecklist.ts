import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { hasCode } from '../errors';
import type { PlaceMap } from '../places/map';
import { usePlacesMapState } from '../places/usePlacesMap';
import { CHECKLIST_COPY, MAX_CHECKED_PLACES, outsideUsLine } from './checklist';
import { placeDetails, placesUnavailable, type PlaceSuggestion, type UsablePlace } from './places';
import { usePlaceSearch, type PlaceSearchState } from './usePlaceSearch';

// The places checklist's state, for PlaceChecklist (.web) to draw and for the request form (P3) and Add location (P10)
// to read. It runs the search (usePlaceSearch.ts) and keeps the places checked from any of its answers, so searching
// again keeps them. Checking a suggestion asks Google for its details: the first check after an answer takes that
// search's session token and ends the session (endSession), and a later check carries none, so the API makes one of
// its own and the next autocomplete starts a new session. Each check holds a ticket: unchecking it, or checking it
// again, retires the ticket, and a late answer whose ticket is gone is dropped. A place outside a US town, a 503 or a
// 404 leaves the place unchecked with a line saying why; at MAX_CHECKED_PLACES checked or loading, the rest wait.
// `map` is one map of every checked place (places/usePlacesMap.ts): a loading row is not on it. Its pins are lettered
// in check order, A for the first (D57, as Settings' map of every location is, D47), and `letterOf` gives a row's
// letter while that map shows: none for a loading row, with no map, while the map on screen is still the set before's,
// or once its image failed to load.

export type ChecklistRow =
  | { readonly key: string; readonly status: 'loading'; readonly suggestion: PlaceSuggestion }
  | { readonly key: string; readonly status: 'checked'; readonly suggestion: PlaceSuggestion; readonly place: UsablePlace };

export type CheckedRow = Extract<ChecklistRow, { status: 'checked' }>;

export interface PlaceChecklistState {
  search: PlaceSearchState;
  /** In check order; `key` is the suggestion's placeId. */
  rows: readonly ChecklistRow[];
  /** The checked rows' places, in order. */
  places: readonly UsablePlace[];
  /** The signed map with a lettered pin for each checked place; null with none, while the map is off, or after a failure. */
  map: PlaceMap;
  /** The letter on a row's pin, or null when no map shows one for it. `key` is the row's. */
  letterOf: (key: string) => string | null;
  /** The map's image failed to load, so its letters would point at nothing. */
  mapFailed: (url: string) => void;
  /** A row is loading. */
  loading: boolean;
  /** `rows.length >= MAX_CHECKED_PLACES`. */
  full: boolean;
  optionOf: (suggestion: PlaceSuggestion) => { checked: boolean; disabled: boolean };
  toggle: (suggestion: PlaceSuggestion) => void;
  remove: (key: string) => void;
  /** The newest refusal line; cleared by a toggle or new text. */
  notice: string | null;
  /** A check's failure other than 503 and 404. */
  error: unknown;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export function usePlaceChecklist(api: ApiClient, unavailableLine: string): PlaceChecklistState {
  const search = usePlaceSearch(api);
  const { endSession, setQuery: searchFor } = search;
  const [rows, setRows] = useState<readonly ChecklistRow[]>([]);
  /** Places found outside a US town: their boxes stay disabled. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(NO_KEYS);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const live = useRef(true);
  // The rows and refusals as of the last change, for a press or an answer to read before the next render.
  const rowsNow = useRef<readonly ChecklistRow[]>([]);
  const refusedNow = useRef<ReadonlySet<string>>(NO_KEYS);
  /** Each row's ticket, by key. */
  const tickets = useRef(new Map<string, number>());
  const lastTicket = useRef(0);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const commit = useCallback((next: readonly ChecklistRow[]): void => {
    rowsNow.current = next;
    setRows(next);
  }, []);

  const drop = useCallback((key: string): void => {
    tickets.current.delete(key);
    commit(rowsNow.current.filter((row) => row.key !== key));
  }, [commit]);

  const remove = useCallback((key: string): void => {
    drop(key);
    setNotice(null);
    setError(null);
  }, [drop]);

  const toggle = useCallback((suggestion: PlaceSuggestion): void => {
    const key = suggestion.placeId;
    if (rowsNow.current.some((row) => row.key === key)) {
      remove(key);
      return;
    }
    if (refusedNow.current.has(key) || rowsNow.current.length >= MAX_CHECKED_PLACES) return;
    const sessionToken = endSession();
    lastTicket.current += 1;
    const ticket = lastTicket.current;
    tickets.current.set(key, ticket);
    commit([...rowsNow.current, { key, status: 'loading', suggestion }]);
    setNotice(null);
    setError(null);
    const current = (): boolean => live.current && tickets.current.get(key) === ticket;
    placeDetails(api, key, sessionToken).then(
      (answer) => {
        if (!current()) return;
        const { town } = answer;
        if (town === null) {
          drop(key);
          refusedNow.current = new Set([...refusedNow.current, key]);
          setRefused(refusedNow.current);
          setNotice(outsideUsLine(suggestion.name));
          return;
        }
        // Google's current id for a place already checked under another suggestion: the list keeps the first.
        if (rowsNow.current.some((row) => row.status === 'checked' && row.place.placeId === answer.placeId)) {
          drop(key);
          return;
        }
        const place: UsablePlace = { ...answer, town, name: suggestion.name, kind: suggestion.kind };
        commit(rowsNow.current.map((row) => (row.key === key ? { key, status: 'checked', suggestion, place } : row)));
      },
      (caught: unknown) => {
        if (!current()) return;
        drop(key);
        if (placesUnavailable(caught)) setNotice(unavailableLine);
        else if (hasCode(caught, 404, 'place_not_found')) setNotice(CHECKLIST_COPY.gone);
        else setError(caught);
      },
    );
  }, [api, commit, drop, endSession, remove, unavailableLine]);

  const setQuery = useCallback((text: string): void => {
    setNotice(null);
    setError(null);
    searchFor(text);
  }, [searchFor]);

  const places = useMemo(() => rows.flatMap((row) => (row.status === 'checked' ? [row.place] : [])), [rows]);
  const { map, held } = usePlacesMapState(api, places.map((place) => place.placeId), { labeled: true });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Not beside the last set's map, held while this set's is asked for: its pins are the old set's.
  const lettersShow = map !== null && !held && map.url !== failedUrl;
  const letterOf = useCallback((key: string): string | null => {
    if (!lettersShow) return null;
    const index = rows.filter((row) => row.status === 'checked').findIndex((row) => row.key === key);
    return index < 0 || index > 25 ? null : String.fromCharCode(65 + index);
  }, [rows, lettersShow]);
  const full = rows.length >= MAX_CHECKED_PLACES;
  const optionOf = useCallback((suggestion: PlaceSuggestion): { checked: boolean; disabled: boolean } => {
    const checked = rows.some((row) => row.key === suggestion.placeId);
    return { checked, disabled: refused.has(suggestion.placeId) || (full && !checked) };
  }, [rows, refused, full]);

  return {
    search: { ...search, setQuery },
    rows,
    places,
    map,
    letterOf,
    mapFailed: setFailedUrl,
    loading: rows.some((row) => row.status === 'loading'),
    full,
    optionOf,
    toggle,
    remove,
    // A search 503 with places in the list keeps the list (PlaceChecklistParts hands over only an empty one).
    notice: notice ?? (search.unavailable && rows.length > 0 ? unavailableLine : null),
    error,
  };
}
