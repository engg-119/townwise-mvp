// Google Places (New), behind the Places proxy routes (handlers/places.ts), as a port. main.ts builds the real one when
// GOOGLE_PLACES_API_KEY is set and passes it to createTownwiseApi; tests build it over a fake fetch. Nothing here logs.
// What Google is sent (the typed text, a place id) and what it answers leave this file only as the return value; every
// failure is a PlacesUnavailableError carrying a code and Google's HTTP status, never a message or a body from Google.
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
  };
}
