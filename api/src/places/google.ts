// Google Places (New), behind the Places proxy routes (handlers/places.ts), as a port. main.ts builds the real one when
// GOOGLE_PLACES_API_KEY is set and passes it to createTownwiseApi; tests build it over a fake fetch. Nothing here logs.
// What Google is sent (the typed text, a place id) and what it answers leave this file only as the return value; every
// failure is a PlacesUnavailableError carrying a code and Google's HTTP status, never a message or a body from Google.
import { z } from 'zod';

const PLACES_API = 'https://places.googleapis.com/v1';
/** Each call to Google, from the request to the last byte of the answer. */
export const PLACES_TIMEOUT_MS = 5000;
const MAX_SUGGESTIONS = 5;
/** Place Details Essentials: no displayName (the client keeps the name from the suggestion it picked). */
const DETAILS_FIELD_MASK = 'id,formattedAddress,addressComponents';

/** The place ids the details route accepts, and the only ones autocomplete passes on. */
export const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{10,300}$/;

export interface PlaceSuggestion { placeId: string; name: string; detail: string }
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
  /** At most five place predictions, in Google's order. Throws PlacesUnavailableError. */
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

function suggestionsOf(raw: readonly unknown[]): PlaceSuggestion[] {
  const suggestions: PlaceSuggestion[] = [];
  for (const item of raw) {
    // A query prediction, or anything else without a place, is skipped.
    const parsed = placePredictionSchema.safeParse(item);
    if (!parsed.success) continue;
    const { placeId, structuredFormat } = parsed.data.placePrediction;
    if (!PLACE_ID_PATTERN.test(placeId) || structuredFormat.mainText.text === '') continue;
    suggestions.push({ placeId, name: structuredFormat.mainText.text, detail: structuredFormat.secondaryText?.text ?? '' });
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
        // Any US business: no includedPrimaryTypes.
        body: JSON.stringify({ input, sessionToken, includedRegionCodes: ['us'], languageCode: 'en' }),
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
