jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, within } from 'expo-router/testing-library';
import { Dimensions, Keyboard, StyleSheet, type KeyboardEvent } from 'react-native';

import { ACCESS, deferred, fakePortalApi, meOf, orgOf, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { townEvent } from '../analytics/fakes';
import { calendarFake, forecastDay, forecastOf, NOTES_PATH, savedNote } from './fakes';

// The note form's popover on native (calendar-views' "The note form opens in a popover", its Native scenario): on a
// phone, Add an event opens the note form in a Modal pinned to the top of the window, a keyboard that shows keeps the
// card's bottom above it, and Android's back button closes it, except while a save runs. Today is Wed, Nov 11, 2026.
// Synthetic figures and made-up titles only.

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 11, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
  // A phone, 375 by 667.
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 });
});

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const SATURDAY = '2026-11-21';

function setup(): { api: FakePortalApi } {
  const days = Array.from({ length: 20 }, (_, at) => forecastDay({ date: `2026-11-${String(11 + at)}` }));
  const fake = calendarFake({ events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })], forecasts: { '2026-11': forecastOf(days) } });
  return { api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }) };
}

function panel(): ReturnType<typeof screen.getByLabelText> {
  return screen.getByLabelText('Selected day');
}

/** The popover's card: the dialog its heading names. */
function card(): ReturnType<typeof screen.getByLabelText> {
  return screen.getByLabelText('Add an event');
}

/** The host Modal around the card, where Android's back button lands (onRequestClose). */
function modal(): Parameters<typeof fireEvent>[0] {
  let node = card();
  while (node.type !== 'Modal' && node.parent !== null) node = node.parent;
  if (node.type !== 'Modal') throw new Error('no Modal');
  return node;
}

function cardStyle(): Record<string, unknown> {
  return StyleSheet.flatten(card().props.style as Parameters<typeof StyleSheet.flatten>[0]) as Record<string, unknown>;
}

async function openForm(api: FakePortalApi): Promise<void> {
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await within(await screen.findByLabelText('Selected day')).findByRole('button', { name: 'Add an event' }));
}

test('Add an event opens the note form in a Modal, headed by it, and the day panel keeps its button and none of the form', async () => {
  const { api } = setup();
  await openForm(api);
  const dialog = card();
  expect(dialog.props.role).toBe('dialog');
  expect(modal().props).toMatchObject({ visible: true, transparent: true, animationType: 'none' });
  expect(within(dialog).getAllByRole('heading')).toHaveLength(1);
  expect(within(dialog).getByRole('heading', { name: 'Add an event' })).toBeTruthy();
  expect(within(dialog).getByLabelText('Expected guests (optional)')).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Save note' })).toBeTruthy();
  expect(within(panel()).queryByLabelText('Expected guests (optional)')).toBeNull();
  expect(within(panel()).getByRole('button', { name: 'Add an event' })).toBeTruthy();
  // On a phone the card is pinned to the top of the window, 16px from either side.
  expect(cardStyle()).toMatchObject({ width: 343, left: 16 });
});

test('a keyboard that shows keeps the card’s bottom above it, and hidden again gives the room back', async () => {
  const listeners = new Map<string, ((event: KeyboardEvent) => void)[]>();
  const addListener = Keyboard.addListener.bind(Keyboard);
  jest.spyOn(Keyboard, 'addListener').mockImplementation((type, listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    return addListener(type, listener);
  });
  const { api } = setup();
  await openForm(api);
  const before = cardStyle();
  const bottom = (style: Record<string, unknown>): number => Number(style.top) + Number(style.maxHeight);
  expect(bottom(before)).toBeLessThanOrEqual(667);
  const keyboard = { screenX: 0, screenY: 367, width: 375, height: 300 };
  const event: KeyboardEvent = { endCoordinates: keyboard, startCoordinates: keyboard, isEventFromThisApp: true, duration: 0, easing: 'keyboard' };
  await act(() => { for (const listener of listeners.get('keyboardDidShow') ?? []) listener(event); });
  expect(cardStyle().top).toBe(before.top);
  expect(bottom(cardStyle())).toBeLessThanOrEqual(367);
  await act(() => { for (const listener of listeners.get('keyboardDidHide') ?? []) listener(event); });
  expect(cardStyle().maxHeight).toBe(before.maxHeight);
});

test('the back button closes it, but not while a save runs', async () => {
  const { api } = setup();
  await openForm(api);
  await fireEvent.changeText(within(card()).getByLabelText('Expected guests (optional)'), '70');
  const answer = deferred<unknown>();
  api.answers[NOTES_PATH] = () => answer.promise;
  await fireEvent.press(within(card()).getByRole('button', { name: 'Save note' }));
  expect(within(card()).getByRole('button', { name: 'Saving…' })).toBeTruthy();
  await fireEvent(modal(), 'requestClose');
  expect(card()).toBeTruthy();
  await act(async () => { answer.resolve(savedNote('n9', writes(api)[0]?.body)); await Promise.resolve(); });
  // The save closed it.
  expect(await screen.findByText(/^Saved\./)).toBeTruthy();
  expect(screen.queryByLabelText('Add an event')).toBeNull();

  await fireEvent.press(within(panel()).getByRole('button', { name: 'Add an event' }));
  await fireEvent.changeText(within(card()).getByLabelText('Expected guests (optional)'), '30');
  await fireEvent(modal(), 'requestClose');
  expect(screen.queryByLabelText('Add an event')).toBeNull();
  expect(writes(api)).toHaveLength(1);
});
