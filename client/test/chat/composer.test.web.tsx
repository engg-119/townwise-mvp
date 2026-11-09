import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Composer, COMPOSER_LABEL, type ComposerProps } from '../../src/chat/ui/ChatComposer';

// The rounded composer on web: the button's three readings, rotating examples, the radii, the leading slot, growth
// and the counter.

const observers: (() => void)[] = [];

class ResizeObserverPolyfill {
  constructor(callback: () => void) { observers.push(callback); }
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
globalThis.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;

const width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

afterEach(() => {
  cleanup();
  observers.length = 0;
  jest.useRealTimers();
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
});

function reduceMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: query === '(prefers-reduced-motion: reduce)' && reduce,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

function props(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: '', onChange: jest.fn(), streaming: false, canSend: false, onSend: jest.fn(), onStop: jest.fn(),
    onStopAndSend: jest.fn(), help: 'Leave out guest names.', examples: [], readOnlyId: null, placement: 'dock', ...over,
  };
}

function boxOf(field: HTMLElement): HTMLElement {
  const box = field.parentElement?.parentElement;
  if (box === null || box === undefined) throw new Error('no box');
  return box;
}

const EXAMPLES = ['How did last week go?', 'Is a closure coming?'];

test('reads Send, Stop with an empty draft and Stop and send with text while a reply streams', () => {
  const { rerender } = render(<Composer {...props({ draft: 'hi', canSend: true })} />);
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  rerender(<Composer {...props({ streaming: true })} />);
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  const onStopAndSend = jest.fn();
  rerender(<Composer {...props({ streaming: true, draft: 'next', canSend: true, onStopAndSend })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop and send' }));
  expect(onStopAndSend).toHaveBeenCalledTimes(1);
});

test('Send is aria-disabled, not disabled, until it can send', () => {
  const onSend = jest.fn();
  render(<Composer {...props({ onSend })} />);
  const send = screen.getByRole('button', { name: 'Send' });
  expect(send.getAttribute('aria-disabled')).toBe('true');
  expect(send.hasAttribute('disabled')).toBe(false);
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
});

test('rotates examples every 4.2 seconds while empty, stops with text, and never under reduced motion', () => {
  jest.useFakeTimers();
  reduceMotion(false);
  const { rerender } = render(<Composer {...props({ examples: EXAMPLES })} />);
  const field = () => screen.getByLabelText(COMPOSER_LABEL);
  expect(field().getAttribute('placeholder')).toBe(EXAMPLES[0]);
  act(() => { jest.advanceTimersByTime(4199); });
  expect(field().getAttribute('placeholder')).toBe(EXAMPLES[0]);
  act(() => { jest.advanceTimersByTime(1); });
  expect(field().getAttribute('placeholder')).toBe(EXAMPLES[1]);
  rerender(<Composer {...props({ examples: EXAMPLES, draft: 'x', canSend: true })} />);
  act(() => { jest.advanceTimersByTime(9000); });
  rerender(<Composer {...props({ examples: EXAMPLES })} />);
  expect(field().getAttribute('placeholder')).toBe(EXAMPLES[1]);
  cleanup();
  reduceMotion(true);
  render(<Composer {...props({ examples: EXAMPLES })} />);
  act(() => { jest.advanceTimersByTime(20000); });
  expect(field().getAttribute('placeholder')).toBe(EXAMPLES[0]);
});

test('Tab in an empty composer accepts the shown example; with text it is left alone', () => {
  const onChange = jest.fn();
  const { rerender } = render(<Composer {...props({ examples: EXAMPLES, onChange })} />);
  const field = screen.getByLabelText(COMPOSER_LABEL);
  expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(false);
  expect(onChange).toHaveBeenCalledWith(EXAMPLES[0]);
  onChange.mockClear();
  rerender(<Composer {...props({ examples: EXAMPLES, onChange, draft: 'x', canSend: true })} />);
  expect(fireEvent.keyDown(screen.getByLabelText(COMPOSER_LABEL), { key: 'Tab' })).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

test('Enter sends when it can and does nothing while streaming', () => {
  const onSend = jest.fn();
  const { rerender } = render(<Composer {...props({ draft: 'hi', canSend: true, onSend })} />);
  fireEvent.keyDown(screen.getByLabelText(COMPOSER_LABEL), { key: 'Enter' });
  expect(onSend).toHaveBeenCalledTimes(1);
  rerender(<Composer {...props({ draft: 'hi', canSend: true, onSend, streaming: true })} />);
  fireEvent.keyDown(screen.getByLabelText(COMPOSER_LABEL), { key: 'Enter' });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('is a rounded box: radius 24, and the button radius 22', () => {
  render(<Composer {...props()} />);
  const box = boxOf(screen.getByLabelText(COMPOSER_LABEL));
  expect(getComputedStyle(box).getPropertyValue('border-top-left-radius')).toBe('24px');
  expect(getComputedStyle(screen.getByRole('button', { name: 'Send' })).getPropertyValue('border-top-left-radius')).toBe('22px');
});

test('renders the leading slot first inside the box only when given', () => {
  const { rerender } = render(<Composer {...props()} />);
  expect(screen.queryByText('Add data')).toBeNull();
  rerender(<Composer {...props({ leading: <span>Add data</span> })} />);
  const box = boxOf(screen.getByLabelText(COMPOSER_LABEL));
  expect(box.firstElementChild?.textContent).toBe('Add data');
});

test('grows to 200px and then scrolls; the counter shows from 3,600 characters', () => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 300 });
  const { rerender } = render(<Composer {...props({ draft: 'a\nb\nc\nd\ne\nf\ng\nh\ni' })} />);
  const field = screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL);
  expect(getComputedStyle(field).maxHeight).toBe('200px');
  expect(field.style.height).toBe('300px');
  expect(screen.queryByText(/of 4,000/)).toBeNull();
  rerender(<Composer {...props({ draft: 'a'.repeat(3599) })} />);
  expect(screen.queryByText(/of 4,000/)).toBeNull();
  rerender(<Composer {...props({ draft: 'a'.repeat(3600) })} />);
  expect(screen.getByText('3,600 of 4,000')).toBeTruthy();
});

test('the second-line layout keeps the same input (and its focus), with the leading slot after it', () => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 72 });
  const leading = <span>Add data</span>;
  render(<Composer {...props({ draft: 'a long question', leading })} />);
  const field = screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL);
  field.focus();
  const box = boxOf(field);
  expect(box.firstElementChild?.textContent).toBe('Add data');
  act(() => { observers.forEach((callback) => { callback(); }); });
  expect(screen.getByLabelText(COMPOSER_LABEL)).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(box.firstElementChild).toBe(field.parentElement);
  expect(box.children[1]?.textContent).toBe('Add data');
});
