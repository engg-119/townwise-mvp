import type { PlaceDetails, PlaceSuggestion } from '../../../src/portal/onboarding/places';
import { refusal, type FakePortalApi } from '../../helpers/portal';

// The Google Places proxy (api/README.md, Places search) on the portal fake: POST /api/places/autocomplete and
// /api/places/details answer from these fields, the way the API does. An empty body is the search's on/off check
// (onboarding/places.ts checkPlaceSearch): 400 invalid_request while `on`, else 503 places_unavailable. The first
// autocomplete of a session gets the token `token-1`, the next session `token-2`, and so on. Fixtures stay
// low-entropy: ids like ChIJTestPlace0001.

export const SUGGESTIONS: PlaceSuggestion[] = [
  { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', detail: 'Hanover, NH, USA' },
  { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', detail: 'Norwich, VT, USA' },
  { placeId: 'ChIJTestPlace0003', name: 'Lou’s Cantina', detail: 'San Juan, Puerto Rico' },
];

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
};

export interface PlacesFake {
  on: boolean;
  /** Each search's answer, by the text sent; anything else matches nothing. An ApiError answers with it. */
  results: Record<string, PlaceSuggestion[] | Error>;
  /** Details by place id; an ApiError answers with it; an unknown id is 404 place_not_found. */
  details: Record<string, PlaceDetails | Error>;
  autocompletes: { input: string; sessionToken: string | undefined }[];
  detailCalls: { placeId: string; sessionToken: string }[];
  checks: number;
  /** While true, each autocomplete waits in `held` until the test releases it. */
  holding: boolean;
  held: (() => void)[];
}

export function installPlaces(api: FakePortalApi, init?: Partial<Pick<PlacesFake, 'on' | 'results' | 'details'>>): PlacesFake {
  const fake: PlacesFake = {
    on: init?.on ?? true,
    results: init?.results ?? { Lou: SUGGESTIONS, 'Lou’s': SUGGESTIONS },
    details: init?.details ?? { ...DETAILS },
    autocompletes: [],
    detailCalls: [],
    checks: 0,
    holding: false,
    held: [],
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
  api.answers['/api/places/details'] = (raw) => {
    const body = raw as { placeId: string; sessionToken: string };
    fake.detailCalls.push(body);
    if (!fake.on) return refusal(503, 'places_unavailable');
    const answer = fake.details[body.placeId];
    if (answer === undefined) return refusal(404, 'place_not_found');
    return answer instanceof Error ? answer : { place: answer };
  };
  return fake;
}

/** The writes the page sent, without the Places proxy's calls. */
export function sentWrites(api: FakePortalApi): { method: string; path: string; body: unknown }[] {
  return api.calls.filter((call) => call.method !== 'GET' && !call.path.startsWith('/api/places/'));
}
