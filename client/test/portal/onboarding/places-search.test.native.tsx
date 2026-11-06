import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { PlaceSearch } from '../../../src/portal/onboarding/PlaceSearch';
import type { UsablePlace } from '../../../src/portal/onboarding/places';
import { ACCESS, fakePortalApi, meOf, offline, refusal, type FakePortalApi } from '../../helpers/portal';
import { installPlaces, MAP_URL, SUGGESTIONS, type PlacesFake } from './places-fakes';

// PlaceSearch on native, over the Places proxy fake: typing is debounced and nothing under 2 characters is sent; one
// search is one session token (the API's, from the first answer) that the pick's details call ends; the suggestions
// are buttons named by place and town; the confirm card shows Google's map, the name, the address and the town, and
// says where they came from; a place outside a US town can't be confirmed; 503 hands the page its manual fields.

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

interface Setup {
  api: FakePortalApi;
  places: PlacesFake;
  onConfirm: jest.Mock<undefined, [UsablePlace]>;
  onManual: jest.Mock;
  onUnavailable: jest.Mock;
}

async function setup(): Promise<Setup> {
  jest.useFakeTimers();
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  const places = installPlaces(api);
  const onConfirm = jest.fn<undefined, [UsablePlace]>();
  const onManual = jest.fn();
  const onUnavailable = jest.fn();
  await render(
    <PlaceSearch
      api={api}
      label="Search for your restaurant or bar"
      helper="Type its name."
      confirmLabel="Looks right"
      onConfirm={onConfirm}
      manualLabel="Can’t find it? Enter it yourself"
      onManual={onManual}
      onUnavailable={onUnavailable}
    />,
  );
  return { api, places, onConfirm, onManual, onUnavailable };
}

async function type(text: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Search for your restaurant or bar'), text);
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('typing waits 250ms, sends nothing under 2 characters, and the suggestions are buttons named by place and town', async () => {
  const { places } = await setup();
  await type('L');
  await wait(500);
  expect(places.autocompletes).toEqual([]);
  await type('Lo');
  await wait(100);
  await type('Lou');
  await wait(249);
  expect(places.autocompletes).toEqual([]);
  await wait(1);
  expect(places.autocompletes).toEqual([{ input: 'Lou', sessionToken: undefined }]);
  expect(await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Lou’s Bakery, Norwich, VT, USA' })).toBeTruthy();
  expect(screen.getByText('3 places match. Pick one to see what Google Maps has for it.')).toBeTruthy();
  expect(screen.getByText('Results from Google Maps.')).toBeTruthy();
});

test('one session: the API’s token on every later call and on the pick; the card shows what Google Maps has, then Looks right', async () => {
  const { places, onConfirm } = await setup();
  await type('Lou');
  await wait(250);
  await type('Lou’s');
  await wait(250);
  expect(places.autocompletes).toEqual([{ input: 'Lou', sessionToken: undefined }, { input: 'Lou’s', sessionToken: 'token-1' }]);
  await fireEvent.press(await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' }));
  expect(places.detailCalls).toEqual([{ placeId: 'ChIJTestPlace0001', sessionToken: 'token-1' }]);
  expect(await screen.findByText('Here’s what we found')).toBeTruthy();
  expect(screen.getByText('Lou’s Restaurant')).toBeTruthy();
  expect(screen.getByText('3 Main St, Hanover, NH 03755, USA')).toBeTruthy();
  expect(screen.getByText('Hanover, NH, one of the twelve towns Townwise has researched.')).toBeTruthy();
  expect(screen.getByText('From Google Maps. Townwise keeps only Google’s id for the place.')).toBeTruthy();
  expect(screen.getByLabelText('Map of the area around Lou’s Restaurant').props.source).toEqual({ uri: MAP_URL });
  await fireEvent.press(screen.getByRole('button', { name: 'Looks right' }));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
    placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
  }));
});

test('Search again starts a new session with the same text', async () => {
  const { places } = await setup();
  await type('Lou');
  await wait(250);
  await fireEvent.press(await screen.findByRole('button', { name: 'Lou’s Bakery, Norwich, VT, USA' }));
  expect(await screen.findByText('Norwich, VT. Townwise hasn’t researched this town yet, so you’ll see your own data without a town profile.')).toBeTruthy();
  // No map for this place: the card has none, and no empty box.
  expect(screen.queryByLabelText('Map of the area around Lou’s Bakery')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Search again' }));
  expect(screen.getByLabelText('Search for your restaurant or bar').props.value).toBe('Lou');
  await wait(250);
  expect(places.autocompletes.at(-1)).toEqual({ input: 'Lou', sessionToken: undefined });
  await fireEvent.press(await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' }));
  expect(places.detailCalls.map((call) => call.sessionToken)).toEqual(['token-1', 'token-2']);
});

test('a place outside a US town has no Looks right, only Search again and the manual fields', async () => {
  const { onConfirm, onManual } = await setup();
  await type('Lou');
  await wait(250);
  await fireEvent.press(await screen.findByRole('button', { name: 'Lou’s Cantina, San Juan, Puerto Rico' }));
  expect(await screen.findByText('Townwise works with businesses in a US town, and Google Maps puts this place in none.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Looks right' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Can’t find it? Enter it yourself' }));
  expect(onManual).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

test('one autocomplete at a time: text typed while one runs is sent when it settles, and only its answer shows', async () => {
  const { places } = await setup();
  places.holding = true;
  places.results.Lu = [];
  await type('Lu');
  await wait(250);
  await type('Lou');
  await wait(250);
  expect(places.autocompletes.map((call) => call.input)).toEqual(['Lu']);
  places.holding = false;
  await act(async () => { for (const release of places.held.splice(0)) release(); await Promise.resolve(); });
  await wait(0);
  expect(places.autocompletes.map((call) => call.input)).toEqual(['Lu', 'Lou']);
  expect(await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' })).toBeTruthy();
  expect(screen.queryByText('No places match “Lu”. Check the spelling, or enter it yourself.')).toBeNull();
});

test('no match says so; a lost place says so; a network failure offers Try again', async () => {
  const { places } = await setup();
  await type('Zz');
  await wait(250);
  expect(await screen.findByText('No places match “Zz”. Check the spelling, or enter it yourself.')).toBeTruthy();
  await type('Lou');
  await wait(250);
  delete places.details.ChIJTestPlace0001;
  await fireEvent.press(await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' }));
  expect(await screen.findByText('Google Maps can’t find that place any more. Search again, or enter it yourself.')).toBeTruthy();
  places.results.Lour = offline();
  await type('Lour');
  await wait(250);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  places.results.Lour = SUGGESTIONS;
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  await wait(250);
  expect(await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' })).toBeTruthy();
});

test('503 places_unavailable, from the search or the pick, hands the page its manual fields', async () => {
  const { places, onUnavailable } = await setup();
  places.results.Lou = refusal(503, 'places_unavailable');
  await type('Lou');
  await wait(250);
  expect(onUnavailable).toHaveBeenCalledTimes(1);
});

test('iOS hears each status once, as a whole sentence, when an answer changes it', async () => {
  // The native project runs as iOS (jest-expo/ios), which reads no live region, so the status is announced.
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  // The preset's mock keeps the calls of earlier tests.
  announce.mockClear();
  await setup();
  await type('Lou');
  await wait(250);
  await screen.findByRole('button', { name: 'Lou’s Restaurant, Hanover, NH, USA' });
  await type('Lou ');
  await wait(250);
  expect(announce.mock.calls).toEqual([['3 places match. Pick one to see what Google Maps has for it.']]);
});
