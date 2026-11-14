import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { PlaceChecklist } from '../../../src/portal/onboarding/PlaceChecklist';
import { usePlaceChecklist } from '../../../src/portal/onboarding/usePlaceChecklist';
import { ACCESS, fakePortalApi, meOf, refusal, type FakePortalApi } from '../../helpers/portal';
import { installPlaces, mapOf, type PlacesFake } from './places-fakes';

// The places checklist on web (usePlaceChecklist over PlaceChecklist.web): the search field is an ARIA 1.2 combobox
// whose listbox is multiselectable. Each option's aria-selected says whether the place is checked (the active option
// shows only by highlight and aria-activedescendant), with a drawn, aria-hidden box. Down and Up move the active
// option; Enter, and Space while an option is active, toggle it and leave the list open; a mouse press toggles
// without taking focus from the field; a refused or full option is aria-disabled and does nothing; Remove moves
// focus back to the field; Escape closes the list, then clears the text, and typing opens it again; focus alone never
// opens or closes it. One map of every checked place sits above the rows (none in a row), redrawn 400 ms after the
// checked set last changed; an address suggestion's line starts “Street address · ”.

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const LABEL = 'Search for your restaurant or bar';
const LINE = 'Google Maps isn’t answering right now, so you can enter your restaurant yourself.';

function Harness(p: { api: FakePortalApi }): React.JSX.Element {
  const state = usePlaceChecklist(p.api, LINE);
  return <PlaceChecklist state={state} label={LABEL} onUnavailable={() => undefined} />;
}

function setup(): { api: FakePortalApi; places: PlacesFake } {
  jest.useFakeTimers();
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  const places = installPlaces(api);
  render(<Harness api={api} />);
  return { api, places };
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
}

async function search(text: string): Promise<HTMLInputElement> {
  const box = screen.getByRole<HTMLInputElement>('combobox', { name: LABEL });
  box.focus();
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    jest.advanceTimersByTime(250);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  return box;
}

/** Lets the clock run, then the fake API's answers land. */
async function later(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

const RESTAURANT = 'Lou’s Restaurant, Hanover, NH, USA';
const BAKERY = 'Lou’s Bakery, Norwich, VT, USA';

/** The Google map images on the page, by their src. */
function mapImages(): string[] {
  return [...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '').filter((src) => src.startsWith('https://maps.googleapis.com/'));
}

/** The map, by its name: its image's src. */
function mapNamed(name: string): string | null {
  const [map] = screen.getAllByRole('img', { name });
  return map?.querySelector('img')?.getAttribute('src') ?? null;
}

function options(): HTMLElement[] {
  return screen.getAllByRole('option');
}

function option(index: number): HTMLElement {
  const found = options()[index];
  if (found === undefined) throw new Error(`no option ${String(index)}`);
  return found;
}

test('a combobox whose listbox is multiselectable; each option’s aria-selected says whether it is checked', async () => {
  setup();
  const box = await search('Lou');
  const listbox = screen.getByRole('listbox', { name: LABEL });
  expect(box.getAttribute('aria-controls')).toBe(listbox.id);
  expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
  expect(options().map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
  expect(options().every((option) => option.querySelector('[aria-hidden="true"]') !== null)).toBe(true);
  fireEvent.click(option(0));
  await settle();
  expect(options().map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  expect(box.getAttribute('aria-expanded')).toBe('true');
});

test('Down and Up move the active option; Enter and Space toggle it, and the list stays open', async () => {
  const { places } = setup();
  const box = await search('Lou');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
  expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false);
  await settle();
  expect(places.detailCalls).toHaveLength(1);
  expect(box.getAttribute('aria-expanded')).toBe('true');
  expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
  expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
  expect(fireEvent.keyDown(box, { key: ' ' })).toBe(false);
  await settle();
  expect(options()[0]?.getAttribute('aria-selected')).toBe('false');
  expect(places.detailCalls).toHaveLength(1);
});

test('with no active option Space types, and typing clears the active option', async () => {
  setup();
  const box = await search('Lou');
  expect(fireEvent.keyDown(box, { key: ' ' })).toBe(true);
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box.getAttribute('aria-activedescendant')).not.toBeNull();
  fireEvent.change(box, { target: { value: 'Lou ' } });
  expect(box.getAttribute('aria-activedescendant')).toBeNull();
});

test('a mouse press toggles without blurring the field', async () => {
  setup();
  const box = await search('Lou');
  const first = option(0);
  expect(fireEvent.mouseDown(first)).toBe(false);
  fireEvent.click(first);
  await settle();
  expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(box);
});

test('a refused or full option is aria-disabled and does nothing', async () => {
  const { places } = setup();
  const box = await search('Lou');
  fireEvent.click(option(2));
  await settle();
  expect(places.detailCalls).toHaveLength(1);
  expect(options()[2]?.getAttribute('aria-disabled')).toBe('true');
  expect(options()[0]?.getAttribute('aria-disabled')).toBeNull();
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(box.getAttribute('aria-activedescendant')).toBe(options()[2]?.id);
  fireEvent.keyDown(box, { key: 'Enter' });
  await settle();
  expect(places.detailCalls).toHaveLength(1);
});

test('Remove moves focus back to the search field', async () => {
  setup();
  const box = await search('Lou');
  fireEvent.click(option(0));
  await settle();
  const remove = screen.getByRole('button', { name: 'Remove Lou’s Restaurant, Hanover, NH, USA' });
  remove.focus();
  expect(document.activeElement).toBe(remove);
  fireEvent.click(remove);
  await settle();
  expect(screen.queryByRole('button', { name: 'Remove Lou’s Restaurant, Hanover, NH, USA' })).toBeNull();
  expect(document.activeElement).toBe(box);
});

test('Escape closes the list, then clears the text', async () => {
  setup();
  const box = await search('Lou');
  expect(box.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(box.value).toBe('Lou');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box.value).toBe('');
});

test('focus never opens or closes the list, so a press below it lands where it started', async () => {
  setup();
  const box = await search('Lou');
  const listbox = (): HTMLElement | null => document.getElementById(box.getAttribute('aria-controls') ?? '');
  fireEvent.click(option(0));
  await settle();
  fireEvent.blur(box);
  expect(listbox()?.hidden).toBe(false);
  expect(box.getAttribute('aria-expanded')).toBe('true');
  const remove = screen.getByRole('button', { name: 'Remove Lou’s Restaurant, Hanover, NH, USA' });
  remove.focus();
  expect(listbox()?.hidden).toBe(false);
  fireEvent.click(remove);
  await settle();
  expect(document.activeElement).toBe(box);
  expect(listbox()?.hidden).toBe(false);
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(listbox()?.hidden).toBe(true);
  fireEvent.blur(box);
  fireEvent.focus(box);
  expect(listbox()?.hidden).toBe(true);
});

test('typing after Escape opens the list again, before the next answer', async () => {
  setup();
  const box = await search('Lou');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box.getAttribute('aria-expanded')).toBe('false');
  fireEvent.change(box, { target: { value: 'Lou’' } });
  expect(box.getAttribute('aria-expanded')).toBe('true');
});

test('one map above the checked places with a pin for each, and no map in any row', async () => {
  const { places } = setup();
  await search('Lou');
  expect(mapImages()).toEqual([]);
  fireEvent.click(option(0));
  await settle();
  fireEvent.click(option(1));
  await settle();
  await later(400);
  expect(places.mapCalls).toEqual([['ChIJTestPlace0001', 'ChIJTestPlace0002']]);
  // The details answer's own map (the confirm card's) is not drawn: the one map is.
  expect(mapImages()).toEqual([mapOf(['ChIJTestPlace0001', 'ChIJTestPlace0002']).url]);
  expect(mapNamed('Map of your 2 places')).toBe(mapOf(['ChIJTestPlace0001', 'ChIJTestPlace0002']).url);
  const rows = [screen.getByRole('group', { name: RESTAURANT }), screen.getByRole('group', { name: BAKERY })];
  for (const row of rows) expect(within(row).queryByRole('img')).toBeNull();
  const [map] = screen.getAllByRole('img', { name: 'Map of your 2 places' });
  for (const row of rows) expect((map?.compareDocumentPosition(row) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // It sits under the field, so it never moves the field or its list.
  const box = screen.getByRole('combobox', { name: LABEL });
  expect((map?.compareDocumentPosition(box) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(document.activeElement).toBe(box);

  fireEvent.click(screen.getByRole('button', { name: `Remove ${RESTAURANT}` }));
  await later(400);
  expect(mapNamed('Map of Lou’s Bakery')).toBe(mapOf(['ChIJTestPlace0002']).url);
});

test('the map redraws after a place is checked or removed, not while one is loading', async () => {
  const { places } = setup();
  await search('Lou');
  fireEvent.click(option(0));
  await settle();
  await later(399);
  expect(places.mapCalls).toEqual([]);
  await later(1);
  expect(places.mapCalls).toEqual([['ChIJTestPlace0001']]);
  expect(mapNamed('Map of Lou’s Restaurant')).toBe(mapOf(['ChIJTestPlace0001']).url);

  // A loading row is not on the map: the map stays as it was.
  places.holdingDetails = true;
  fireEvent.click(option(1));
  await later(1000);
  expect(places.mapCalls).toEqual([['ChIJTestPlace0001']]);
  expect(mapNamed('Map of Lou’s Restaurant')).toBe(mapOf(['ChIJTestPlace0001']).url);
  places.holdingDetails = false;
  await act(async () => {
    for (const release of places.heldDetails.splice(0)) release();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  // Checked: the old map stays until the new one answers.
  expect(mapImages()).toEqual([mapOf(['ChIJTestPlace0001']).url]);
  await later(400);
  expect(places.mapCalls).toEqual([['ChIJTestPlace0001'], ['ChIJTestPlace0001', 'ChIJTestPlace0002']]);
  expect(mapImages()).toEqual([mapOf(['ChIJTestPlace0001', 'ChIJTestPlace0002']).url]);

  // Removed: back to a set asked before, from memory; then nothing checked, no map.
  fireEvent.click(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
  await settle();
  expect(mapImages()).toEqual([mapOf(['ChIJTestPlace0001']).url]);
  fireEvent.click(screen.getByRole('button', { name: `Remove ${RESTAURANT}` }));
  await later(1000);
  expect(mapImages()).toEqual([]);
  expect(places.mapCalls).toHaveLength(2);
});

test('with the map off, or its call refused, there is no map and no error line', async () => {
  const { api, places } = setup();
  places.mapOn = false;
  await search('Lou');
  fireEvent.click(option(0));
  await settle();
  await later(400);
  expect(places.mapCalls).toHaveLength(1);
  expect(mapImages()).toEqual([]);
  api.answers['/api/places/map'] = () => refusal(429, 'rate_limited', 60);
  fireEvent.click(option(1));
  await settle();
  await later(400);
  expect(screen.getByRole('group', { name: BAKERY })).toBeTruthy();
  expect(mapImages()).toEqual([]);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an address suggestion’s line starts with Street address, and its option is named by it', async () => {
  const { places } = setup();
  await search('Lou');
  expect(option(0).getAttribute('aria-label')).toBe(RESTAURANT);
  expect(within(option(0)).getByText('Hanover, NH, USA')).toBeTruthy();
  await search('12 South');
  const named = '12 South Main Street, Street address · Hanover, NH, USA';
  expect(screen.getByRole('option', { name: named })).toBe(option(0));
  expect(within(option(0)).getByText('Street address · Hanover, NH, USA')).toBeTruthy();
  fireEvent.click(option(0));
  await settle();
  expect(places.detailCalls.map((call) => call.placeId)).toEqual(['ChIJTestPlace0006']);
  // Its row and Remove are named as its option is.
  expect(within(screen.getByRole('group', { name: named })).getByText('12 S Main St, Hanover, NH 03755, USA')).toBeTruthy();
  expect(screen.getByRole('button', { name: `Remove ${named}` })).toBeTruthy();
});
