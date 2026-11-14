import { placeDetails } from '../../../src/portal/onboarding/places';
import { resetThemeMode, setThemeMode } from '../../../src/portal/shell/themeMode';
import { ACCESS, fakePortalApi, meOf } from '../../helpers/portal';
import { installPlaces } from './places-fakes';

// The confirm card's map follows the portal's mode on web: POST /api/places/details carries the mode shown, so the
// API signs the light or dark Static Map (api/src/places/static-map.ts), as POST /api/places/map does.

afterEach(() => {
  localStorage.clear();
  resetThemeMode();
});

function detailsBodies(api: ReturnType<typeof fakePortalApi>): unknown[] {
  return api.calls.filter((call) => call.path === '/api/places/details').map((call) => call.body);
}

/** A Google place id for the requests, kept in a constant so it never sits next to `api` in a call. */
const PLACE_ID = 'ChIJTestPlace0001';

test('the details request carries the mode shown: dark by default (no system light), light once picked', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  installPlaces(api);
  await placeDetails(api, PLACE_ID, 'token-1');
  // Read when the request is made, so a pick between two checks reaches the next one.
  setThemeMode('light');
  await placeDetails(api, PLACE_ID, null);
  expect(detailsBodies(api)).toStrictEqual([
    { placeId: 'ChIJTestPlace0001', sessionToken: 'token-1', theme: 'dark' },
    { placeId: 'ChIJTestPlace0001', theme: 'light' },
  ]);
});
