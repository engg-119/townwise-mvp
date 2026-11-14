import { act, cleanup, render, screen, within } from '@testing-library/react';

import { PULSE, PULSE_KEYFRAMES, Skeleton, SkeletonField, SkeletonHeading, SkeletonTable, SkeletonText } from '../../../src/portal/skeleton';

// The skeleton kit in the browser (spec 15.7 Loading): one polite status line and aria-hidden shapes, an opacity
// pulse in CSS that is off under prefers-reduced-motion, and shapes that keep the content's size at each width.

const QUERY = '(prefers-reduced-motion: reduce)';

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  setWidth(1280);
});

/** The browser's prefers-reduced-motion. */
function reduceMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: query === QUERY && reduce,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

function skeleton(): React.JSX.Element {
  return (
    <Skeleton name="notes" label="Loading notes">
      <SkeletonHeading kicker />
      <SkeletonText lines={2} />
      <SkeletonTable columns={[{ flex: 1.5 }, { flex: 1.3 }]} />
    </Skeleton>
  );
}

function shapes(): HTMLElement {
  return screen.getByTestId('skeleton-shapes');
}

test('one polite status line with the loading words; the shapes are aria-hidden and hold no text', () => {
  render(skeleton());
  const root = screen.getByTestId('skeleton-notes');
  const status = within(root).getByRole('status');
  expect(status.textContent).toBe('Loading notes');
  expect(status.getAttribute('aria-live')).toBe('polite');
  expect(shapes().getAttribute('aria-hidden')).toBe('true');
  expect(shapes().textContent).toBe('');
  expect(root.textContent).toBe('Loading notes');
});

test('the pulse runs with no stated preference, and is off under prefers-reduced-motion', () => {
  const pulsing = render(skeleton());
  expect(shapes().getAttribute('data-pulse')).toBe('on');
  const animated = shapes().className;
  pulsing.unmount();

  reduceMotion(true);
  render(skeleton());
  expect(shapes().getAttribute('data-pulse')).toBe('off');
  // The pulse's class is gone, so nothing animates.
  expect(shapes().className.split(' ').length).toBeLessThan(animated.split(' ').length);
});

/** The text of every CSS rule react-native-web has inserted. */
function cssRules(): string[] {
  return [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText));
}

test('the pulse animates opacity and nothing else', () => {
  for (const frame of Object.values(PULSE_KEYFRAMES)) expect(Object.keys(frame)).toEqual(['opacity']);
  render(skeleton());
  // react-native-web's own (the spinner's, the modal's fades) are there too; the pulse's is the one with a 50% frame.
  const pulse = cssRules().filter((rule) => rule.startsWith('@keyframes') && rule.includes(`50% {opacity: ${String(PULSE.low)};}`));
  expect(pulse).toHaveLength(1);
  expect(pulse[0]?.replace(/opacity/g, '')).not.toMatch(/[a-z-]+\s*:/);
});

function boxes(height: number): Element[] {
  return [...document.querySelectorAll(`div[style*="height: ${String(height)}px"]`)];
}

test('a text line keeps its line height: 20px for small text, 24px on phones', () => {
  render(<SkeletonText lines={2} />);
  expect(boxes(20)).toHaveLength(2);
  cleanup();
  setWidth(375);
  render(<SkeletonText lines={2} />);
  expect(boxes(24)).toHaveLength(2);
});

test('a field’s input is 44px tall', () => {
  render(<SkeletonField />);
  expect(boxes(44)).toHaveLength(1);
});
