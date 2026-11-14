import { useEffect, useState } from 'react';
import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import type { ThemeMode } from '../shell/themeMode';
import { placeMapSchema, useMapTheme, type PlaceMap } from './map';

// The one map of every checked place (the places checklist, PlaceChecklistParts.tsx): POST /api/places/map for the set
// in the current mode (map.ts, useMapTheme), 400 ms after either last changed, so a quick run of checks loads one
// image. The ids are sorted, so the same set is the same URL and the browser's image cache helps, and each answer is
// kept by set and mode for the life of the hook, so a set seen before in this mode is not asked again: switching light
// or dark asks for the other mode's map once, and switching back shows the kept one at once. While the next map is
// asked for, the last one stays. An answer for a set or mode that is no longer current is dropped. With no ids there
// is no map, at once. Any failure (429, 503, the network, a URL the schema refuses) leaves no map and no error: the
// checked rows carry the information, and the map is decoration.

export const MAP_DEBOUNCE_MS = 400;

const NO_ANSWERS: ReadonlyMap<string, PlaceMap> = new Map();

const mapAnswerSchema = z.object({ map: placeMapSchema });

/** The signed map of every place in the mode, or null while the map is off. Google is not called. */
async function askMap(api: ApiClient, placeIds: readonly string[], theme: ThemeMode): Promise<PlaceMap> {
  const body = await api.json('/api/places/map', mapAnswerSchema, { method: 'POST', body: { placeIds, theme } });
  return body.map;
}

export function usePlacesMap(api: ApiClient, placeIds: readonly string[]): PlaceMap {
  const theme = useMapTheme();
  const ids = [...placeIds].sort().join(',');
  /** The set and the mode; empty with no ids. */
  const key = ids === '' ? '' : `${theme} ${ids}`;
  /** Each set's map, by key. */
  const [answers, setAnswers] = useState(NO_ANSWERS);
  /** The key whose ask failed, while it is current. */
  const [failed, setFailed] = useState<string | null>(null);
  /** The map last shown, held while the next is asked. */
  const [held, setHeld] = useState<PlaceMap>(null);

  const known = key === '' || answers.has(key);
  useEffect(() => {
    if (known) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      askMap(api, ids.split(','), theme).then(
        (map) => { if (current) setAnswers((before) => new Map(before).set(key, map)); },
        () => { if (current) setFailed(key); },
      );
    }, MAP_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, ids, theme, key, known]);

  // undefined while the set's map is still being asked for.
  const shown = key === '' ? null : answers.has(key) ? (answers.get(key) ?? null) : failed === key ? null : undefined;
  if (shown !== undefined && shown !== held) setHeld(shown);
  return shown === undefined ? held : shown;
}
