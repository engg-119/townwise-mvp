import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PlaceSearch } from '../../../src/portal/onboarding/PlaceSearch';
import type { UsablePlace } from '../../../src/portal/onboarding/places';
import { ACCESS, fakePortalApi, meOf } from '../../helpers/portal';
import { installPlaces, MAP_URL, type PlacesFake } from './places-fakes';

// PlaceSearch on web: an ARIA 1.2 combobox. The input owns a listbox of options named by place and town; Down and Up
// move the active option (aria-activedescendant, aria-selected), Enter picks it, Escape closes the list and then
// clears the text; a mouse press picks without taking focus from the field. The status is one polite live region
// that each answer replaces whole. Picking moves focus to the confirm card's heading.

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const LABEL = 'Search for your restaurant or bar';

function setup(): { places: PlacesFake; onConfirm: jest.Mock<undefined, [UsablePlace]> } {
  jest.useFakeTimers();
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  const places = installPlaces(api);
  const onConfirm = jest.fn<undefined, [UsablePlace]>();
  render(
    <PlaceSearch
      api={api}
      label={LABEL}
      helper="Type its name. Google Maps suggests places in the US."
      confirmLabel="Looks right"
      onConfirm={onConfirm}
      manualLabel="Can’t find it? Enter it yourself"
      onManual={() => undefined}
      onUnavailable={() => undefined}
    />,
  );
  return { places, onConfirm };
}

async function search(text: string): Promise<HTMLInputElement> {
  const box = screen.getByRole<HTMLInputElement>('combobox', { name: LABEL });
  box.focus();
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    await Promise.resolve();
  });
  return box;
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

test('a combobox that owns a listbox of options; collapsed until an answer', async () => {
  setup();
  const box = screen.getByRole<HTMLInputElement>('combobox', { name: LABEL });
  expect(box.tagName).toBe('INPUT');
  expect(box.getAttribute('aria-autocomplete')).toBe('list');
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(box.getAttribute('autocomplete')).toBe('off');
  expect(box.getAttribute('maxlength')).toBe('120');
  const listId = box.getAttribute('aria-controls') ?? '';
  expect(document.getElementById(listId)?.getAttribute('role')).toBe('listbox');
  await search('Lou');
  expect(box.getAttribute('aria-expanded')).toBe('true');
  const options = screen.getAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual([
    'Lou’s RestaurantHanover, NH, USA', 'Lou’s BakeryNorwich, VT, USA', 'Lou’s CantinaSan Juan, Puerto Rico',
  ]);
  expect(options.every((option) => option.getAttribute('aria-selected') === 'false')).toBe(true);
  expect(screen.getByRole('listbox', { name: LABEL })).toBeTruthy();
  expect(box.getAttribute('aria-activedescendant')).toBeNull();
});

test('Down and Up move the active option, Enter picks it, and focus moves to the card’s heading', async () => {
  const { places } = setup();
  const box = await search('Lou');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  const options = screen.getAllByRole('option');
  expect(box.getAttribute('aria-activedescendant')).toBe(options[2]?.id);
  expect(options[2]?.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  expect(box.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  expect(box.getAttribute('aria-activedescendant')).toBeNull();
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'Enter' });
  await settle();
  expect(places.detailCalls).toEqual([{ placeId: 'ChIJTestPlace0001', sessionToken: 'token-1' }]);
  const heading = screen.getByRole('heading', { name: 'Here’s what we found' });
  expect(document.activeElement).toBe(heading);
  expect(heading.getAttribute('tabindex')).toBe('-1');
  const [map] = screen.getAllByRole('img', { name: 'Map of the area around Lou’s Restaurant' });
  expect(map?.querySelector('img')?.getAttribute('src')).toBe(MAP_URL);
});

test('Escape closes the list, then clears the text; a mouse press picks without blurring the field', async () => {
  const { places, onConfirm } = setup();
  const box = await search('Lou');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(box.value).toBe('Lou');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box.value).toBe('');
  await search('Lou');
  const bakery = screen.getAllByRole('option')[1];
  if (bakery === undefined) throw new Error('no option');
  expect(fireEvent.mouseDown(bakery)).toBe(false);
  fireEvent.click(bakery);
  await settle();
  expect(places.detailCalls.at(-1)?.placeId).toBe('ChIJTestPlace0002');
  fireEvent.click(screen.getByRole('button', { name: 'Looks right' }));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lou’s Bakery', town: { townId: null, name: 'Norwich', state: 'VT' } }));
});

test('the status is one polite live region, replaced whole by each answer, and describes the field', async () => {
  setup();
  const box = await search('Zz');
  const status = screen.getByRole('status');
  expect(status.getAttribute('aria-live')).toBe('polite');
  expect(status.textContent).toBe('No places match “Zz”. Check the spelling, or enter it yourself.');
  expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(status.id);
  await search('Lou');
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(status.textContent).toBe('3 places match. Pick one to see what Google Maps has for it.');
});
