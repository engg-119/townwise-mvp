import { useEffect, useRef } from 'react';
import { AccessibilityInfo, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { act, fireEvent, isHiddenFromAccessibility, render, screen } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import {
  MomentProvider, requestReceivedStatement, useMoment, welcomeStatement, type Statement,
} from '../../../src/portal/moments';
import { TopBar } from '../../../src/portal/shell/TopBar';

// The moment player on native (spec 15.8), driven by useMoment().play(): the layer, its timeline, dismissal,
// reduced motion and screen readers. Which moment plays when is pinned with the PortalGate wiring.

const RECEIVED = requestReceivedStatement('Hanover Inn');
const WELCOME = welcomeStatement({ firstName: 'Sam', restaurant: 'Hanover Inn' });
const ALL = { includeHiddenElements: true };

let mounts = 0;

/** A page under the provider: says whether a moment is playing, and plays `statement` on a press. */
function Page(props: { statement: Statement; second?: Statement }): React.JSX.Element {
  const { playing, play } = useMoment();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) mounts += 1;
    mounted.current = true;
  }, []);
  return (
    <View>
      <Text>{playing ? 'Playing' : 'Idle'}</Text>
      <Pressable role="button" onPress={() => { play(props.statement); if (props.second !== undefined) play(props.second); }}>
        <Text>Play</Text>
      </Pressable>
    </View>
  );
}

function system(opts: { reduceMotion?: boolean; screenReader?: boolean } = {}) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(opts.reduceMotion ?? false);
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(opts.screenReader ?? false);
  return { announce: jest.spyOn(AccessibilityInfo, 'announceForAccessibility') };
}

async function show(statement: Statement, second?: Statement): Promise<void> {
  await render(<MomentProvider><Page statement={statement} {...(second === undefined ? {} : { second })} /></MomentProvider>);
  // The system's two answers (reduce motion, screen reader).
  await act(async () => { await Promise.resolve(); });
  await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
}

function layer() {
  return screen.queryByTestId('statement-layer', ALL);
}

function shownLayer() {
  return screen.getByTestId('statement-layer', ALL);
}

async function advance(ms: number): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); });
}

beforeEach(() => {
  // The preset's AccessibilityInfo functions are shared mocks: forget earlier tests' calls.
  jest.clearAllMocks();
  jest.useFakeTimers();
  mounts = 0;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('outside a provider useMoment is idle and play does nothing', async () => {
  await render(<Page statement={RECEIVED} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
  expect(screen.getByText('Idle')).toBeTruthy();
  expect(layer()).toBeNull();
});

test('a moment covers the page for its whole timeline and then hands it back; the page never remounts', async () => {
  const { announce } = system();
  await show(RECEIVED);
  expect(screen.getByText('Playing')).toBeTruthy();
  expect(layer()).not.toBeNull();
  expect(screen.getByText('Townwise', ALL)).toBeTruthy();
  for (const word of ['We’ve', 'received', 'Hanover', 'Inn.', 'We’ll', 'soon.']) expect(screen.getByText(word, ALL)).toBeTruthy();
  await advance(3279);
  expect(layer()).not.toBeNull();
  await advance(1);
  expect(layer()).toBeNull();
  expect(screen.getByText('Idle')).toBeTruthy();
  expect(announce.mock.calls).toEqual([['We’ve received your request for Hanover Inn. We’ll let you in soon.']]);
  expect(mounts).toBe(1);
});

test('a play while a moment is up is dropped', async () => {
  system();
  await show(RECEIVED, WELCOME);
  expect(screen.getByText('Hanover', ALL)).toBeTruthy();
  expect(screen.queryByText('Welcome', ALL)).toBeNull();
  await advance(3280);
  expect(layer()).toBeNull();
});

test('a touch dismisses after the grace period, not before', async () => {
  system();
  await show(WELCOME);
  await advance(200);
  await fireEvent(shownLayer(), 'touchStart');
  await advance(400);
  expect(layer()).not.toBeNull();
  await fireEvent(shownLayer(), 'touchStart');
  // From that instant the layer lets presses through, and it is gone after its 200ms fade.
  expect(StyleSheet.flatten(layer()?.props.style as object)).toMatchObject({ pointerEvents: 'none' });
  await advance(199);
  expect(layer()).not.toBeNull();
  await advance(1);
  expect(layer()).toBeNull();
  expect(screen.getByText('Idle')).toBeTruthy();
});

test('with a screen reader running there are no visuals; the full statement is announced once', async () => {
  const { announce } = system({ screenReader: true });
  await show(WELCOME);
  await act(async () => { await Promise.resolve(); });
  expect(layer()).toBeNull();
  expect(screen.queryByText('Welcome', ALL)).toBeNull();
  expect(announce.mock.calls).toEqual([['Welcome to Townwise, Sam. Hanover Inn, ready to set up.']]);
  expect(screen.getByText('Idle')).toBeTruthy();
});

test('reduced motion shows both lines at once and ends at 2400ms', async () => {
  system({ reduceMotion: true });
  await show(WELCOME);
  for (const word of ['Welcome', 'Sam.', 'Hanover', 'up.']) {
    expect(StyleSheet.flatten(screen.getByText(word, ALL).props.style as object)).toMatchObject({ opacity: 1 });
  }
  await advance(2399);
  expect(layer()).not.toBeNull();
  await advance(1);
  expect(layer()).toBeNull();
});

test('full motion starts every word unseen, at full size', async () => {
  system();
  await show(WELCOME);
  const style = StyleSheet.flatten(screen.getByText('Sam.', ALL).props.style as object) as { opacity: number; fontSize: number };
  expect(style.opacity).toBe(0);
  expect(style.fontSize).toBeGreaterThan(0);
});

test('Android back dismisses and is consumed', async () => {
  system();
  const handlers: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  const remove = jest.fn();
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.push(handler);
    return { remove };
  });
  await show(RECEIVED);
  expect(handlers).toHaveLength(1);
  let consumed: unknown = false;
  await act(() => { consumed = handlers[0]?.({ type: 'hardwareBackPress', timeStamp: 0 }); });
  expect(consumed).toBe(true);
  await advance(200);
  expect(layer()).toBeNull();
  expect(remove).toHaveBeenCalledTimes(1);
});

test('the statement text is hidden from accessibility', async () => {
  system();
  await show(RECEIVED);
  const root = layer();
  expect(root?.props).toMatchObject({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' });
  expect(isHiddenFromAccessibility(screen.getByText('Hanover', ALL))).toBe(true);
  expect(screen.queryByText('Hanover')).toBeNull();
});

test('while the system’s answers are unknown, the layer shows only its ground', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => undefined));
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockReturnValue(new Promise(() => undefined));
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  await render(<MomentProvider><Page statement={RECEIVED} /></MomentProvider>);
  await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
  expect(layer()).not.toBeNull();
  expect(screen.getByText('Playing')).toBeTruthy();
  await advance(10_000);
  expect(layer()).not.toBeNull();
  expect(announce).not.toHaveBeenCalled();
});

test('the wordmark copies the top bar’s: the same type, color and 44px box, in a 64px row', async () => {
  system();
  await renderRouter({
    index: () => (
      <MomentProvider>
        <TopBar kind="gate" email="owner@example.test" onSignOut={() => undefined} />
        <Page statement={RECEIVED} />
      </MomentProvider>
    ),
  });
  await act(async () => { await Promise.resolve(); });
  await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
  const [bar, overlay] = screen.getAllByText('Townwise', ALL);
  if (bar === undefined || overlay === undefined) throw new Error('two wordmarks expected');
  expect(isHiddenFromAccessibility(overlay)).toBe(true);
  const keys = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing', 'color', 'minHeight'] as const;
  const typeOf = (node: typeof bar): Record<string, unknown> => {
    const flat = StyleSheet.flatten(node.props.style as object) as Record<string, unknown>;
    return Object.fromEntries(keys.map((name) => [name, flat[name]]));
  };
  expect(typeOf(overlay)).toEqual(typeOf(bar));
  expect(typeOf(bar)).toMatchObject({ fontSize: 18, lineHeight: 44, minHeight: 44 });
  /** The nearest ancestor with a minHeight: the row the wordmark is centered in. */
  const rowOf = (node: typeof bar): unknown => {
    let at = node.parent;
    while (at !== null) {
      const flat = StyleSheet.flatten(at.props.style as object) as { minHeight?: unknown; alignItems?: unknown } | undefined;
      if (flat?.minHeight !== undefined && at !== node) return { minHeight: flat.minHeight, alignItems: flat.alignItems };
      at = at.parent;
    }
    return null;
  };
  expect(rowOf(overlay)).toEqual({ minHeight: 64, alignItems: 'center' });
  expect(rowOf(bar)).toEqual({ minHeight: 64, alignItems: 'center' });
});
