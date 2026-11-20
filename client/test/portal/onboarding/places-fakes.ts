import type { PlaceDetails, PlaceSuggestion } from '../../../src/portal/onboarding/places';
import type { PlaceMap } from '../../../src/portal/places/map';
import { refusal, type FakePortalApi } from '../../helpers/portal';

// The Google Places proxy (api/README.md, Places search) on the portal fake: POST /api/places/autocomplete and
// /api/places/details answer from these fields, the way the API does, and POST /api/places/map signs a map of the ids
// sent (mapOf) whether or not the search is on, or answers null while `mapOn` is false. GET /api/places/status is the
// search's on/off check (onboarding/places.ts checkPlaceSearch), counted in `checks`. An autocomplete the API would
// refuse (an input under 2 characters after trimming) answers 400 invalid_request while `on`, as the API does, and is
// kept in `refused`, so a test can pin that none is sent. The first
// autocomplete of a session gets the token `token-1`, the next session `token-2`, and so on; a details call may carry
// none (a checked place after the first in one list). Fixtures stay low-entropy: ids like ChIJTestPlace0001.

export const SUGGESTIONS: PlaceSuggestion[] = [
  { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', detail: 'Hanover, NH, USA', kind: 'business' },
  { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', detail: 'Norwich, VT, USA', kind: 'business' },
  { placeId: 'ChIJTestPlace0003', name: 'Lou’s Cantina', detail: 'San Juan, Puerto Rico', kind: 'business' },
];

/** Another place with the first suggestion's name, in Lebanon: answered for “Lou Lebanon”. */
export const SAME_NAME: PlaceSuggestion = { placeId: 'ChIJTestPlace0004', name: 'Lou’s Restaurant', detail: 'Lebanon, NH, USA', kind: 'business' };

/** Another place with the first suggestion's name in its town, Hanover, so the two default to one Name: answered for “Lou West”. */
export const SAME_TOWN: PlaceSuggestion = {
  placeId: 'ChIJTestPlace0007', name: 'Lou’s Restaurant', detail: 'West Wheelock Street, Hanover, NH, USA', kind: 'business',
};

/** A street address, for a business Google doesn't list: answered for “12 South”. */
export const ADDRESS: PlaceSuggestion = { placeId: 'ChIJTestPlace0006', name: '12 South Main Street', detail: 'Hanover, NH, USA', kind: 'address' };

/** A 100-character name, longer than a request keeps: answered for “Long”. */
export const LONG_NAME: PlaceSuggestion = { placeId: 'ChIJTestPlace0005', name: `Lou’s ${'x'.repeat(94)}`, detail: 'Hanover, NH, USA', kind: 'business' };

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
  ChIJTestPlace0006: { placeId: 'ChIJTestPlace0006', address: '12 S Main St, Hanover, NH 03755, USA', town: HANOVER, map: null },
  ChIJTestPlace0007: { placeId: 'ChIJTestPlace0007', address: '20 W Wheelock St, Hanover, NH 03755, USA', town: HANOVER, map: null },
};

/** The map POST /api/places/map answers for these ids: a signed URL with a pin for each, in the order sent. */
export function mapOf(placeIds: readonly string[]): NonNullable<PlaceMap> {
  const markers = placeIds.map((id) => `place_id%3A${id}`).join('%7C');
  return {
    url: `https://maps.googleapis.com/maps/api/staticmap?markers=color%3A0x7bd2b4%7C${markers}&key=test-static-key&signature=BBBBBBBBBBBBBBBBBBBBBBBBBBB=`,
    width: 640,
    height: 320,
  };
}

export interface PlacesFake {
  on: boolean;
  /** The map signer is on: false answers `{ map: null }`. */
  mapOn: boolean;
  /** Each map call's placeIds, in call order. */
  mapCalls: string[][];
  /** Each search's answer, by the text sent; anything else matches nothing. An ApiError answers with it. */
  results: Record<string, PlaceSuggestion[] | Error>;
  /** Details by place id; an ApiError answers with it; an unknown id is 404 place_not_found. */
  details: Record<string, PlaceDetails | Error>;
  autocompletes: { input: string; sessionToken: string | undefined }[];
  /** `sessionToken` is undefined when the call carried none. */
  detailCalls: { placeId: string; sessionToken: string | undefined }[];
  checks: number;
  /** Each autocomplete body the API would refuse with 400 invalid_request. */
  refused: unknown[];
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
    mapOn: true,
    mapCalls: [],
    results: init?.results ?? { Lou: SUGGESTIONS, 'Lou’s': SUGGESTIONS, 'Lou Lebanon': [SAME_NAME], 'Lou West': [SAME_TOWN], Long: [LONG_NAME], '12 South': [ADDRESS] },
    details: init?.details ?? { ...DETAILS },
    autocompletes: [],
    detailCalls: [],
    checks: 0,
    refused: [],
    holding: false,
    held: [],
    holdingDetails: false,
    heldDetails: [],
  };
  let sessions = 0;
  api.answers['GET /api/places/status'] = () => {
    fake.checks += 1;
    return { placeSearch: fake.on };
  };
  api.answers['/api/places/autocomplete'] = async (raw) => {
    const body = raw as { input?: unknown; sessionToken?: string };
    // The API checks the key before the body, so while the search is off every body is 503.
    if (!fake.on) return refusal(503, 'places_unavailable');
    if (typeof body.input !== 'string' || body.input.trim().length < 2 || body.input.trim().length > 120) {
      fake.refused.push(raw);
      return refusal(400, 'invalid_request');
    }
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
  api.answers['/api/places/map'] = (raw) => {
    const { placeIds } = raw as { placeIds: string[] };
    fake.mapCalls.push(placeIds);
    return { map: fake.mapOn ? mapOf(placeIds) : null };
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
    const suggestion: PlaceSuggestion = { placeId, name: `Many Place ${String(i)}`, detail: 'Hanover, NH, USA', kind: 'business' };
    fake.results[query] = Array.isArray(answer) ? [...answer, suggestion] : [suggestion];
    fake.details[placeId] = { placeId, address: `${String(i)} Many St, Hanover, NH 03755, USA`, town: HANOVER, map: null };
  }
  return queries;
}

/** The writes the page sent, without the Places proxy's calls. */
export function sentWrites(api: FakePortalApi): { method: string; path: string; body: unknown }[] {
  return api.calls.filter((call) => call.method !== 'GET' && !call.path.startsWith('/api/places/'));
}
