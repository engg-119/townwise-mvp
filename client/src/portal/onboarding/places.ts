import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { withOrgId, type AccessRequestInput, type TownInput } from '../api';
import { hasCode } from '../errors';
import { mapThemeNow, placeMapSchema, type PlaceMap } from '../places/map';
import {
  createdLocationSchema, meResponseSchema, placeKindSchema, townSchema, type LocationSummary, type MeResponse, type PlaceKind, type Town,
} from '../schemas';

// The Google Places search's /api calls (api/README.md, Places search; spec 10.2a) and the three writes that carry the
// place a person confirmed: the access request (P3), a new location (P10) and a location's place (P16). The API asks
// Google; the app talks only to the API, except for the map image (places/map.ts). Nothing here logs: the typed text,
// the place id and the address stay in memory.

/** The fewest characters, after trimming, that the API sends to Google (autocomplete's `input`). */
export const MIN_SEARCH_LENGTH = 2;
/** The most it takes. */
export const MAX_SEARCH_LENGTH = 120;

/** `kind` reads as a business when absent, for an API from before kinds. */
export const placeSuggestionSchema = z.object({
  placeId: z.string(), name: z.string(), detail: z.string(), kind: placeKindSchema.default('business'),
});
export type PlaceSuggestion = z.infer<typeof placeSuggestionSchema>;

/**
 * The line under a suggestion's name: Google's secondary text for a business; for a street address, “Street address · ”
 * before it (“Street address” alone with none), so the person sees which is which.
 */
export function suggestionLine(suggestion: Pick<PlaceSuggestion, 'detail' | 'kind'>): string {
  if (suggestion.kind === 'address') return suggestion.detail === '' ? 'Street address' : `Street address · ${suggestion.detail}`;
  return suggestion.detail;
}

/** What names a suggestion's box or option, and its checked row and Remove: “{name}, {line}”, or the name with no line. */
export function suggestionLabel(suggestion: Pick<PlaceSuggestion, 'name' | 'detail' | 'kind'>): string {
  const line = suggestionLine(suggestion);
  return line === '' ? suggestion.name : `${suggestion.name}, ${line}`;
}

const autocompleteSchema = z.object({ suggestions: z.array(placeSuggestionSchema), sessionToken: z.string() });

const detailsSchema = z.object({
  place: z.object({
    placeId: z.string(),
    address: z.string(),
    /** One of the twelve, another US town, or null outside the 50 states and DC or with no town (spec 10.2a). */
    town: townSchema.nullable(),
    map: placeMapSchema.default(null),
  }),
});
export type PlaceDetails = z.infer<typeof detailsSchema>['place'];

/** A place the person picked: the suggestion's name (details doesn't ask Google for one) and kind, and the details answer. */
export interface FoundPlace extends PlaceDetails {
  name: string;
  kind: PlaceKind;
}

/** A found place in a US town, which a request or a location can take. */
export type UsablePlace = FoundPlace & { town: Town };

export function usable(place: FoundPlace): place is UsablePlace {
  return place.town !== null;
}

/**
 * Whether the search is on, without asking Google: autocomplete checks the key before the body, so an empty body
 * answers 503 places_unavailable while the search is off and 400 invalid_request while it is on (api/test
 * places-off.int.test.ts and places.int.test.ts pin both). Any other answer counts as off.
 */
export async function checkPlaceSearch(api: ApiClient): Promise<boolean> {
  try {
    await api.json('/api/places/autocomplete', autocompleteSchema, { method: 'POST', body: {} });
    return true;
  } catch (error) {
    return hasCode(error, 400, 'invalid_request');
  }
}

/**
 * Up to 5 suggestions. The first call of a search sends no session token: the API makes one and returns it, and the
 * search sends it from then on, so the typing and the pick are one session that Google bills once.
 */
export function autocompletePlaces(
  api: ApiClient, input: string, sessionToken: string | null,
): Promise<{ suggestions: PlaceSuggestion[]; sessionToken: string }> {
  return api.json('/api/places/autocomplete', autocompleteSchema, {
    method: 'POST', body: { input, ...(sessionToken === null ? {} : { sessionToken }) },
  });
}

/**
 * Ends the session whose token it carries. Null sends none, and the API makes one of its own: a checked place after
 * the first in one list, whose search's session the first check ended.
 */
export async function placeDetails(api: ApiClient, placeId: string, sessionToken: string | null): Promise<PlaceDetails> {
  // The mode shown (dark on native), so the confirm card's map is signed to match, as POST /api/places/map is.
  const body = await api.json('/api/places/details', detailsSchema, {
    method: 'POST', body: { placeId, ...(sessionToken === null ? {} : { sessionToken }), theme: mapThemeNow() },
  });
  return body.place;
}

const mapAnswerSchema = z.object({ map: placeMapSchema });

/**
 * POST /api/places/map: the signed map of every place (a pin each), or null while the map is off. Signing is the
 * API's own work, so Google is not called and the search need not be on.
 */
export async function placesMapFor(api: ApiClient, placeIds: readonly string[]): Promise<PlaceMap> {
  const body = await api.json('/api/places/map', mapAnswerSchema, { method: 'POST', body: { placeIds } });
  return body.map;
}

/** The TownInput for a place's town, as the request and the location routes take it. */
export function townInputOf(town: Town): TownInput {
  return town.townId === null ? { townId: null, name: town.name, state: town.state } : { townId: town.townId };
}

/** `Hanover, NH`. */
export function townLabel(town: Town): string {
  return `${town.name}, ${town.state}`;
}

/** Google's name for a place as a request keeps it: trimmed, and at most the API's 80 characters. */
export function placeName(place: { name: string }): string {
  return place.name.trim().slice(0, 80);
}

/** POST /api/access-requests, as sendAccessRequest (../api.ts) with the checked places, each with its kind. 201 answers the new access. */
export function sendAccessRequestAt(api: ApiClient, input: AccessRequestInput, places: readonly UsablePlace[]): Promise<MeResponse> {
  return api.json('/api/access-requests', meResponseSchema, {
    method: 'POST',
    body: { ...input, places: places.map((p) => ({ placeId: p.placeId, name: placeName(p), kind: p.kind, town: townInputOf(p.town) })) },
  });
}

/**
 * POST /api/org/locations, as createLocation (../api.ts) with the place's id. The API asks Google for the place and
 * refuses a town that isn't its own (400 place_town_mismatch).
 */
export async function createLocationAt(
  api: ApiClient, input: { name: string; town: TownInput }, placeId: string, orgId: string | null,
): Promise<LocationSummary> {
  const body = await api.json('/api/org/locations', createdLocationSchema, { method: 'POST', body: withOrgId({ ...input, placeId }, orgId) });
  return body.location;
}

/** PATCH /api/org/locations/:locationId with a place and its town (P16, Change this location's place). */
export async function setLocationPlace(api: ApiClient, locationId: string, place: UsablePlace): Promise<LocationSummary> {
  const body = await api.json(`/api/org/locations/${encodeURIComponent(locationId)}`, createdLocationSchema, {
    method: 'PATCH', body: { town: townInputOf(place.town), placeId: place.placeId },
  });
  return body.location;
}

/** The answers that mean Google sees the place differently now: search again. */
export function placeChanged(error: unknown): boolean {
  return hasCode(error, 400, 'place_town_mismatch') || hasCode(error, 400, 'unknown_place') || hasCode(error, 400, 'place_not_supported');
}

export function placesUnavailable(error: unknown): boolean {
  return hasCode(error, 503, 'places_unavailable');
}
