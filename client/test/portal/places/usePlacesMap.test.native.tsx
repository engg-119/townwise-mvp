import { act, cleanup, renderHook } from '@testing-library/react-native';

import { MAP_DEBOUNCE_MS, usePlacesMap } from '../../../src/portal/places/usePlacesMap';
import { resetThemeMode, setThemeMode } from '../../../src/portal/shell/themeMode';
import { ACCESS, deferred, fakePortalApi, meOf, offline, refusal, type FakePortalApi } from '../../helpers/portal';
import { installPlaces, mapOf, type PlacesFake } from '../onboarding/places-fakes';

// The checklist's one map (places/usePlacesMap.ts): it asks POST /api/places/map for the checked set 400 ms after the
// set last changed, with the ids sorted so the same set is the same URL; keeps each answer, so a set seen before sends
// nothing; holds the last map while the next is asked; drops an answer for a set that is no longer current; and any
// failure leaves no map, with no error to show. On native every map is dark: the apps stay dark.

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
  resetThemeMode();
});

const A = 'ChIJTestPlace0001';
const B = 'ChIJTestPlace0002';
const C = 'ChIJTestPlace0004';

async function setup(initial: readonly string[]) {
  jest.useFakeTimers();
  const api: FakePortalApi = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  const places: PlacesFake = installPlaces(api);
  const hook = await renderHook(({ ids }: { ids: readonly string[] }) => usePlacesMap(api, ids), { initialProps: { ids: initial } });
  const show = async (ids: readonly string[]): Promise<void> => { await hook.rerender({ ids }); };
  return { api, places, hook, show };
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

test('the debounce is 400 ms', () => {
  expect(MAP_DEBOUNCE_MS).toBe(400);
});

test('the request carries theme dark, whatever the portal’s mode store holds', async () => {
  setThemeMode('light');
  const { api, hook } = await setup([A]);
  await wait(400);
  expect(api.calls.filter((call) => call.path === '/api/places/map').map((call) => call.body)).toEqual([{ placeIds: [A], theme: 'dark' }]);
  expect(hook.result.current).toEqual(mapOf([A]));
});

test('asks for the map 400 ms after the checked set last changed, with the ids sorted', async () => {
  const { places, hook, show } = await setup([B, A]);
  expect(hook.result.current).toBeNull();
  await wait(399);
  expect(places.mapCalls).toEqual([]);
  await wait(1);
  expect(places.mapCalls).toEqual([[A, B]]);
  expect(hook.result.current).toEqual(mapOf([A, B]));

  // Each change restarts the wait, and the last map stays while the next is asked.
  await show([A, B, C]);
  await wait(200);
  await show([C, A]);
  expect(hook.result.current).toEqual(mapOf([A, B]));
  await wait(399);
  expect(places.mapCalls).toEqual([[A, B]]);
  expect(hook.result.current).toEqual(mapOf([A, B]));
  await wait(1);
  expect(places.mapCalls).toEqual([[A, B], [A, C]]);
  expect(hook.result.current).toEqual(mapOf([A, C]));
});

test('a set asked before comes from memory and sends nothing', async () => {
  const { places, hook, show } = await setup([A]);
  await wait(400);
  await show([A, B]);
  await wait(400);
  expect(places.mapCalls).toEqual([[A], [A, B]]);
  await show([A]);
  expect(hook.result.current).toEqual(mapOf([A]));
  await show([B, A]);
  expect(hook.result.current).toEqual(mapOf([A, B]));
  await wait(1000);
  expect(places.mapCalls).toEqual([[A], [A, B]]);
});

test('with no ids there is no map and nothing is sent', async () => {
  const { places, hook, show } = await setup([]);
  await wait(1000);
  expect(hook.result.current).toBeNull();
  expect(places.mapCalls).toEqual([]);
  await show([A]);
  await wait(400);
  expect(hook.result.current).toEqual(mapOf([A]));
  // The last place removed: no map at once, nothing held.
  await show([]);
  expect(hook.result.current).toBeNull();
  await wait(1000);
  expect(places.mapCalls).toEqual([[A]]);
});

test('429, 503 or any other failure leaves no map', async () => {
  const failures: (() => unknown)[] = [
    () => refusal(429, 'rate_limited', 60),
    () => refusal(503, 'unavailable'),
    () => offline(),
    // An answer the schema refuses: an unsigned URL.
    () => ({ map: { url: 'https://maps.googleapis.com/maps/api/staticmap?markers=x', width: 640, height: 320 } }),
  ];
  for (const failure of failures) {
    const { api, hook, show } = await setup([A]);
    await wait(400);
    expect(hook.result.current).toEqual(mapOf([A]));
    api.answers['/api/places/map'] = failure;
    await show([A, B]);
    await wait(400);
    expect(hook.result.current).toBeNull();
    await hook.unmount();
  }
});

test('the map answers null while the map is off', async () => {
  const { places, hook } = await setup([]);
  places.mapOn = false;
  await hook.rerender({ ids: [A] });
  await wait(400);
  expect(places.mapCalls).toEqual([[A]]);
  expect(hook.result.current).toBeNull();
});

test('an answer for a set that is no longer current is dropped', async () => {
  const { api, places, hook, show } = await setup([A]);
  const held = deferred<unknown>();
  const answer = api.answers['/api/places/map'];
  api.answers['/api/places/map'] = (body) => {
    api.answers['/api/places/map'] = answer ?? (() => null);
    places.mapCalls.push((body as { placeIds: string[] }).placeIds);
    return held.promise;
  };
  await wait(400);
  expect(places.mapCalls).toEqual([[A]]);
  await show([A, B]);
  await act(async () => {
    held.resolve({ map: mapOf([A]) });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  expect(hook.result.current).toBeNull();
  await wait(400);
  expect(hook.result.current).toEqual(mapOf([A, B]));
  // The dropped answer was not kept: going back to A asks again.
  await show([A]);
  await wait(400);
  expect(places.mapCalls).toEqual([[A], [A, B], [A]]);
  expect(hook.result.current).toEqual(mapOf([A]));
});
