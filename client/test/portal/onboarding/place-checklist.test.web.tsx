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

function chips(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Chosen places' });
  return list === null ? [] : within(list).getAllByRole('button');
}

function chip(index: number): HTMLElement {
  const found = chips()[index];
  if (found === undefined) throw new Error(`no chip ${String(index)}`);
  return found;
}

test('each checked place is a chip in the field, in check order and out of the tab order, and typing searches for more (D57)', async () => {
  setup();
  const box = await search('Lou');
  expect(chips()).toEqual([]);
  fireEvent.click(option(0));
  await settle();
  fireEvent.click(option(1));
  await settle();
  expect(chips().map((button) => button.getAttribute('aria-label'))).toEqual([RESTAURANT, BAKERY]);
  for (const button of chips()) expect(button.getAttribute('tabindex')).toBe('-1');
  // The chips sit before the text in the same box, and the text is still the combobox.
  expect(chip(1).compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.activeElement).toBe(box);
  // Searching again keeps them, and its answer can add another.
  await search('Lou Lebanon');
  expect(chips()).toHaveLength(2);
  fireEvent.click(option(0));
  await settle();
  expect(chips()).toHaveLength(3);
  // Unchecking in the list takes its chip away.
  fireEvent.click(option(0));
  await settle();
  expect(chips()).toHaveLength(2);
});

test('Left or Backspace at the start of the text moves to the last chip; Left and Right move between chips and back to the text', async () => {
  setup();
  const box = await search('Lou');
  fireEvent.click(option(0));
  await settle();
  fireEvent.click(option(1));
  await settle();
  // With the caret after text, Left and Backspace are the text's own.
  box.setSelectionRange(3, 3);
  expect(fireEvent.keyDown(box, { key: 'ArrowLeft' })).toBe(true);
  expect(fireEvent.keyDown(box, { key: 'Backspace' })).toBe(true);
  expect(document.activeElement).toBe(box);
  box.setSelectionRange(0, 0);
  expect(fireEvent.keyDown(box, { key: 'ArrowLeft' })).toBe(false);
  expect(document.activeElement).toBe(chip(1));
  fireEvent.keyDown(chip(1), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(chip(0));
  // The first chip is the end of the line.
  fireEvent.keyDown(chip(0), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(chip(0));
  fireEvent.keyDown(chip(0), { key: 'ArrowRight' });
  fireEvent.keyDown(chip(1), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(box);
  // Backspace at the start goes to the last chip too, and removes nothing yet.
  fireEvent.keyDown(box, { key: 'Backspace' });
  expect(document.activeElement).toBe(chip(1));
  expect(chips()).toHaveLength(2);
  // A typed character goes back to the end of the text.
  fireEvent.keyDown(chip(1), { key: 'p' });
  expect(document.activeElement).toBe(box);
  expect([box.selectionStart, box.selectionEnd]).toEqual([3, 3]);
});

test('a key held down never crosses from the text to the chips or removes one, so holding Backspace stops at the start of the text', async () => {
  setup();
  const box = await search('Lou');
  fireEvent.click(option(0));
  await settle();
  fireEvent.click(option(1));
  await settle();
  box.setSelectionRange(0, 0);
  expect(fireEvent.keyDown(box, { key: 'Backspace', repeat: true })).toBe(true);
  expect(fireEvent.keyDown(box, { key: 'ArrowLeft', repeat: true })).toBe(true);
  expect(document.activeElement).toBe(box);
  // On a chip a held Delete or Backspace removes nothing.
  fireEvent.keyDown(box, { key: 'Backspace' });
  expect(document.activeElement).toBe(chip(1));
  fireEvent.keyDown(chip(1), { key: 'Backspace', repeat: true });
  fireEvent.keyDown(chip(1), { key: 'Delete', repeat: true });
  await settle();
  expect(chips()).toHaveLength(2);
});

test('the chips are one line beside the text, so the box keeps its height and the list never moves', async () => {
  setup();
  const box = await search('Lou');
  const frame = box.parentElement;
  if (frame === null) throw new Error('no box');
  expect(frame.style.height).toBe('44px');
  fireEvent.click(option(0));
  await settle();
  fireEvent.click(option(1));
  await settle();
  expect(frame.style.height).toBe('44px');
  const list = screen.getByRole('list', { name: 'Chosen places' });
  expect(list.style.overflowX).toBe('auto');
  expect(list.style.flexWrap).toBe('');
  // The text keeps at least 160px beside them.
  expect(box.style.minWidth).toBe('160px');
});

test('a chip in focus whose place leaves by itself hands focus to the text', async () => {
  const { places } = setup();
  const box = await search('Lou');
  // The cantina is outside a US town: its details answer refuses it.
  places.holdingDetails = true;
  fireEvent.click(option(2));
  await settle();
  expect(chips()).toHaveLength(1);
  chip(0).focus();
  expect(document.activeElement).toBe(chip(0));
  places.holdingDetails = false;
  await act(async () => {
    for (const release of places.heldDetails.splice(0)) release();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  expect(chips()).toEqual([]);
  expect(document.activeElement).toBe(box);
});

test('Delete or Backspace on a chip removes its place and moves to its neighbor, then to the text; the × removes by mouse', async () => {
  setup();
  const box = await search('Lou');
  fireEvent.click(option(0));
  await settle();
  fireEvent.click(option(1));
  await settle();
  chip(0).focus();
  fireEvent.keyDown(chip(0), { key: 'Delete' });
  await settle();
  expect(chips().map((button) => button.getAttribute('aria-label'))).toEqual([BAKERY]);
  expect(screen.queryByRole('group', { name: RESTAURANT })).toBeNull();
  expect(option(0).getAttribute('aria-selected')).toBe('false');
  expect(document.activeElement).toBe(chip(0));
  fireEvent.keyDown(chip(0), { key: 'Backspace' });
  await settle();
  expect(chips()).toEqual([]);
  expect(document.activeElement).toBe(box);
  // By mouse: the drawn ×, hidden from assistive technology, beside the chip's button.
  fireEvent.click(option(1));
  await settle();
  const cross = chip(0).nextElementSibling;
  if (cross === null) throw new Error('no ×');
  expect(cross.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(cross);
  await settle();
  expect(chips()).toEqual([]);
  expect(document.activeElement).toBe(box);
});

test('the map’s pins are lettered in check order, and each chip and row carries its letter while the map shows', async () => {
  const { places } = setup();
  await search('Lou');
  // The bakery first, so it is A.
  fireEvent.click(option(1));
  await settle();
  fireEvent.click(option(0));
  await settle();
  // No letters before the map answers.
  expect(chips().map((button) => button.textContent)).toEqual(['Lou’s Bakery', 'Lou’s Restaurant']);
  await later(400);
  // The ids go in check order, not sorted, as the letters follow them.
  expect(places.mapCalls).toEqual([['ChIJTestPlace0002', 'ChIJTestPlace0001']]);
  expect(chips().map((button) => button.textContent)).toEqual(['ALou’s Bakery', 'BLou’s Restaurant']);
  expect(within(screen.getByRole('group', { name: BAKERY })).getByText('A')).toBeTruthy();
  expect(within(screen.getByRole('group', { name: RESTAURANT })).getByText('B')).toBeTruthy();
  // After a Remove the map on screen is still the old set's until the new one answers: no letters beside it meanwhile.
  fireEvent.click(screen.getByRole('button', { name: `Remove ${BAKERY}` }));
  await settle();
  expect(mapImages()).toEqual([mapOf(['ChIJTestPlace0002', 'ChIJTestPlace0001']).url]);
  expect(chips().map((button) => button.textContent)).toEqual(['Lou’s Restaurant']);
  expect(within(screen.getByRole('group', { name: RESTAURANT })).queryByText('B')).toBeNull();
  await later(400);
  expect(chips().map((button) => button.textContent)).toEqual(['ALou’s Restaurant']);
  expect(within(screen.getByRole('group', { name: RESTAURANT })).getByText('A')).toBeTruthy();
});
