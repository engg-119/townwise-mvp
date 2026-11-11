import type { PlaceDetails, PlaceSuggestion } from '../../../src/portal/onboarding/places';
import { refusal, type FakePortalApi } from '../../helpers/portal';

// The Google Places proxy (api/README.md, Places search) on the portal fake: POST /api/places/autocomplete and
// /api/places/details answer from these fields, the way the API does. An empty body is the search's on/off check
// (onboarding/places.ts checkPlaceSearch): 400 invalid_request while `on`, else 503 places_unavailable. The first
// autocomplete of a session gets the token `token-1`, the next session `token-2`, and so on; a details call may carry
// none (a checked place after the first in one list). Fixtures stay low-entropy: ids like ChIJTestPlace0001.

export const SUGGESTIONS: PlaceSuggestion[] = [
  { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', detail: 'Hanover, NH, USA' },
  { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', detail: 'Norwich, VT, USA' },
  { placeId: 'ChIJTestPlace0003', name: 'Lou’s Cantina', detail: 'San Juan, Puerto Rico' },
];

/** Another place with the first suggestion's name, in Lebanon: answered for “Lou Lebanon”. */
export const SAME_NAME: PlaceSuggestion = { placeId: 'ChIJTestPlace0004', name: 'Lou’s Restaurant', detail: 'Lebanon, NH, USA' };

/** A 100-character name, longer than a request keeps: answered for “Long”. */
export const LONG_NAME: PlaceSuggestion = { placeId: 'ChIJTestPlace0005', name: `Lou’s ${'x'.repeat(94)}`, detail: 'Hanover, NH, USA' };

const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } as const;

export const MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap?center=place_id%3AChIJTestPlace0001&key=test-static-key&signature=AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export const DETAILS: Record<string, PlaceDetails> = {
  ChIJTestPlace0001: {
    placeId: 'ChIJTestPlace0001', address: '3 Main St, Hanover, NH 03755, USA',
    town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, map: { url: MAP_URL, width: 640, height: 320 },
  },
  ChIJTestPlace0002: {
    placeId: 'ChIJTestPlace0002', address: '5 Elm St, Norwich, VT 05055, USA',
    town: { townId: null, name: 'Norwich', state: 'VT' }, map: null,
  },
  ChIJTestPlace0003: { placeId: 'ChIJTestPlace0003', address: 'Calle Uno, San Juan, Puerto Rico', town: null, map: null },
  ChIJTestPlace0004: {
    placeId: 'ChIJTestPlace0004', address: '9 Main St, Lebanon, NH 03766, USA', town: { townId: null, name: 'Lebanon', state: 'NH' }, map: null,
  },
  ChIJTestPlace0005: { placeId: 'ChIJTestPlace0005', address: '1 Main St, Hanover, NH 03755, USA', town: HANOVER, map: null },
};

export interface PlacesFake {
  on: boolean;
  /** Each search's answer, by the text sent; anything else matches nothing. An ApiError answers with it. */
  results: Record<string, PlaceSuggestion[] | Error>;
  /** Details by place id; an ApiError answers with it; an unknown id is 404 place_not_found. */
  details: Record<string, PlaceDetails | Error>;
  autocompletes: { input: string; sessionToken: string | undefined }[];
  /** `sessionToken` is undefined when the call carried none. */
  detailCalls: { placeId: string; sessionToken: string | undefined }[];
  checks: number;
  /** While true, each autocomplete waits in `held` until the test releases it. */
  holding: boolean;
  held: (() => void)[];
  /** While true, each details call waits in `heldDetails`, in call order, until the test releases it. */
  holdingDetails: boolean;
  heldDetails: (() => void)[];
}

export function installPlaces(api: FakePortalApi, init?: Partial<Pick<PlacesFake, 'on' | 'results' | 'details'>>): PlacesFake {
  const fake: PlacesFake = {
    on: init?.on ?? true,
    results: init?.results ?? { Lou: SUGGESTIONS, 'Lou’s': SUGGESTIONS, 'Lou Lebanon': [SAME_NAME], Long: [LONG_NAME] },
    details: init?.details ?? { ...DETAILS },
    autocompletes: [],
    detailCalls: [],
    checks: 0,
    holding: false,
    held: [],
    holdingDetails: false,
    heldDetails: [],
  };
  let sessions = 0;
  api.answers['/api/places/autocomplete'] = async (raw) => {
    const body = raw as { input?: string; sessionToken?: string };
    if (body.input === undefined) {
      fake.checks += 1;
      return fake.on ? refusal(400, 'invalid_request') : refusal(503, 'places_unavailable');
    }
    if (!fake.on) return refusal(503, 'places_unavailable');
    fake.autocompletes.push({ input: body.input, sessionToken: body.sessionToken });
    if (fake.holding) await new Promise<void>((resolve) => { fake.held.push(resolve); });
    const answer = fake.results[body.input] ?? [];
    if (answer instanceof Error) return answer;
    if (body.sessionToken === undefined) sessions += 1;
    return { suggestions: answer, sessionToken: body.sessionToken ?? `token-${String(sessions)}` };
  };
  api.answers['/api/places/details'] = async (raw) => {
    const body = raw as { placeId: string; sessionToken?: string };
    fake.detailCalls.push({ placeId: body.placeId, sessionToken: body.sessionToken });
    if (fake.holdingDetails) await new Promise<void>((resolve) => { fake.heldDetails.push(resolve); });
    if (!fake.on) return refusal(503, 'places_unavailable');
    const answer = fake.details[body.placeId];
    if (answer === undefined) return refusal(404, 'place_not_found');
    return answer instanceof Error ? answer : { place: answer };
  };
  return fake;
}

/**
 * Adds `count` places in Hanover (ChIJTestMany0001, named “Many Place 1”, and on), five to a query: “Many 1” answers
 * the first five, “Many 2” the next, and so on. Returns the queries.
 */
export function manyPlaces(fake: PlacesFake, count: number): string[] {
  const queries: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const placeId = `ChIJTestMany${String(i).padStart(4, '0')}`;
    const query = `Many ${String(Math.ceil(i / 5))}`;
    if (queries.at(-1) !== query) queries.push(query);
    const answer = fake.results[query];
    const suggestion = { placeId, name: `Many Place ${String(i)}`, detail: 'Hanover, NH, USA' };
    fake.results[query] = Array.isArray(answer) ? [...answer, suggestion] : [suggestion];
    fake.details[placeId] = { placeId, address: `${String(i)} Many St, Hanover, NH 03755, USA`, town: HANOVER, map: null };
  }
  return queries;
}

/** The writes the page sent, without the Places proxy's calls. */
export function sentWrites(api: FakePortalApi): { method: string; path: string; body: unknown }[] {
  return api.calls.filter((call) => call.method !== 'GET' && !call.path.startsWith('/api/places/'));
}
