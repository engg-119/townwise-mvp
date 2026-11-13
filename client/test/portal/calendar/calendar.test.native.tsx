jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { townEvent } from '../analytics/fakes';
import { calendarFake, forecastDay, forecastOf, NOTES_PATH, savedNote, type CalendarFake } from './fakes';

// P27 Calendar on native (spec 16.3): the same reads and grid as on web, a Pressable grid with the day
// panel under it, adding a note from the day, and no calendar file import (no file picker is installed). Today is
// Wed, Nov 11, 2026. Synthetic figures only.

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 11, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

const GAME_REASON = { kind: 'event', label: 'Dartmouth home football', effectPct: 12, sources: [], note: null };
const SATURDAY = '2026-11-21';
const LABEL = 'Sat, Nov 21, 2026. Forecast about 212 guests, 180 to 240. Dartmouth home football.';

function november(guests = 0): unknown {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    if (date !== SATURDAY) days.push(forecastDay({ date }));
    else if (guests === 0) days.push(forecastDay({ date, reasons: [GAME_REASON] }));
    else {
      days.push(forecastDay({
        date, low: 180 + guests, mid: 212 + guests, high: 240 + guests, model: { status: 'open', low: 180, mid: 212, high: 240 }, noteGuests: guests,
        reasons: [{ kind: 'note', label: `Your private event, ${String(guests)} guests`, effectPct: null, sources: [], note: { id: 'n9', guests, outcome: 'added' } }, GAME_REASON],
      }));
    }
  }
  return forecastOf(days);
}

function setup(): { api: FakePortalApi; fake: CalendarFake } {
  const fake = calendarFake({ events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })], forecasts: { '2026-11': november() } });
  return { api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }), fake };
}

function panel() {
  return screen.getByLabelText('Selected day');
}

test('tapping a day shows its forecast and reasons under the grid', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/calendar', api);
  expect(await screen.findByText('Today, Wed, Nov 11')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(LABEL));
  expect(within(panel()).getByText('Sat, Nov 21, 2026')).toBeTruthy();
  expect(within(panel()).getByText('About 212 guests')).toBeTruthy();
  expect(within(panel()).getByText('Likely 180 to 240. About 8 in 10 days land in the range.')).toBeTruthy();
  expect(within(panel()).getByText('Dartmouth home football')).toBeTruthy();
  expect(within(panel()).getByText('+12%')).toBeTruthy();
  expect(screen.getByLabelText(LABEL).props.accessibilityState).toMatchObject({ selected: true });
});

test('no import control; the line says to use the web', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/calendar', api);
  expect(await screen.findByText('To add events from your own calendar file, open Townwise on the web.')).toBeTruthy();
  expect(screen.queryByText('Import a calendar file')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
});

test('adds a note from the day and reloads the forecast', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Add an event' }));
  await fireEvent.changeText(screen.getByLabelText('Expected guests (optional)'), '70');
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november(70);
    return saved;
  };
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  expect(await within(panel()).findByText('Adds 70 guests')).toBeTruthy();
  expect(within(panel()).getByText('About 282 guests')).toBeTruthy();
  expect(fake.paths.filter((path) => path.includes('/forecast?'))).toHaveLength(2);
  expect(writes(api)).toEqual([{
    method: 'POST', path: NOTES_PATH,
    body: {
      kind: 'private_event', startDate: SATURDAY, endDate: SATURDAY, weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
      startTime: null, endTime: null,
    },
  }]);
});
