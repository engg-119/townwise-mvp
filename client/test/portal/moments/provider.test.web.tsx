import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pressable, Text, View } from 'react-native';

import {
  MomentProvider, requestReceivedStatement, useMoment, welcomeStatement, type Statement,
} from '../../../src/portal/moments';

// The moment player on web (spec 15.8), driven by useMoment().play(): the live region, aria-hidden visuals, keyboard
// and pointer dismissal, the hidden-tab wait and reduced motion. Which moment plays when is pinned with the
// PortalGate wiring; the wordmark's match with the top bar is pinned in provider.test.native.tsx, where the styles
// themselves can be read.

const RECEIVED = requestReceivedStatement('Hanover Inn');
const WELCOME = welcomeStatement({ firstName: 'Sam', restaurant: 'Hanover Inn' });
const SPOKEN = 'We’ve received your request for Hanover Inn. We’ll let you in soon.';
const QUERY = '(prefers-reduced-motion: reduce)';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

function prefersReducedMotion(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query, matches: query === QUERY, addEventListener: () => undefined, removeEventListener: () => undefined,
    }),
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  visibility = 'visible';
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  Reflect.deleteProperty(window, 'matchMedia');
  jest.restoreAllMocks();
});

const pagePress = jest.fn();

function Page(props: { statement: Statement }): React.JSX.Element {
  const { playing, play } = useMoment();
  return (
    <View>
      <Text>{playing ? 'Playing' : 'Idle'}</Text>
      <Pressable role="button" onPress={() => { play(props.statement); }}><Text>Play</Text></Pressable>
      <Pressable role="button" onPress={pagePress}><Text>Withdraw</Text></Pressable>
    </View>
  );
}

function show(statement: Statement): void {
  render(<MomentProvider><Page statement={statement} /></MomentProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
}

function layer(): HTMLElement | null {
  return screen.queryByTestId('statement-layer');
}

function shownLayer(): HTMLElement {
  return screen.getByTestId('statement-layer');
}

function region(): HTMLElement {
  return screen.getByRole('status');
}

function advance(ms: number): void {
  act(() => { jest.advanceTimersByTime(ms); });
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { document.activeElement?.dispatchEvent(event); });
  return event;
}

test('the polite status region exists before the moment and receives the full statement once', () => {
  render(<MomentProvider><Page statement={RECEIVED} /></MomentProvider>);
  expect(region().getAttribute('aria-live')).toBe('polite');
  expect(region().textContent).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(region().textContent).toBe(SPOKEN);
  // Set once: the same text node stays through the whole moment, so it is never announced again.
  const said = region().firstChild;
  for (const step of [500, 1000, 1500]) {
    advance(step);
    expect(region().firstChild).toBe(said);
  }
  advance(280);
  expect(layer()).toBeNull();
  // Cleared at the end; removals are not announced.
  expect(region().textContent).toBe('');
});

test('the layer and its words are aria-hidden', () => {
  show(RECEIVED);
  const root = layer();
  expect(root?.getAttribute('aria-hidden')).toBe('true');
  for (const word of ['We’ve', 'Hanover', 'Inn.', 'soon.']) expect(root?.contains(screen.getByText(word))).toBe(true);
  expect(root?.querySelector('[tabindex], a, button, input')).toBeNull();
  // The status region is outside the hidden layer.
  expect(root?.contains(region())).toBe(false);
});

test('a keydown removes the layer at once and Tab still moves focus on the page', () => {
  show(RECEIVED);
  const withdraw = screen.getByRole('button', { name: 'Withdraw' });
  act(() => { withdraw.focus(); });
  advance(300);
  const event = key({ key: 'Tab' });
  expect(layer()).toBeNull();
  // The listener is passive: the key keeps its default action, and focus stays where the page put it.
  expect(event.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(withdraw);
  expect(screen.getByText('Idle')).toBeTruthy();
});

test('input in the first 300ms is ignored, so the key that sent the request can’t end its moment', () => {
  show(RECEIVED);
  advance(299);
  key({ key: 'Enter' });
  fireEvent.pointerDown(shownLayer());
  expect(layer()).not.toBeNull();
  expect(window.getComputedStyle(shownLayer()).pointerEvents).not.toBe('none');
});

function pointerEventsOf(root: HTMLElement): string {
  return window.getComputedStyle(root).pointerEvents;
}

test('a press fades it and holds it until its click has landed, so the press does not reach the page', () => {
  pagePress.mockClear();
  show(RECEIVED);
  advance(400);
  const root = shownLayer();
  // A touch's click is hit-tested when the finger lifts: the layer must still be there to take it.
  fireEvent.pointerDown(root);
  expect(pointerEventsOf(root)).toBe('auto');
  advance(50);
  fireEvent.pointerUp(root);
  expect(pointerEventsOf(root)).toBe('auto');
  fireEvent.mouseDown(root);
  fireEvent.click(root);
  expect(pagePress).not.toHaveBeenCalled();
  // From the click on, presses reach the page; the layer is gone at the end of its 200ms fade.
  expect(pointerEventsOf(root)).toBe('none');
  advance(149);
  expect(layer()).not.toBeNull();
  advance(1);
  expect(layer()).toBeNull();
});

test('reduced motion: a press removes the layer once its click has landed, not on pointerdown', () => {
  prefersReducedMotion();
  show(RECEIVED);
  advance(400);
  const root = shownLayer();
  fireEvent.pointerDown(root);
  expect(layer()).not.toBeNull();
  fireEvent.pointerUp(root);
  expect(layer()).not.toBeNull();
  fireEvent.click(root);
  expect(layer()).toBeNull();
});

test('a lift with no click lets presses through after 350ms, and a cancelled press at once', () => {
  show(RECEIVED);
  advance(400);
  fireEvent.pointerDown(shownLayer());
  fireEvent.pointerUp(shownLayer());
  // The 200ms fade is over, but the press still holds the layer until its click could have come.
  advance(349);
  expect(pointerEventsOf(shownLayer())).toBe('auto');
  advance(1);
  expect(layer()).toBeNull();
  cleanup();

  prefersReducedMotion();
  show(RECEIVED);
  advance(400);
  fireEvent.pointerDown(shownLayer());
  // A scroll took the touch over: no click follows.
  fireEvent.pointerCancel(shownLayer());
  expect(layer()).toBeNull();
});

test('a press held through the automatic exit keeps the layer until it ends', () => {
  show(RECEIVED);
  // In the grace period: it does not dismiss, but it is down on the layer.
  advance(100);
  fireEvent.pointerDown(shownLayer());
  advance(5000);
  expect(pointerEventsOf(shownLayer())).toBe('auto');
  fireEvent.pointerUp(shownLayer());
  fireEvent.click(shownLayer());
  expect(layer()).toBeNull();
});

test('a wheel over the layer fades it too', () => {
  show(WELCOME);
  advance(400);
  act(() => { shownLayer().firstElementChild?.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); });
  advance(200);
  expect(layer()).toBeNull();
});

test('repeat and modifier-only keys are ignored', () => {
  show(WELCOME);
  advance(400);
  for (const name of ['Shift', 'Control', 'Alt', 'Meta']) key({ key: name });
  key({ key: 'a', repeat: true });
  expect(layer()).not.toBeNull();
  key({ key: 'a' });
  expect(layer()).toBeNull();
});

test('a hidden tab waits: nothing starts or announces until visible', () => {
  visibility = 'hidden';
  show(WELCOME);
  expect(layer()).not.toBeNull();
  expect(screen.getByText('Playing')).toBeTruthy();
  advance(10_000);
  expect(layer()).not.toBeNull();
  expect(region().textContent).toBe('');
  setVisibility('visible');
  expect(region().textContent).toBe('Welcome to Townwise, Sam. Hanover Inn, ready to set up.');
  advance(3399);
  expect(layer()).not.toBeNull();
  advance(1);
  expect(layer()).toBeNull();
});

test('prefers-reduced-motion: both lines whole, no fades, still for 2400ms', () => {
  prefersReducedMotion();
  show(WELCOME);
  for (const word of ['Welcome', 'Sam.', 'Hanover', 'up.']) expect(window.getComputedStyle(screen.getByText(word)).opacity).toBe('1');
  advance(2399);
  expect(layer()).not.toBeNull();
  advance(1);
  expect(layer()).toBeNull();
});
