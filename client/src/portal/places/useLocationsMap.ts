import { useEffect, useState } from 'react';
import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { placeMapSchema, useMapTheme } from './map';

// D47 (Settings' map hover): GET /api/org/locations/map, the lettered map of the organization's locations in the
// portal's mode, with where each pin sits on the image as fractions of its width and height. The API takes the places
// from the organization itself, so nothing is sent but the mode. Asked again when the mode or the set of places
// changes (`placesKey`); the last answer stays while the next loads. Any failure (429, 503, the network, an answer the
// schema refuses) leaves no map and no pins: the rows under it carry the information.

const fraction = z.number().min(0).max(1);

export const locationsMapSchema = z.object({
  map: placeMapSchema,
  pins: z.array(z.object({ placeId: z.string(), letter: z.string().regex(/^[A-Z]$/), x: fraction, y: fraction })).max(26),
});

export type LocationsMapAnswer = z.infer<typeof locationsMapSchema>;

const NONE: LocationsMapAnswer = { map: null, pins: [] };

export function useLocationsMap(api: ApiClient, placesKey: string): LocationsMapAnswer {
  const theme = useMapTheme();
  const [answer, setAnswer] = useState<LocationsMapAnswer>(NONE);
  useEffect(() => {
    if (placesKey === '') return undefined;
    let current = true;
    api.json(`/api/org/locations/map?theme=${theme}`, locationsMapSchema).then(
      (body) => { if (current) setAnswer(body); },
      () => { if (current) setAnswer(NONE); },
    );
    return () => { current = false; };
  }, [api, theme, placesKey]);
  // No places, no map, at once; otherwise the last answer stays while the next loads.
  return placesKey === '' ? NONE : answer;
}
