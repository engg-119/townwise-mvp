// Google Places (New), behind the Places proxy routes (handlers/places.ts), as a port. main.ts builds the real one when
// GOOGLE_PLACES_API_KEY is set and passes it to createTownwiseApi; tests build it over a fake fetch. Nothing here logs.
// What Google is sent (the typed text, a place id, a point) and what it answers leave this file only as the return value;
// every failure is a PlacesUnavailableError carrying a code and Google's HTTP status, never a message or a body from
// Google. D66 adds `nearby` (the competitors around a location) and `profile` (the restaurant's name and address for a
// research prompt); neither answer is stored (openspec change town-research-agent, design decision 10).
import { z } from 'zod';

import { PLACE_ID_PATTERN } from '../place-id.ts';

const PLACES_API = 'https://places.googleapis.com/v1';
/** Each call to Google, from the request to the last byte of the answer. */
export const PLACES_TIMEOUT_MS = 5000;
const MAX_SUGGESTIONS = 5;
/** Place Details Essentials: no displayName (the client keeps the name from the suggestion it picked). */
const DETAILS_FIELD_MASK = 'id,formattedAddress,addressComponents';
/**
 * A bias toward where Townwise works, State College, PA to Bar Harbor, ME with margin (D29). Without one Google biases
 * by the caller's IP, which is the API's data center, not the person. A bias, not a restriction: a business elsewhere
 * in the US is still found by its name.
 */
const SEARCH_BIAS = { rectangle: { low: { latitude: 40.4, longitude: -80.6 }, high: { latitude: 47.5, longitude: -66.9 } } };
/** Google's types that make a prediction a business, and those that make it an exact street address. */
const BUSINESS_TYPES: ReadonlySet<string> = new Set(['establishment', 'point_of_interest']);
const ADDRESS_TYPES: ReadonlySet<string> = new Set(['street_address', 'premise', 'subpremise']);

/** `address`: a street address, for a business Google does not list. */
export type PlaceKind = 'business' | 'address';
export interface PlaceSuggestion { placeId: string; name: string; detail: string; kind: PlaceKind }
export interface AddressComponent { longText: string; shortText: string; types: readonly string[] }
export interface PlaceDetails { placeId: string; formattedAddress: string; addressComponents: AddressComponent[] }
/** D66: a place around a point, as Nearby Search answers it. `website` only when asked for (a research run). */
export interface NearbyPlace {
  placeId: string;
  name: string;
  /** Google's primary type; null when it gave none. */
  primaryType: string | null;
  lat: number;
  lng: number;
  website: string | null;
}
/** D66: the restaurant's Google name and address. */
export interface PlaceProfile { placeId: string; name: string; address: string }

/** `upstream_status`: Google answered non-2xx. `bad_response`: its 2xx answer was not the expected JSON. */
export type PlacesFailure = 'timeout' | 'network' | 'upstream_status' | 'bad_response';

export class PlacesUnavailableError extends Error {
  readonly code: PlacesFailure;
  /** Google's HTTP status, for `upstream_status`. */
  readonly status: number | null;
  /** The error class, for `network`. */
  readonly errType: string | null;

  constructor(code: PlacesFailure, opts?: { status?: number; errType?: string }) {
    super('Google Places is unavailable');
    this.name = 'PlacesUnavailableError';
    this.code = code;
    this.status = opts?.status ?? null;
    this.errType = opts?.errType ?? null;
  }
}

export interface PlacesClient {
  /** At most five business or address predictions, in Google's order. Throws PlacesUnavailableError. */
  autocomplete(input: string, sessionToken: string): Promise<PlaceSuggestion[]>;
  /** Null when Google has no place with this id. Throws PlacesUnavailableError. */
  details(placeId: string, sessionToken: string): Promise<PlaceDetails | null>;
  /**
   * D47: the place's latitude and longitude (Place Details Essentials, `location` only, no session), for Settings'
   * map; null when Google has no such place. Throws PlacesUnavailableError.
   */
  locate(placeId: string): Promise<{ lat: number; lng: number } | null>;
  /**
   * D66: food and drink places within `radiusM` of `center`, nearest first, at most NEARBY_MAX, each with its website
   * only with `withWebsite` (a research run; the Competition card never asks for it). Throws PlacesUnavailableError.
   */
  nearby(center: { lat: number; lng: number }, opts: { radiusM: number; withWebsite: boolean }): Promise<NearbyPlace[]>;
  /** D66: the place's name and address (no session); null when Google has no such place or no name for it. Throws PlacesUnavailableError. */
  profile(placeId: string): Promise<PlaceProfile | null>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const textSchema = z.object({ text: z.string() });
const placePredictionSchema = z.object({
  placePrediction: z.object({
    placeId: z.string(),
    structuredFormat: z.object({ mainText: textSchema, secondaryText: textSchema.optional() }),
    types: z.array(z.string()).optional(),
  }),
});
const autocompleteSchema = z.object({ suggestions: z.array(z.unknown()).optional() });
/** D47: only the place's point. */
const LOCATE_FIELD_MASK = 'id,location';
const locateSchema = z.object({ location: z.object({ latitude: z.number(), longitude: z.number() }).optional() });

/**
 * D66: Nearby Search's types. `includedTypes` matches any of a place's types, not only its primary one (task 0.2's
 * probe got a book store), so research/competitors.ts filters by `primaryType` too.
 */
export const NEARBY_TYPES: readonly string[] = ['restaurant', 'bar', 'cafe', 'coffee_shop', 'pub', 'bakery', 'fast_food_restaurant'];
export const NEARBY_MAX = 20;
const NEARBY_FIELD_MASK = 'places.id,places.displayName,places.primaryType,places.location';
const NEARBY_WEBSITE_FIELD = 'places.websiteUri';
const PROFILE_FIELD_MASK = 'id,displayName,formattedAddress';
const displayNameSchema = z.object({ text: z.string() });
const nearbySchema = z.object({ places: z.array(z.unknown()).optional() });
const nearbyPlaceSchema = z.object({
  id: z.string(),
  displayName: displayNameSchema,
  primaryType: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
  websiteUri: z.string().optional(),
});
const profileSchema = z.object({ id: z.string().optional(), displayName: displayNameSchema.optional(), formattedAddress: z.string().optional() });

const detailsSchema = z.object({
  id: z.string().optional(),
  formattedAddress: z.string().optional(),
  addressComponents: z.array(z.object({
    longText: z.string().optional(),
    shortText: z.string().optional(),
    types: z.array(z.string()).optional(),
  })).optional(),
});
const googleErrorSchema = z.object({
  error: z.object({
    status: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

function errTypeOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

async function discard(res: Response): Promise<void> {
  if (res.body !== null && !res.bodyUsed) await res.body.cancel().catch(() => undefined);
}

/** The answer's JSON. A parse error's message quotes the body, so it never travels on. */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new PlacesUnavailableError(isTimeout(err) ? 'timeout' : 'bad_response');
  }
}

/**
 * Google answers 400 INVALID_ARGUMENT for a place id it cannot read. It answers the same for a bad API key, with an
 * ErrorInfo reason such as API_KEY_INVALID; that one stays a 503 rather than looking like an unknown place.
 */
function isUnknownPlaceId(body: unknown): boolean {
  const parsed = googleErrorSchema.safeParse(body);
  if (!parsed.success || parsed.data.error.status !== 'INVALID_ARGUMENT') return false;
  return !(parsed.data.error.details ?? []).some((detail) => detail.reason?.startsWith('API_KEY') === true);
}

/**
 * A prediction's kind from Google's types, or null for anything else (a town, county, street without a number, postal
 * code, neighborhood or plus code), which is not offered. Without types it is a business, so a result that cannot be
 * classified is never lost.
 */
function kindOf(types: readonly string[] | undefined): PlaceKind | null {
  if (types === undefined || types.length === 0 || types.some((type) => BUSINESS_TYPES.has(type))) return 'business';
  return types.some((type) => ADDRESS_TYPES.has(type)) ? 'address' : null;
}

function suggestionsOf(raw: readonly unknown[]): PlaceSuggestion[] {
  const suggestions: PlaceSuggestion[] = [];
  for (const item of raw) {
    // A query prediction, or anything else without a place, is skipped.
    const parsed = placePredictionSchema.safeParse(item);
    if (!parsed.success) continue;
    const { placeId, structuredFormat, types } = parsed.data.placePrediction;
    const kind = kindOf(types);
    if (!PLACE_ID_PATTERN.test(placeId) || structuredFormat.mainText.text === '' || kind === null) continue;
    suggestions.push({ placeId, name: structuredFormat.mainText.text, detail: structuredFormat.secondaryText?.text ?? '', kind });
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions;
}

/** Nearby Search's places, item by item: one without an id, a name or a point is skipped. A website only when http(s). */
function nearbyOf(raw: readonly unknown[], withWebsite: boolean): NearbyPlace[] {
  const places: NearbyPlace[] = [];
  for (const item of raw) {
    const parsed = nearbyPlaceSchema.safeParse(item);
    if (!parsed.success) continue;
    const { id, displayName, primaryType, location, websiteUri } = parsed.data;
    if (!PLACE_ID_PATTERN.test(id) || displayName.text === '') continue;
    const protocol = websiteUri === undefined ? null : URL.parse(websiteUri)?.protocol;
    places.push({
      placeId: id, name: displayName.text, primaryType: primaryType ?? null, lat: location.latitude, lng: location.longitude,
      website: withWebsite && (protocol === 'https:' || protocol === 'http:') ? websiteUri ?? null : null,
    });
    if (places.length === NEARBY_MAX) break;
  }
  return places;
}

/** No retries: a failure answers 503 and the client offers the manual fields. */
export function createGooglePlacesClient(
  apiKey: string,
  opts?: { fetch?: FetchLike; timeoutMs?: number },
): PlacesClient {
  const fetchFn: FetchLike = opts?.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts?.timeoutMs ?? PLACES_TIMEOUT_MS;

  const send = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw isTimeout(err) ? new PlacesUnavailableError('timeout') : new PlacesUnavailableError('network', { errType: errTypeOf(err) });
    }
  };

  /** Place Details by id with a field mask, no session: its JSON, or null when Google has no such place. */
  const placeById = async (placeId: string, fieldMask: string): Promise<unknown> => {
    const res = await send(`${PLACES_API}/places/${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
    });
    if (res.status === 404) {
      await discard(res);
      return null;
    }
    if (res.status === 400) {
      if (isUnknownPlaceId(await jsonOf(res))) return null;
      throw new PlacesUnavailableError('upstream_status', { status: res.status });
    }
    if (!res.ok) {
      await discard(res);
      throw new PlacesUnavailableError('upstream_status', { status: res.status });
    }
    return jsonOf(res);
  };

  return {
    autocomplete: async (input, sessionToken) => {
      const res = await send(`${PLACES_API}/places:autocomplete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        // Any US business or address: no includedPrimaryTypes; suggestionsOf drops the other kinds.
        body: JSON.stringify({ input, sessionToken, includedRegionCodes: ['us'], languageCode: 'en', locationBias: SEARCH_BIAS }),
      });
      if (!res.ok) {
        await discard(res);
        throw new PlacesUnavailableError('upstream_status', { status: res.status });
      }
      const parsed = autocompleteSchema.safeParse(await jsonOf(res));
      if (!parsed.success) throw new PlacesUnavailableError('bad_response');
      return suggestionsOf(parsed.data.suggestions ?? []);
    },

    details: async (placeId, sessionToken) => {
      const query = new URLSearchParams({ sessionToken }).toString();
      const res = await send(`${PLACES_API}/places/${encodeURIComponent(placeId)}?${query}`, {
        method: 'GET',
        headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAILS_FIELD_MASK },
      });
      if (res.status === 404) {
        await discard(res);
        return null;
      }
      if (res.status === 400) {
        if (isUnknownPlaceId(await jsonOf(res))) return null;
        throw new PlacesUnavailableError('upstream_status', { status: res.status });
      }
      if (!res.ok) {
        await discard(res);
        throw new PlacesUnavailableError('upstream_status', { status: res.status });
      }
      const parsed = detailsSchema.safeParse(await jsonOf(res));
      if (!parsed.success) throw new PlacesUnavailableError('bad_response');
      const { id, formattedAddress, addressComponents } = parsed.data;
      return {
        // Google may answer with a newer id for the same place; keep the requested one if its id looks wrong.
        placeId: id !== undefined && PLACE_ID_PATTERN.test(id) ? id : placeId,
        formattedAddress: formattedAddress ?? '',
        addressComponents: (addressComponents ?? []).map((component) => ({
          longText: component.longText ?? '',
          shortText: component.shortText ?? '',
          types: component.types ?? [],
        })),
      };
    },

    locate: async (placeId) => {
      const body = await placeById(placeId, LOCATE_FIELD_MASK);
      if (body === null) return null;
      const parsed = locateSchema.safeParse(body);
      if (!parsed.success) throw new PlacesUnavailableError('bad_response');
      const at = parsed.data.location;
      return at === undefined ? null : { lat: at.latitude, lng: at.longitude };
    },

    nearby: async (center, opts) => {
      const res = await send(`${PLACES_API}/places:searchNearby`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': opts.withWebsite ? `${NEARBY_FIELD_MASK},${NEARBY_WEBSITE_FIELD}` : NEARBY_FIELD_MASK,
        },
        body: JSON.stringify({
          includedTypes: NEARBY_TYPES, maxResultCount: NEARBY_MAX, rankPreference: 'DISTANCE', languageCode: 'en',
          locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: opts.radiusM } },
        }),
      });
      if (!res.ok) {
        await discard(res);
        throw new PlacesUnavailableError('upstream_status', { status: res.status });
      }
      const parsed = nearbySchema.safeParse(await jsonOf(res));
      if (!parsed.success) throw new PlacesUnavailableError('bad_response');
      return nearbyOf(parsed.data.places ?? [], opts.withWebsite);
    },

    profile: async (placeId) => {
      const body = await placeById(placeId, PROFILE_FIELD_MASK);
      if (body === null) return null;
      const parsed = profileSchema.safeParse(body);
      if (!parsed.success) throw new PlacesUnavailableError('bad_response');
      const { id, displayName, formattedAddress } = parsed.data;
      // A place with no name has no profile to name the restaurant by.
      if (displayName === undefined || displayName.text === '') return null;
      return { placeId: id !== undefined && PLACE_ID_PATTERN.test(id) ? id : placeId, name: displayName.text, address: formattedAddress ?? '' };
    },
  };
}
