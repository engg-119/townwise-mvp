import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import { useEffect } from 'react';

import { CHECKLIST_COPY, outsideUsLine } from '../../../src/portal/onboarding/checklist';
import type { PlaceSuggestion } from '../../../src/portal/onboarding/places';
import { PlaceChecklist } from '../../../src/portal/onboarding/PlaceChecklist';
import { usePlaceChecklist, type PlaceChecklistState } from '../../../src/portal/onboarding/usePlaceChecklist';
import { PLACES_SOURCE } from '../../../src/portal/places/PlaceCard';
import { ACCESS, fakePortalApi, meOf, refusal, type FakePortalApi } from '../../helpers/portal';
import { DETAILS, installPlaces, manyPlaces, mapOf, SUGGESTIONS, type PlacesFake } from './places-fakes';

// The places checklist on native (usePlaceChecklist over PlaceChecklist), over the Places proxy fake: each suggestion
// is a checkbox named by place and town; checking one asks Google for its details (the first check of a search ends
// that search's session with its token, later ones carry none) and adds the place below the field, in check order,
// with its facts and Remove, under one map of every checked place; a place outside a US town, a 503 or a 404 leaves it unchecked and says why; at 25
// the other boxes are disabled; and a search 503 hands the page its manual fields only while nothing is checked.

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
  rendered = null;
});

const LABEL = 'Search for your restaurant or bar';
const LINE = 'Google Maps isn’t answering right now, so you can enter your restaurant yourself.';
const RESTAURANT = 'Lou’s Restaurant, Hanover, NH, USA';
const BAKERY = 'Lou’s Bakery, Norwich, VT, USA';
const CANTINA = 'Lou’s Cantina, San Juan, Puerto Rico';

const HANOVER = DETAILS.ChIJTestPlace0001;
const CANTINA_SUGGESTION = SUGGESTIONS[2];
if (HANOVER === undefined || CANTINA_SUGGESTION === undefined) throw new Error('fixture');

/** The hook's state as last rendered, to toggle a suggestion the way a web press on an aria-disabled box would. */
let rendered: PlaceChecklistState | null = null;

function Harness(p: { api: FakePortalApi; onUnavailable: () => void }): React.JSX.Element {
  const state = usePlaceChecklist(p.api, LINE);
  useEffect(() => { rendered = state; });
  return <PlaceChecklist state={state} label={LABEL} onUnavailable={p.onUnavailable} />;
}

/** Toggles past the field: the hook refuses what the field shows disabled. */
async function toggleDirectly(suggestion: PlaceSuggestion): Promise<void> {
  await run(() => { rendered?.toggle(suggestion); });
}

interface Setup {
  api: FakePortalApi;
  places: PlacesFake;
  onUnavailable: jest.Mock;
}

async function setup(prepare?: (places: PlacesFake) => void): Promise<Setup> {
  jest.useFakeTimers();
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  const places = installPlaces(api);
  prepare?.(places);
  const onUnavailable = jest.fn();
  await render(<Harness api={api} onUnavailable={onUnavailable} />);
  return { api, places, onUnavailable };
}

/** Runs `fn`, then lets the fake API's answers land. */
async function run(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function wait(ms: number): Promise<void> {
  await run(() => { jest.advanceTimersByTime(ms); });
}

/** Types the text and waits out the debounce and the answer. */
async function search(text: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText(LABEL), text);
  await wait(250);
}

function box(name: string): ReturnType<typeof screen.getByRole> {
  return screen.getByRole('checkbox', { name });
}

/** Presses the box and lets its details land. */
async function press(name: string): Promise<void> {
  await fireEvent.press(box(name));
  await wait(0);
}

/** The checked list's rows, in order: each a group named by its place and town, as its box is. */
function groupNames(): string[] {
  return screen.queryAllByLabelText(/./).filter((node) => node.props.role === 'group').map((node) => String(node.props['aria-label']));
}

function group(name: string): ReturnType<typeof screen.getByLabelText> {
  const found = screen.queryAllByLabelText(name).filter((node) => node.props.role === 'group');
  const [node] = found;
  if (node === undefined || found.length > 1) throw new Error(`expected one group named ${name}, found ${String(found.length)}`);
  return node;
}

test('each suggestion is a checkbox named by place and town; checking shows the loading row, then the place with its facts and Remove', async () => {
  const { places } = await setup();
  await search('Lou');
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  expect(box(BAKERY).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  expect(screen.getByText('3 places match “Lou”. Check each one that’s yours.')).toBeTruthy();
  expect(screen.getByText('Results from Google Maps.')).toBeTruthy();
  expect(screen.queryByText(PLACES_SOURCE)).toBeNull();
  places.holdingDetails = true;
  await fireEvent.press(box(RESTAURANT));
  expect(within(group(RESTAURANT)).getByText('Getting Lou’s Restaurant from Google Maps…')).toBeTruthy();
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  places.holdingDetails = false;
  await run(() => { for (const release of places.heldDetails.splice(0)) release(); });
  expect(screen.queryByText('Getting Lou’s Restaurant from Google Maps…')).toBeNull();
  const row = group(RESTAURANT);
  expect(within(row).getByText('3 Main St, Hanover, NH 03755, USA')).toBeTruthy();
  expect(within(row).getByText('Hanover, NH, one of the twelve towns Townwise has researched.')).toBeTruthy();
  expect(within(row).queryByLabelText(/^Map of/)).toBeNull();
  const remove = within(row).getByRole('button', { name: `Remove ${RESTAURANT}` });
  expect(within(remove).getByText('Remove')).toBeTruthy();
  expect(screen.getAllByText(PLACES_SOURCE)).toHaveLength(1);
});

test('one session per search: the first check ends it with its token, later checks send none, and new text starts a new one', async () => {
  const { api, places } = await setup();
  await search('Lou');
  await press(RESTAURANT);
  await press(BAKERY);
  expect(places.detailCalls).toEqual([
    { placeId: 'ChIJTestPlace0001', sessionToken: 'token-1' },
    { placeId: 'ChIJTestPlace0002', sessionToken: undefined },
  ]);
  // A check without a token leaves it out of the body. Native always asks for the dark map.
  expect(api.calls.filter((call) => call.path === '/api/places/details').map((call) => call.body)).toStrictEqual([
    { placeId: 'ChIJTestPlace0001', sessionToken: 'token-1', theme: 'dark' },
    { placeId: 'ChIJTestPlace0002', theme: 'dark' },
  ]);
  await search('Lou’s');
  expect(places.autocompletes.at(-1)).toEqual({ input: 'Lou’s', sessionToken: undefined });
  await press(CANTINA);
  expect(places.detailCalls.at(-1)).toEqual({ placeId: 'ChIJTestPlace0003', sessionToken: 'token-2' });
});

test('a check while an autocomplete runs ends its session: the late answer brings back neither its token nor its suggestions', async () => {
  const { places } = await setup();
  await search('Lou');
  places.holding = true;
  await search('Lou’s');
  expect(places.autocompletes.at(-1)).toEqual({ input: 'Lou’s', sessionToken: 'token-1' });
  await press(RESTAURANT);
  expect(places.detailCalls).toEqual([{ placeId: 'ChIJTestPlace0001', sessionToken: 'token-1' }]);
  expect(within(group(RESTAURANT)).getByText('3 Main St, Hanover, NH 03755, USA')).toBeTruthy();
  places.holding = false;
  await run(() => { for (const release of places.held.splice(0)) release(); });
  await wait(0);
  expect(screen.getByText('3 places match “Lou”. Check each one that’s yours.')).toBeTruthy();
  await press(BAKERY);
  expect(places.detailCalls.map((call) => call.sessionToken)).toEqual(['token-1', undefined]);
});

test('searching again keeps the checked places, and a checked place shows checked in the new answer', async () => {
  await setup();
  await search('Lou');
  await press(RESTAURANT);
  await search('Lou’s');
  expect(screen.getByText('3 places match “Lou’s”. Check each one that’s yours.')).toBeTruthy();
  expect(groupNames()).toEqual([RESTAURANT]);
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: true, disabled: false });
  expect(box(BAKERY).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
});

test('pressing a checked box, or Remove, unchecks it without asking Google again', async () => {
  const { places } = await setup();
  await search('Lou');
  await press(RESTAURANT);
  expect(places.detailCalls).toHaveLength(1);
  await press(RESTAURANT);
  expect(groupNames()).toEqual([]);
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: false });
  expect(places.detailCalls).toHaveLength(1);
  await press(BAKERY);
  expect(places.detailCalls).toHaveLength(2);
  await fireEvent.press(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
  await wait(0);
  expect(groupNames()).toEqual([]);
  expect(box(BAKERY).props.accessibilityState).toMatchObject({ checked: false });
  expect(places.detailCalls).toHaveLength(2);
  expect(screen.queryByText(PLACES_SOURCE)).toBeNull();
});

test('unchecking while its details load drops the late answer; two loading checks land in check order', async () => {
  const { places } = await setup();
  await search('Lou');
  places.holdingDetails = true;
  await fireEvent.press(box(RESTAURANT));
  expect(groupNames()).toEqual([RESTAURANT]);
  await fireEvent.press(box(RESTAURANT));
  expect(groupNames()).toEqual([]);
  await run(() => { for (const release of places.heldDetails.splice(0)) release(); });
  expect(groupNames()).toEqual([]);
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: false });

  await fireEvent.press(box(RESTAURANT));
  await fireEvent.press(box(BAKERY));
  const [first, second] = places.heldDetails.splice(0);
  await run(() => { second?.(); });
  expect(groupNames()).toEqual([RESTAURANT, BAKERY]);
  expect(within(group(RESTAURANT)).getByText('Getting Lou’s Restaurant from Google Maps…')).toBeTruthy();
  expect(within(group(BAKERY)).getByText('5 Elm St, Norwich, VT 05055, USA')).toBeTruthy();
  await run(() => { first?.(); });
  expect(groupNames()).toEqual([RESTAURANT, BAKERY]);
  expect(within(group(RESTAURANT)).getByText('3 Main St, Hanover, NH 03755, USA')).toBeTruthy();

  // Off the list, then checked, unchecked and checked again while the first answer is late: a 503 for the first check
  // says nothing, and only the new check's answer counts.
  await fireEvent.press(box(RESTAURANT));
  for (let i = 0; i < 3; i += 1) await fireEvent.press(box(RESTAURANT));
  const [stale, fresh] = places.heldDetails.splice(0);
  places.details.ChIJTestPlace0001 = refusal(503, 'places_unavailable');
  await run(() => { stale?.(); });
  expect(screen.queryByText(LINE)).toBeNull();
  expect(within(group(RESTAURANT)).getByText('Getting Lou’s Restaurant from Google Maps…')).toBeTruthy();
  places.details.ChIJTestPlace0001 = HANOVER;
  await run(() => { fresh?.(); });
  expect(groupNames()).toEqual([BAKERY, RESTAURANT]);
  expect(within(group(RESTAURANT)).getByText('3 Main St, Hanover, NH 03755, USA')).toBeTruthy();
});

test('a place outside a US town is not checked: the line says why, and its box is disabled', async () => {
  const { places } = await setup();
  await search('Lou');
  await press(CANTINA);
  expect(screen.getByText(outsideUsLine('Lou’s Cantina'))).toBeTruthy();
  expect(groupNames()).toEqual([]);
  expect(box(CANTINA).props.accessibilityState).toMatchObject({ checked: false, disabled: true });
  await press(CANTINA);
  await toggleDirectly(CANTINA_SUGGESTION);
  expect(places.detailCalls).toHaveLength(1);
  // New text clears the line; the box stays disabled in the next answer.
  await search('Lou’s');
  expect(screen.queryByText(outsideUsLine('Lou’s Cantina'))).toBeNull();
  expect(box(CANTINA).props.accessibilityState).toMatchObject({ checked: false, disabled: true });
});

test('503 on a check leaves it unchecked with the page’s line; 503 on the search hands over only while nothing is checked', async () => {
  const { places, onUnavailable } = await setup();
  places.details.ChIJTestPlace0001 = refusal(503, 'places_unavailable');
  await search('Lou');
  await press(RESTAURANT);
  expect(screen.getByText(LINE)).toBeTruthy();
  expect(groupNames()).toEqual([]);
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  await press(BAKERY);
  expect(screen.queryByText(LINE)).toBeNull();
  places.results['Lou’s'] = refusal(503, 'places_unavailable');
  await search('Lou’s');
  expect(screen.getByText(LINE)).toBeTruthy();
  expect(groupNames()).toEqual([BAKERY]);
  expect(onUnavailable).not.toHaveBeenCalled();
  // An answer after the 503 takes the line away, so removing the last place then keeps the search.
  await search('Lou');
  expect(screen.queryByText(LINE)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
  await wait(0);
  expect(groupNames()).toEqual([]);
  expect(onUnavailable).not.toHaveBeenCalled();

  await cleanup();
  const fresh = await setup((p) => { p.results.Lou = refusal(503, 'places_unavailable'); });
  await search('Lou');
  expect(fresh.onUnavailable).toHaveBeenCalledTimes(1);
});

test('404 on a check says Google Maps can’t find it', async () => {
  const { places } = await setup();
  delete places.details.ChIJTestPlace0001;
  await search('Lou');
  await press(RESTAURANT);
  expect(screen.getByText(CHECKLIST_COPY.gone)).toBeTruthy();
  expect(groupNames()).toEqual([]);
  expect(box(RESTAURANT).props.accessibilityState).toMatchObject({ checked: false });
});

test('at 25 checked or loading the other boxes are disabled with “You can add up to 25 places.”; removing one enables them', async () => {
  const { places } = await setup();
  const queries = manyPlaces(places, 30);
  expect(queries).toEqual(['Many 1', 'Many 2', 'Many 3', 'Many 4', 'Many 5', 'Many 6']);
  for (let i = 1; i <= 24; i += 1) {
    if (i % 5 === 1) await search(`Many ${String(Math.ceil(i / 5))}`);
    await press(`Many Place ${String(i)}, Hanover, NH, USA`);
  }
  expect(places.detailCalls).toHaveLength(24);
  expect(groupNames()).toHaveLength(24);
  expect(screen.queryByText(CHECKLIST_COPY.limit)).toBeNull();
  places.holdingDetails = true;
  await press('Many Place 25, Hanover, NH, USA');
  expect(groupNames()).toHaveLength(25);
  await search('Many 6');
  const next = 'Many Place 26, Hanover, NH, USA';
  expect(box(next).props.accessibilityState).toMatchObject({ checked: false, disabled: true });
  await press(next);
  await toggleDirectly({ placeId: 'ChIJTestMany0026', name: 'Many Place 26', detail: 'Hanover, NH, USA', kind: 'business' });
  expect(places.detailCalls).toHaveLength(25);
  expect(screen.getByText(CHECKLIST_COPY.limit)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Remove Many Place 1, Hanover, NH, USA' }));
  await wait(0);
  expect(box(next).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  expect(screen.queryByText(CHECKLIST_COPY.limit)).toBeNull();
});

test('a place Google answers with the id of one already checked is not added twice', async () => {
  const { places } = await setup();
  places.details.ChIJTestPlace0004 = { ...HANOVER };
  await search('Lou');
  await press(RESTAURANT);
  await search('Lou Lebanon');
  await press('Lou’s Restaurant, Lebanon, NH, USA');
  expect(places.detailCalls.map((call) => call.placeId)).toEqual(['ChIJTestPlace0001', 'ChIJTestPlace0004']);
  expect(groupNames()).toEqual([RESTAURANT]);
});

test('one map above the checked places on native; none with nothing checked', async () => {
  const { places } = await setup();
  await search('Lou');
  await wait(1000);
  expect(screen.queryByLabelText(/^Map of/)).toBeNull();
  expect(places.mapCalls).toEqual([]);
  await press(RESTAURANT);
  await press(BAKERY);
  await wait(400);
  expect(places.mapCalls).toEqual([['ChIJTestPlace0001', 'ChIJTestPlace0002']]);
  const maps = screen.getAllByLabelText(/^Map of/);
  expect(maps.map((node) => String(node.props['aria-label']))).toEqual(['Map of your 2 places']);
  expect(maps[0]?.props.source).toEqual({ uri: mapOf(['ChIJTestPlace0001', 'ChIJTestPlace0002']).url });
  // In tree order the map comes before the rows, and no row holds one.
  const labeled = screen.queryAllByLabelText(/./);
  const mapAt = labeled.findIndex((node) => node.props['aria-label'] === 'Map of your 2 places');
  const firstRowAt = labeled.findIndex((node) => node.props.role === 'group');
  expect(mapAt).toBeGreaterThan(-1);
  expect(mapAt).toBeLessThan(firstRowAt);
  for (const name of [RESTAURANT, BAKERY]) expect(within(group(name)).queryByLabelText(/^Map of/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: `Remove ${RESTAURANT}` }));
  await fireEvent.press(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
  await wait(1000);
  expect(screen.queryByLabelText(/^Map of/)).toBeNull();
  expect(places.mapCalls).toHaveLength(1);
});

test('a checked place keeps its suggestion’s kind, and an address’s box says Street address', async () => {
  await setup();
  await search('Lou');
  await press(RESTAURANT);
  await search('12 South');
  const address = '12 South Main Street, Street address · Hanover, NH, USA';
  expect(within(box(address)).getByText('Street address · Hanover, NH, USA')).toBeTruthy();
  await press(address);
  expect(rendered?.places.map((place) => [place.name, place.kind])).toEqual([['Lou’s Restaurant', 'business'], ['12 South Main Street', 'address']]);
  expect(groupNames()).toEqual([RESTAURANT, address]);
});
