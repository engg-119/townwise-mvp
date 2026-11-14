import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';

import { US_STATE_OPTIONS } from '../../../src/portal/towns';
import { Select } from '../../../src/portal/ui/Select';
import type { SelectProps } from '../../../src/portal/ui/selectTypes';
import { choicesOf, choose, groupsOf, listOf, shownChoice } from '../../helpers/select';

// The select on web (spec 15.7): an ARIA select-only combobox whose list is drawn in the app's style on the page's
// body, never the operating system's. It keeps focus while the list is open and points at the highlighted choice.

afterEach(() => {
  cleanup();
});

const ITEMS: SelectProps['items'] = [
  { label: 'College towns', options: [{ value: 'hanover-nh', label: 'Hanover, NH' }, { value: 'ithaca-ny', label: 'Ithaca, NY' }] },
  { label: 'Seasonal and event towns', options: [{ value: 'stowe-vt', label: 'Stowe, VT' }] },
  { value: 'another', label: 'Another town' },
];

function Harness(props: Partial<SelectProps> & { onPick?: (value: string) => void }): React.JSX.Element {
  const [value, setValue] = useState(props.value ?? '');
  return (
    <Select
      label="Town"
      placeholder="Choose a town"
      items={props.items ?? ITEMS}
      {...(props.readOnly === undefined ? {} : { readOnly: props.readOnly })}
      {...(props.autoFocus === undefined ? {} : { autoFocus: props.autoFocus })}
      value={value}
      onChange={(next) => { setValue(next); props.onPick?.(next); }}
    />
  );
}

function town(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Town' });
}

/** A key pressed at a given time, since typed letters join one search only within 600ms of each other. */
function press(box: HTMLElement, key: string, at: number): void {
  const event = createEvent.keyDown(box, { key });
  Object.defineProperty(event, 'timeStamp', { value: at });
  fireEvent(box, event);
}

test('a combobox named by its label that shows the placeholder, then the choice, and opens a styled list', () => {
  const onPick = jest.fn();
  render(<Harness onPick={onPick} />);
  const box = town();
  expect(box.tagName).toBe('DIV');
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(shownChoice(box)).toBe('Choose a town');
  expect(document.querySelector('select')).toBeNull();
  expect(choicesOf(box)).toEqual(['Choose a town', 'Hanover, NH', 'Ithaca, NY', 'Stowe, VT', 'Another town']);
  expect(groupsOf(box)).toEqual(['College towns', 'Seasonal and event towns']);
  choose(box, 'Stowe, VT');
  expect(onPick).toHaveBeenCalledWith('stowe-vt');
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(box.getAttribute('aria-controls')).toBeNull();
  expect(shownChoice(box)).toBe('Stowe, VT');
  // The list is drawn on the page's body, outside the field, so no field's stacking context covers it.
  fireEvent.click(box);
  expect(listOf(box).parentElement).toBe(document.body);
});

test('picking the current choice again changes nothing', () => {
  const onPick = jest.fn();
  render(<Harness value="ithaca-ny" onPick={onPick} />);
  choose(town(), 'Ithaca, NY');
  expect(onPick).not.toHaveBeenCalled();
});

test('the keyboard opens at the current choice, moves, picks with Enter, and Escape closes unchanged', () => {
  const onPick = jest.fn();
  render(<Harness value="ithaca-ny" onPick={onPick} />);
  const box = town();
  act(() => { box.focus(); });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  const highlighted = (): string | null | undefined => document.getElementById(box.getAttribute('aria-activedescendant') ?? '')?.textContent;
  expect(highlighted()).toBe('Ithaca, NY');
  expect(within(listOf(box)).getByRole('option', { name: 'Ithaca, NY' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(highlighted()).toBe('Stowe, VT');
  fireEvent.keyDown(box, { key: 'End' });
  expect(highlighted()).toBe('Another town');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(highlighted()).toBe('Another town');
  fireEvent.keyDown(box, { key: 'Home' });
  expect(highlighted()).toBe('Choose a town');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Enter' });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onPick).toHaveBeenCalledWith('hanover-nh');
  expect(document.activeElement).toBe(box);
});

test('Escape on an open list stops there, so a dialog around the select stays open', () => {
  const keys: string[] = [];
  render(<div onKeyDown={(event) => { keys.push(event.key); }}><Harness /></div>);
  const box = town();
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(keys).toEqual(['ArrowDown']);
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(keys).toEqual(['ArrowDown', 'Escape']);
});

test('typing jumps to a choice by its label, or by its value when typed whole (nh), and a repeated letter steps on', () => {
  const onPick = jest.fn();
  render(<Harness items={US_STATE_OPTIONS} onPick={onPick} />);
  const box = town();
  act(() => { box.focus(); });
  ['v', 'e', 'r', 'm'].forEach((key, at) => { press(box, key, 1000 + at * 10); });
  press(box, 'Enter', 1050);
  expect(onPick).toHaveBeenLastCalledWith('VT');
  // Picking ends the search, so letters typed straight after start a new one.
  press(box, 'n', 1100);
  press(box, 'h', 1110);
  press(box, 'Enter', 1120);
  expect(onPick).toHaveBeenLastCalledWith('NH');
  press(box, 'n', 5000);
  press(box, 'n', 5010);
  // From New Hampshire, n steps to New Jersey and n again to New Mexico; Space after the pause picks.
  press(box, ' ', 5700);
  expect(onPick).toHaveBeenLastCalledWith('NM');
});

test('leaving the select closes its list', () => {
  render(<><Harness /><button type="button">Next</button></>);
  const box = town();
  fireEvent.click(box);
  expect(box.getAttribute('aria-expanded')).toBe('true');
  fireEvent.blur(box);
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('read-only (view-as): focusable with aria-disabled, and neither the mouse nor the keyboard opens it', () => {
  const onPick = jest.fn();
  render(<Harness value="stowe-vt" readOnly onPick={onPick} />);
  const box = town();
  expect(box.getAttribute('aria-disabled')).toBe('true');
  expect(box.getAttribute('tabindex')).toBe('0');
  fireEvent.click(box);
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'h' });
  expect(box.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onPick).not.toHaveBeenCalled();
});

test('autoFocus focuses the control when it appears, and only then (P3’s “Can’t find it?” to Town)', () => {
  render(<Harness autoFocus />);
  expect(document.activeElement).toBe(town());
  cleanup();
  render(<Harness />);
  expect(document.activeElement).not.toBe(town());
});
