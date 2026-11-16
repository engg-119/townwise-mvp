import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions, Keyboard, StyleSheet, Text, type KeyboardEvent, type MeasureInWindowOnSuccessCallback } from 'react-native';

import { Popover, type PopoverAnchor } from '../../../src/portal/ui/Popover';

// The shared popover on native (calendar-views' "Popovers float over the page, anchored to their button"): the card in
// a Modal, closed by Android's back button, placed from its opener's measureInWindow from 641px wide and pinned to the
// top below that, its height stopping at the keyboard's top, and a backdrop no screen reader reaches.

function windowOf(width: number, height: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height, scale: 2, fontScale: 1 });
}

afterEach(() => {
  jest.restoreAllMocks();
});

/** An opener that answers measureInWindow with `box`. */
function anchorAt(...box: [number, number, number, number]): PopoverAnchor & { measured: jest.Mock } {
  const measured = jest.fn((callback: MeasureInWindowOnSuccessCallback) => { callback(...box); });
  return { current: { measureInWindow: measured }, measured };
}

async function renderPopover(anchor: PopoverAnchor, overrides: { onClose?: () => void; busy?: boolean } = {}): Promise<void> {
  await render(
    <Popover
      visible
      anchor={anchor}
      label="Add an event"
      maxWidth={400}
      dismissOnOutsidePress={false}
      busy={overrides.busy === true}
      onClose={overrides.onClose ?? (() => undefined)}
    >
      <Text>Kind</Text>
    </Popover>,
  );
}

/** The host Modal around the card, where Android's back button lands (onRequestClose). */
function modal(): Parameters<typeof fireEvent>[0] {
  let node = screen.getByText('Kind');
  while (node.type !== 'Modal' && node.parent !== null) node = node.parent;
  if (node.type !== 'Modal') throw new Error('no Modal');
  return node;
}

/** The card: the view the dialog's label names. */
function cardStyle(): Record<string, unknown> {
  return StyleSheet.flatten(screen.getByLabelText('Add an event').props.style as Parameters<typeof StyleSheet.flatten>[0]) as Record<string, unknown>;
}

test('it renders in a Modal, transparent and unanimated, headed by its label', async () => {
  windowOf(375, 667);
  await renderPopover(anchorAt(16, 500, 120, 44));
  const { props } = modal();
  expect([props.visible, props.transparent, props.animationType]).toEqual([true, true, 'none']);
  expect(screen.getByRole('heading', { name: 'Add an event' })).toBeTruthy();
  expect(screen.getByLabelText('Add an event').props.role).toBe('dialog');
  expect(screen.getByText('Kind')).toBeTruthy();
});

test('the back button (onRequestClose) closes it, except while busy', async () => {
  windowOf(375, 667);
  const onClose = jest.fn();
  await renderPopover(anchorAt(16, 500, 120, 44), { onClose, busy: true });
  await fireEvent(modal(), 'requestClose');
  expect(onClose).not.toHaveBeenCalled();
  await screen.rerender(
    <Popover visible anchor={anchorAt(16, 500, 120, 44)} label="Add an event" maxWidth={400} dismissOnOutsidePress={false} onClose={onClose}>
      <Text>Kind</Text>
    </Popover>,
  );
  await fireEvent(modal(), 'requestClose');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('from 641px its card is placed from the opener’s measureInWindow: 8px under it, left edges level', async () => {
  windowOf(1024, 768);
  const anchor = anchorAt(300, 200, 140, 44);
  await renderPopover(anchor);
  expect(anchor.measured).toHaveBeenCalled();
  expect(cardStyle()).toMatchObject({ position: 'absolute', width: 400, left: 300, top: 252, maxHeight: 768 - 244 - 24 });
  expect(cardStyle().opacity).toBeUndefined();
});

test('at 375 by 667 it is pinned at the top, and a 300px keyboard caps its height above the keyboard', async () => {
  windowOf(375, 667);
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  const addListener = Keyboard.addListener.bind(Keyboard);
  jest.spyOn(Keyboard, 'addListener').mockImplementation((type, listener) => {
    listeners.set(type, listener);
    return addListener(type, listener);
  });
  const anchor = anchorAt(16, 500, 120, 44);
  await renderPopover(anchor);
  expect(anchor.measured).not.toHaveBeenCalled();
  expect(cardStyle()).toMatchObject({ width: 343, left: 16, top: 16, maxHeight: 635 });
  const keyboard = { screenX: 0, screenY: 367, width: 375, height: 300 };
  const event: KeyboardEvent = { endCoordinates: keyboard, startCoordinates: keyboard, isEventFromThisApp: true, duration: 0, easing: 'keyboard' };
  await act(() => { listeners.get('keyboardDidShow')?.(event); });
  expect(cardStyle()).toMatchObject({ top: 16, maxHeight: 335 });
  await act(() => { listeners.get('keyboardDidHide')?.(event); });
  expect(cardStyle()).toMatchObject({ maxHeight: 635 });
});

test('the backdrop is no screen reader stop: not accessible, its subtree hidden', async () => {
  windowOf(375, 667);
  await renderPopover(anchorAt(16, 500, 120, 44));
  const card = screen.getByLabelText('Add an event');
  const siblings = card.parent?.children ?? [];
  const backdrop = siblings[siblings.indexOf(card) + 1];
  if (backdrop === undefined || typeof backdrop === 'string') throw new Error('no backdrop');
  expect(backdrop.props).toMatchObject({ accessible: false, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true });
  expect(backdrop.children).toHaveLength(0);
});
