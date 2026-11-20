// What the research runner asks Google (D66, design decision 10), as two ports main.ts builds when Places is on: the
// restaurant's profile (its Google name and address) and its competitors (Nearby Search around its point). The runner
// asks them for a request only while TOWNWISE_RESEARCH_PLACES_TO_AI allows Google's names to go to Anthropic; with it
// off, research asks Google only the profile, at a location merge whose competitors thread found something, to compare
// Google's name with the businesses found (never stored or sent; as fixed in UI review). The point comes from the 29-day Valkey cache Settings' map keeps (handlers/locations-map.ts
// `pointOf`), so nothing Google answers is written to Mongo. A Google failure answers null, logged by code: the thread
// then ends `places_off` (no profile) or searches the web for competitors (no list), and next week's run asks again.
import type { Logger } from '@ckeith26/server-core';

import { PlacesUnavailableError, type PlacesClient } from '../places/google.ts';
import { COMPETITOR_RADIUS_M, pickCompetitors, type Competitor, type Point } from './competitors.ts';
import type { RestaurantProfile } from './prompt.ts';

export interface ResearchPlaces {
  /** The restaurant's Google name and address; null when Google has none or fails. */
  profile(placeId: string): Promise<RestaurantProfile | null>;
  /** The restaurant's competitors with their websites; null when its point is unknown or Google fails. */
  competitors(placeId: string): Promise<Competitor[] | null>;
}

export function createResearchPlaces(deps: {
  readonly places: PlacesClient;
  /** The place's point (the shared Valkey cache, else Google); null when it can't be had. */
  readonly pointOf: (placeId: string) => Promise<Point | null>;
  readonly logger: Pick<Logger, 'warn'>;
}): ResearchPlaces {
  const unavailable = (err: unknown, call: string): null => {
    if (!(err instanceof PlacesUnavailableError)) throw err;
    deps.logger.warn({ call, code: err.code, status: err.status, errType: err.errType }, 'townwise.research_places_failed');
    return null;
  };
  return {
    profile: async (placeId) => {
      try {
        const found = await deps.places.profile(placeId);
        return found === null ? null : { name: found.name, address: found.address };
      } catch (err) {
        return unavailable(err, 'profile');
      }
    },
    competitors: async (placeId) => {
      const center = await deps.pointOf(placeId);
      if (center === null) return null;
      try {
        const places = await deps.places.nearby(center, { radiusM: COMPETITOR_RADIUS_M, withWebsite: true });
        return pickCompetitors({ ownPlaceId: placeId, center, places });
      } catch (err) {
        return unavailable(err, 'nearby');
      }
    },
  };
}
