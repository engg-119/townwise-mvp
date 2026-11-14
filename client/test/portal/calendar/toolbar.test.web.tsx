import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { CalendarFilters, Toolbar } from '../../../src/portal/calendar/Toolbar';
import { ALL_FILTERS } from '../../../src/portal/calendar/model';

// The Calendar's header row on web (P28, spec 16.3): Today, Previous and Next, then the label (aria-live, 216px from
// 641px so the controls after it never move), then the trailing slot's controls as the row's own items. The filters
// are their own group, which the page places by width.

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  if (width !== 1280) setWidth(1280);
});

function renderToolbar(fields: { canPrevious?: boolean; canNext?: boolean } = {}): { previous: jest.Mock; next: jest.Mock; today: jest.Mock } {
  const previous = jest.fn();
  const next = jest.fn();
  const today = jest.fn();
  render(
    <Toolbar
      label="November 2026"
      canPrevious={fields.canPrevious ?? true}
      canNext={fields.canNext ?? true}
      onPrevious={previous}
      onNext={next}
      onToday={today}
      trailing={<button type="button">Import a calendar file</button>}
    />,
  );
  return { previous, next, today };
}

function before(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

test('Today, Previous month and Next month come before the label, which is aria-live and 216px wide', () => {
  const { previous, next, today } = renderToolbar();
  const order = [
    screen.getByRole('button', { name: 'Today' }), screen.getByRole('button', { name: 'Previous month' }),
    screen.getByRole('button', { name: 'Next month' }), screen.getByText('November 2026'),
  ];
  order.slice(1).forEach((element, index) => { expect(before(order[index] as Element, element)).toBe(true); });
  const label = screen.getByText('November 2026');
  expect(label.getAttribute('aria-live')).toBe('polite');
  expect(window.getComputedStyle(label).width).toBe('216px');
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect([today.mock.calls.length, previous.mock.calls.length, next.mock.calls.length]).toEqual([1, 1, 1]);
});

test('at 375 the label is not fixed, so it can wrap', () => {
  setWidth(375);
  renderToolbar();
  expect(window.getComputedStyle(screen.getByText('November 2026')).width).not.toBe('216px');
});

test('Previous and Next are disabled in place at the 25 months’ ends', () => {
  const { previous, next } = renderToolbar({ canPrevious: false, canNext: false });
  for (const name of ['Previous month', 'Next month']) {
    const button = screen.getByRole('button', { name });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
  }
  expect(previous).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  expect(before(screen.getByRole('button', { name: 'Previous month' }), screen.getByText('November 2026'))).toBe(true);
});

test('the trailing controls come after the label, as the header row’s own items', () => {
  renderToolbar();
  const label = screen.getByText('November 2026');
  const trailing = screen.getByRole('button', { name: 'Import a calendar file' });
  expect(before(label, trailing)).toBe(true);
  const row = label.parentElement?.parentElement;
  expect(trailing.parentElement).toBe(row);
});

// jsdom does no layout, so the styles that place the trailing controls are checked (7.2 measures them).
test('from 1024px the trailing controls sit at the right, also on a wrapped line; below that they start their own line', () => {
  for (const [at, wide] of [[1280, true], [1024, true], [1023, false], [800, false], [375, false]] as const) {
    setWidth(at);
    renderToolbar();
    const nav = screen.getByText('November 2026').parentElement;
    const row = nav?.parentElement;
    if (nav === null || row === null || row === undefined) throw new Error('no header row');
    expect([at, window.getComputedStyle(nav).flexBasis === '100%']).toEqual([at, !wide]);
    expect([at, window.getComputedStyle(nav).marginRight === 'auto']).toEqual([at, wide]);
    expect([at, window.getComputedStyle(row).justifyContent === 'flex-end']).toEqual([at, wide]);
    cleanup();
  }
});

test('CalendarFilters is the “Show on the calendar” group of pressed chips; Your calendar only after an import', () => {
  const onFilter = jest.fn();
  const { rerender } = render(<CalendarFilters filters={{ ...ALL_FILTERS, terms: false }} onFilter={onFilter} imported={false} />);
  const group = screen.getByRole('group', { name: 'Show on the calendar' });
  const chips = within(group).getAllByRole('button');
  expect(chips.map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
    ['Holidays', 'true'], ['Town events', 'true'], ['Term dates', 'false'], ['Your notes', 'true'],
  ]);
  fireEvent.click(within(group).getByRole('button', { name: 'Term dates' }));
  expect(onFilter).toHaveBeenCalledWith('terms');
  rerender(<CalendarFilters filters={ALL_FILTERS} onFilter={onFilter} imported />);
  expect(within(screen.getByRole('group', { name: 'Show on the calendar' })).getByRole('button', { name: 'Your calendar' })).toBeTruthy();
});
