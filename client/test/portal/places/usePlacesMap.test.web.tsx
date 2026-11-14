import { act, cleanup, renderHook } from '@testing-library/react';

import type { PlaceMap } from '../../../src/portal/places/map';
import { usePlacesMap } from '../../../src/portal/places/usePlacesMap';
import { resetThemeMode, setThemeMode } from '../../../src/portal/shell/themeMode';
import { ACCESS, fakePortalApi, meOf, type FakePortalApi } from '../../helpers/portal';

// The checklist's map on web follows the portal's mode (places/usePlacesMap.ts, places/map.ts): POST /api/places/map
// carries `theme`, the mode now, and switching light or dark asks for the other mode's map, after the same 400 ms, with
// the shown map held meanwhile; switching back shows the map kept for that mode, with nothing sent.

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  localStorage.clear();
  resetThemeMode();
});

const A = 'ChIJTestPlace0001';
const B = 'ChIJTestPlace0002';

/** The API's answer for these ids in this mode: the pin's color tells the two apart, as the API's does. */
function mapIn(placeIds: readonly string[], theme: string): NonNullable<PlaceMap> {
  const pin = theme === 'light' ? '0x136a53' : '0x7bd2b4';
  const markers = placeIds.map((id) => `place_id%3A${id}`).join('%7C');
  return {
    url: `https://maps.googleapis.com/maps/api/staticmap?markers=color%3A${pin}%7C${markers}&key=test-static-key&signature=BBBBBBBBBBBBBBBBBBBBBBBBBBB=`,
    width: 640,
    height: 320,
  };
}

function setup(ids: readonly string[]) {
  jest.useFakeTimers();
  const api: FakePortalApi = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  api.answers['/api/places/map'] = (raw) => {
    const { placeIds, theme } = raw as { placeIds: string[]; theme: string };
    return { map: mapIn(placeIds, theme) };
  };
  const hook = renderHook(({ shown }: { shown: readonly string[] }) => usePlacesMap(api, shown), { initialProps: { shown: ids } });
  const sent = (): unknown[] => api.calls.filter((call) => call.path === '/api/places/map').map((call) => call.body);
  return { api, hook, sent };
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function flip(mode: 'light' | 'dark'): Promise<void> {
  await act(async () => {
    setThemeMode(mode);
    await Promise.resolve();
  });
}

test('the request carries the mode now: dark until the person picks light, light once they have', async () => {
  const dark = setup([B, A]);
  await wait(400);
  expect(dark.sent()).toEqual([{ placeIds: [A, B], theme: 'dark' }]);
  expect(dark.hook.result.current).toEqual(mapIn([A, B], 'dark'));
  dark.hook.unmount();

  setThemeMode('light');
  const light = setup([A]);
  await wait(400);
  expect(light.sent()).toEqual([{ placeIds: [A], theme: 'light' }]);
  expect(light.hook.result.current).toEqual(mapIn([A], 'light'));
});

test('switching the mode asks for the other mode’s map, holding the shown one meanwhile; switching back sends nothing', async () => {
  const { hook, sent } = setup([A, B]);
  await wait(400);
  expect(hook.result.current).toEqual(mapIn([A, B], 'dark'));

  await flip('light');
  expect(hook.result.current).toEqual(mapIn([A, B], 'dark'));
  await wait(399);
  expect(sent()).toEqual([{ placeIds: [A, B], theme: 'dark' }]);
  await wait(1);
  expect(sent()).toEqual([{ placeIds: [A, B], theme: 'dark' }, { placeIds: [A, B], theme: 'light' }]);
  expect(hook.result.current).toEqual(mapIn([A, B], 'light'));

  // The dark map was kept: it shows at once, and nothing is asked.
  await flip('dark');
  expect(hook.result.current).toEqual(mapIn([A, B], 'dark'));
  await wait(1000);
  expect(sent()).toHaveLength(2);
});

test('an answer for the mode left behind is dropped', async () => {
  const { api, hook, sent } = setup([A]);
  let release: () => void = () => undefined;
  api.answers['/api/places/map'] = (raw) => {
    const { placeIds, theme } = raw as { placeIds: string[]; theme: string };
    return new Promise((resolve) => { release = () => { resolve({ map: mapIn(placeIds, theme) }); }; });
  };
  await wait(400);
  expect(sent()).toEqual([{ placeIds: [A], theme: 'dark' }]);
  await flip('light');
  await act(async () => {
    release();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  // The dark answer came after the switch: not shown, and not kept.
  expect(hook.result.current).toBeNull();
  api.answers['/api/places/map'] = (raw) => {
    const { placeIds, theme } = raw as { placeIds: string[]; theme: string };
    return { map: mapIn(placeIds, theme) };
  };
  await wait(400);
  expect(hook.result.current).toEqual(mapIn([A], 'light'));
  await flip('dark');
  await wait(400);
  expect(sent()).toEqual([{ placeIds: [A], theme: 'dark' }, { placeIds: [A], theme: 'light' }, { placeIds: [A], theme: 'dark' }]);
  expect(hook.result.current).toEqual(mapIn([A], 'dark'));
});
