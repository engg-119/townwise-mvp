import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { Pressable, Text, type View } from 'react-native';

import { Button } from '../../../src/portal/ui/Button';
import { placePopover, Popover, type PopoverRect } from '../../../src/portal/ui/Popover';

// The shared popover on web (calendar-views' "Popovers float over the page, anchored to their button"): a dialog card
// in react-native-web's Modal, placed from its opener at 641px and wider and pinned to the top below that, which takes
// focus on open, keeps it inside the card, closes on Escape (and on a press outside where allowed) and gives focus back
// to its opener. jsdom does no layout, so placement is checked through placePopover and the card's own style.

let width = 1280;
let height = 900;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });
Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => height });

function setWindow(nextWidth: number, nextHeight: number): void {
  width = nextWidth;
  height = nextHeight;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  if (width !== 1280 || height !== 900) setWindow(1280, 900);
});

describe('placePopover', () => {
  const desktop = { width: 1280, height: 900, top: 0, bottom: 900 };

  test('at 1280 by 900 a button at the header row’s right edge opens it 8px under the button, right edges level', () => {
    // "Your calendars" ends at 1200, the row's right edge inside an 80px margin.
    const button: PopoverRect = { x: 1040, y: 200, width: 160, height: 44 };
    expect(placePopover(button, desktop, 440)).toEqual({ width: 440, left: 760, top: 252, maxHeight: 900 - 244 - 24 });
  });

  test('a button 200px from the window’s bottom and 600px from its top opens it above, at most 576px tall', () => {
    const button: PopoverRect = { x: 900, y: 600, width: 160, height: 44 };
    const window = { width: 1280, height: 844, top: 0, bottom: 844 };
    expect(placePopover(button, window, 440)).toEqual({ width: 440, left: 1060 - 440, bottom: 844 - 600 + 8, maxHeight: 576 });
  });

  test('320px of room below is always enough, even with more above', () => {
    const button: PopoverRect = { x: 900, y: 500, width: 160, height: 44 };
    const placed = placePopover(button, { width: 1280, height: 864, top: 0, bottom: 864 }, 440);
    expect(placed).toMatchObject({ top: 552, maxHeight: 296 });
  });

  test('a button in the window’s left half lines up their left edges', () => {
    const button: PopoverRect = { x: 320, y: 400, width: 120, height: 44 };
    expect(placePopover(button, desktop, 400)).toEqual({ width: 400, left: 320, top: 452, maxHeight: 900 - 444 - 24 });
  });

  test('it stays 16px from either window edge', () => {
    expect(placePopover({ x: 4, y: 100, width: 120, height: 44 }, desktop, 440)).toMatchObject({ left: 16 });
    expect(placePopover({ x: 1200, y: 100, width: 76, height: 44 }, desktop, 440)).toMatchObject({ left: 1280 - 16 - 440 });
    // At 700px wide a 440px card would not leave both margins: it is the window less 32px at most.
    expect(placePopover({ x: 600, y: 100, width: 80, height: 44 }, { width: 700, height: 900, top: 0, bottom: 900 }, 800)).toMatchObject({ width: 668, left: 16 });
  });

  test('at 375 it is 343px wide, pinned 16px from the top and either side, whichever button opened it', () => {
    const phone = { width: 375, height: 667, top: 0, bottom: 667 };
    for (const button of [{ x: 200, y: 40, width: 140, height: 44 }, { x: 16, y: 600, width: 120, height: 44 }, null]) {
      expect(placePopover(button, phone, 440)).toEqual({ width: 343, left: 16, top: 16, maxHeight: 635 });
    }
  });

  test('at 375 by 667 with a 300px keyboard it is at most 335px tall, ending above the keyboard', () => {
    const placed = placePopover({ x: 16, y: 500, width: 120, height: 44 }, { width: 375, height: 667, top: 0, bottom: 367 }, 400);
    expect(placed).toEqual({ width: 343, left: 16, top: 16, maxHeight: 335 });
    expect(16 + placed.maxHeight).toBeLessThanOrEqual(367 - 16);
  });

  test('below a safe area’s top inset it keeps 16px from the inset', () => {
    expect(placePopover(null, { width: 390, height: 844, top: 47, bottom: 810 }, 440)).toEqual({ width: 358, left: 16, top: 63, maxHeight: 810 - 47 - 32 });
  });
});

type Host = React.ComponentRef<typeof View>;

interface HarnessProps {
  dismissOnOutsidePress?: boolean;
  busy?: boolean;
  onClose?: () => void;
  onDismiss?: () => void;
}

/** An opener, the popover it opens (with one control), and a control outside it. */
function Harness(props: HarnessProps): React.JSX.Element {
  const anchor = useRef<Host>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable ref={anchor} role="button" accessibilityLabel="Open" onPress={() => { setOpen(true); }}>
        <Text>Open</Text>
      </Pressable>
      <Pressable role="button" accessibilityLabel="Elsewhere" onPress={() => undefined}><Text>Elsewhere</Text></Pressable>
      <Popover
        visible={open}
        anchor={anchor}
        label="Your calendars"
        nativeID="p1"
        maxWidth={440}
        closeButton
        dismissOnOutsidePress={props.dismissOnOutsidePress ?? true}
        busy={props.busy === true}
        onClose={() => { props.onClose?.(); setOpen(false); }}
        {...(props.onDismiss === undefined ? {} : { onDismiss: props.onDismiss })}
      >
        <Button variant="outline" label="Add a link" onPress={() => undefined} />
      </Popover>
    </>
  );
}

/** Focuses the opener, as a press or Tab would, and presses it. */
function open(): HTMLElement {
  const opener = screen.getByRole('button', { name: 'Open' });
  act(() => { opener.focus(); });
  fireEvent.click(opener);
  return opener;
}

function escape(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); });
}

/** The backdrop: the card's sibling after it, filling the window under it. */
function backdrop(): HTMLElement {
  const found = screen.getByRole('dialog', { name: 'Your calendars' }).nextElementSibling;
  if (!(found instanceof HTMLElement)) throw new Error('no backdrop');
  return found;
}

function pressOutside(): void {
  const outside = backdrop();
  fireEvent.mouseDown(outside);
  fireEvent.mouseUp(outside);
}

test('closed, nothing is in the document; open, a dialog named by its heading, with its id', () => {
  render(<Harness />);
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  open();
  const card = screen.getByRole('dialog', { name: 'Your calendars' });
  expect(card.id).toBe('p1');
  expect(card.getAttribute('aria-modal')).toBe('true');
  expect(within(card).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Your calendars']);
  expect(within(card).getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Add a link' })).toBeTruthy();
});

test('on open focus is on the card’s first control, and the backdrop is aria-hidden with no tabindex, so Tab never reaches it', () => {
  render(<Harness />);
  open();
  const card = screen.getByRole('dialog', { name: 'Your calendars' });
  expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Close' }));
  const outside = backdrop();
  expect(outside.getAttribute('aria-hidden')).toBe('true');
  expect(outside.hasAttribute('tabindex')).toBe(false);
  expect(outside.querySelectorAll('*')).toHaveLength(0);
  expect(window.getComputedStyle(outside).position).toBe('absolute');
  // Focus that leaves the card for the page (as Tab past its last control would) is brought back into it.
  act(() => { screen.getByRole('button', { name: 'Elsewhere' }).focus(); });
  expect(card.contains(document.activeElement)).toBe(true);
});

test('Escape closes it, focus goes back to the opener, and onDismiss runs once it has gone', () => {
  const onClose = jest.fn();
  const onDismiss = jest.fn();
  render(<Harness onClose={onClose} onDismiss={onDismiss} />);
  const opener = open();
  escape();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('Close closes it and gives focus back to the opener', () => {
  render(<Harness />);
  const opener = open();
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Your calendars' })).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test('a press outside closes it only when the popover allows one', () => {
  const onClose = jest.fn();
  render(<Harness onClose={onClose} dismissOnOutsidePress={false} />);
  open();
  pressOutside();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Your calendars' })).toBeTruthy();
  cleanup();

  render(<Harness onClose={onClose} />);
  open();
  pressOutside();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
});

test('while busy, Close is disabled in place, and Escape and a press outside do nothing', () => {
  const onClose = jest.fn();
  render(<Harness onClose={onClose} busy />);
  open();
  const close = within(screen.getByRole('dialog', { name: 'Your calendars' })).getByRole('button', { name: 'Close' });
  expect(close.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(close);
  escape();
  pressOutside();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Your calendars' })).toBeTruthy();
});

test('at 1280 by 900 the card is placed from its opener’s measureInWindow, and hidden until then', () => {
  render(<Harness />);
  const opener = screen.getByRole<HTMLElement & { measureInWindow: (callback: (...box: number[]) => void) => void }>('button', { name: 'Open' });
  let answer: ((...box: number[]) => void) | null = null;
  opener.measureInWindow = (callback) => { answer = callback; };
  open();
  const card = screen.getByRole('dialog', { name: 'Your calendars' });
  expect(window.getComputedStyle(card).opacity).toBe('0');
  act(() => { answer?.(1040, 200, 160, 44); });
  const style = window.getComputedStyle(card);
  expect([style.opacity, style.position, style.top, style.left, style.width, style.maxHeight]).toEqual(['', 'absolute', '252px', '760px', '440px', '632px']);
});

test('at 375 the card is pinned 16px from the top and either side without measuring its opener', () => {
  setWindow(375, 667);
  render(<Harness />);
  const opener = screen.getByRole<HTMLElement & { measureInWindow: () => void }>('button', { name: 'Open' });
  const measured = jest.fn();
  opener.measureInWindow = measured;
  open();
  const style = window.getComputedStyle(screen.getByRole('dialog', { name: 'Your calendars' }));
  expect([style.opacity, style.top, style.left, style.width, style.maxHeight]).toEqual(['', '16px', '16px', '343px', '635px']);
  expect(measured).not.toHaveBeenCalled();
});
