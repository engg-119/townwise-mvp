import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { hasCode } from '../errors';
import {
  autocompletePlaces, checkPlaceSearch, MIN_SEARCH_LENGTH, placeDetails, placesUnavailable, type FoundPlace, type PlaceSuggestion,
} from './places';

// The Google Places search's state, for PlaceSearch (.web) to draw. One search is one session token: the API issues it
// on the first autocomplete and the details call for the pick ends it, so "Search again" starts a new one. Typing is
// debounced, nothing under 2 characters is sent, and one autocomplete runs at a time: text typed while one runs is sent
// when it settles, and only the newest text's answer is shown (api/README.md, Rate limits: about 10 to 15 calls a
// search).

export const SEARCH_DEBOUNCE_MS = 250;

/** `checking` until the API answers; `off` while the search is off, under view-as, or when the check fails. */
export type PlaceSearchAvailability = 'checking' | 'on' | 'off';

/**
 * Whether to offer the search. `known` is GET /api/org's `placeSearch` where the page has it (P10, P16); without it
 * (P3, where there is no organization yet) the API is asked once (checkPlaceSearch). Under view-as the forms stay
 * read-only as they are without the search, so it is off and nothing is sent.
 */
export function usePlaceSearchAvailability(api: ApiClient, opts: { known?: boolean | undefined; readOnly: boolean }): PlaceSearchAvailability {
  const { known, readOnly } = opts;
  const ask = known === undefined && !readOnly;
  const [checked, setChecked] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ask) return undefined;
    let live = true;
    void checkPlaceSearch(api).then((on) => { if (live) setChecked(on); });
    return () => { live = false; };
  }, [api, ask]);
  if (readOnly) return 'off';
  if (known !== undefined) return known ? 'on' : 'off';
  return checked === null ? 'checking' : checked ? 'on' : 'off';
}

export interface PlaceSearchState {
  query: string;
  setQuery: (text: string) => void;
  /** The newest answer's suggestions, for `searched`. */
  suggestions: readonly PlaceSuggestion[];
  /** The text those suggestions answer; null before the first answer and while the text is too short. */
  searched: string | null;
  /** An autocomplete is running. */
  searching: boolean;
  /** The suggestion whose details are loading. */
  picking: PlaceSuggestion | null;
  found: FoundPlace | null;
  /** The last failure other than places_unavailable, until the next try. */
  error: unknown;
  /** Google's details no longer know the picked place. */
  gone: boolean;
  /** 503 places_unavailable: the search went off, or Google isn't answering. */
  unavailable: boolean;
  pick: (suggestion: PlaceSuggestion) => void;
  /** Back to the search with the same text, in a new session. */
  again: () => void;
}

function trimmed(text: string): string {
  return text.trim();
}

export function usePlaceSearch(api: ApiClient): PlaceSearchState {
  const [query, setQueryState] = useState('');
  const [suggestions, setSuggestions] = useState<readonly PlaceSuggestion[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<PlaceSuggestion | null>(null);
  const [found, setFound] = useState<FoundPlace | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [gone, setGone] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const live = useRef(true);
  const token = useRef<string | null>(null);
  /** The session's number: a pick or Search again starts the next, and an older session's late answer is dropped. */
  const session = useRef(0);
  /** The text the next answer must match to be shown. */
  const wanted = useRef('');
  const inflight = useRef(false);
  /** Text typed while an autocomplete ran, sent when it settles. */
  const queued = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** `send`, for the queued text to go once the running call settles. */
  const sendNext = useRef<(input: string) => void>(() => undefined);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const send = useCallback((input: string): void => {
    if (inflight.current) {
      queued.current = input;
      return;
    }
    inflight.current = true;
    setSearching(true);
    const sentIn = session.current;
    autocompletePlaces(api, input, token.current).then(
      (answer) => {
        // The session ended while it ran (a pick): its token must not come back.
        if (!live.current || sentIn !== session.current) return;
        token.current = answer.sessionToken;
        if (input === wanted.current) {
          setSuggestions(answer.suggestions);
          setSearched(input);
        }
      },
      (caught: unknown) => {
        if (!live.current) return;
        if (placesUnavailable(caught)) setUnavailable(true);
        else if (input === wanted.current && sentIn === session.current) setError(caught);
      },
    ).finally(() => {
      inflight.current = false;
      if (!live.current) return;
      setSearching(false);
      const next = queued.current;
      queued.current = null;
      if (next !== null && next === wanted.current) sendNext.current(next);
    });
  }, [api]);
  useEffect(() => { sendNext.current = send; }, [send]);

  const schedule = useCallback((text: string): void => {
    const input = trimmed(text);
    wanted.current = input;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setError(null);
    if (input.length < MIN_SEARCH_LENGTH) {
      queued.current = null;
      setSuggestions([]);
      setSearched(null);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      send(input);
    }, SEARCH_DEBOUNCE_MS);
  }, [send]);

  const setQuery = useCallback((text: string): void => {
    setQueryState(text);
    setGone(false);
    schedule(text);
  }, [schedule]);

  const pick = useCallback((suggestion: PlaceSuggestion): void => {
    const sessionToken = token.current;
    // A suggestion only shows after an answer, which carried the token.
    if (sessionToken === null) return;
    // The details call ends the session, whatever it answers.
    token.current = null;
    session.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    queued.current = null;
    setPicking(suggestion);
    setError(null);
    setGone(false);
    placeDetails(api, suggestion.placeId, sessionToken).then(
      (place) => {
        if (!live.current) return;
        setPicking(null);
        setFound({ ...place, name: suggestion.name });
      },
      (caught: unknown) => {
        if (!live.current) return;
        setPicking(null);
        if (placesUnavailable(caught)) setUnavailable(true);
        else if (hasCode(caught, 404, 'place_not_found')) { setGone(true); setSuggestions([]); setSearched(null); }
        else setError(caught);
      },
    );
  }, [api]);

  const again = useCallback((): void => {
    token.current = null;
    session.current += 1;
    setFound(null);
    setSuggestions([]);
    setSearched(null);
    schedule(query);
  }, [query, schedule]);

  return { query, setQuery, suggestions, searched, searching, picking, found, error, gone, unavailable, pick, again };
}

/**
 * What a screen reader hears once per answer, and what the search shows under the field. The sentence names the text it
 * answers, so two answers with the same count still read differently (a live region speaks only a change).
 */
export function searchStatus(state: Pick<PlaceSearchState, 'searched' | 'suggestions' | 'gone'>): string | null {
  if (state.gone) return 'Google Maps can’t find that place any more. Search again, or enter it yourself.';
  if (state.searched === null) return null;
  const count = state.suggestions.length;
  if (count === 0) return `No places match “${state.searched}”. Check the spelling, or enter it yourself.`;
  return `${String(count)} ${count === 1 ? 'place matches' : 'places match'} “${state.searched}”. Pick one to see what Google Maps has for it.`;
}
