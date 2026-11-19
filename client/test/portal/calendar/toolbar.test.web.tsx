import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { CalendarFilters, Toolbar } from '../../../src/portal/calendar/Toolbar';
import { ALL_FILTERS } from '../../../src/portal/calendar/model';

// The Calendar's header row on web (P28, spec 16.3): Today, Previous and Next, then the label (aria-live, 216px from
// 641px so the controls after it never move), then the trailing slot's "Your calendars" button as the row's last item,
// whose popover floats over the page, so no line follows the row. The filters are their own group, which the page
// places by width.

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

function renderToolbar(fields: { canPrevious?: boolean; canNext?: boolean; view?: 'month' | 'week'; label?: string } = {}): {
  previous: jest.Mock; next: jest.Mock; today: jest.Mock; onView: jest.Mock;
} {
  const previous = jest.fn();
  const next = jest.fn();
  const today = jest.fn();
  const onView = jest.fn();
  render(
    <Toolbar
      label={fields.label ?? 'November 2026'}
      canPrevious={fields.canPrevious ?? true}
      canNext={fields.canNext ?? true}
      onPrevious={previous}
      onNext={next}
      onToday={today}
      view={fields.view ?? 'month'}
      onView={onView}
      trailing={<button type="button">Your calendars</button>}
    />,
  );
  return { previous, next, today, onView };
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

test('the trailing button comes after the label as the header row’s last item, and nothing follows the row', () => {
  renderToolbar();
  const label = screen.getByText('November 2026');
  const trailing = screen.getByRole('button', { name: 'Your calendars' });
  expect(before(label, trailing)).toBe(true);
  const row = label.parentElement?.parentElement;
  expect(trailing.parentElement).toBe(row);
  expect(row?.lastElementChild).toBe(trailing);
  expect(row?.nextElementSibling).toBeNull();
  // Every item of the row is one of its own: the arrows' group, the switch and the button.
  expect(row?.children).toHaveLength(3);
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

test('the “Calendar view” switch: Month and Week with aria-pressed, the arrows named for the view, Month calls onView', () => {
  const { onView } = renderToolbar();
  const group = screen.getByRole('group', { name: 'Calendar view' });
  const pressed = () => within(group).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')]);
  expect(pressed()).toEqual([['Month', 'true'], ['Week', 'false']]);
  fireEvent.click(within(group).getByRole('button', { name: 'Week' }));
  expect(onView).toHaveBeenLastCalledWith('week');
  cleanup();
  const week = renderToolbar({ view: 'week', label: 'Dec 28, 2026 to Jan 3, 2027' });
  const again = screen.getByRole('group', { name: 'Calendar view' });
  expect(within(again).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['Month', 'false'], ['Week', 'true']]);
  expect(screen.getByRole('button', { name: 'Previous week' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Next week' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Next month' })).toBeNull();
  fireEvent.click(within(again).getByRole('button', { name: 'Month' }));
  expect(week.onView).toHaveBeenLastCalledWith('month');
});

test('the switch sits after the label and before the trailing controls, in the header row, with no margin of its own', () => {
  for (const at of [1280, 800]) {
    setWidth(at);
    renderToolbar();
    const label = screen.getByText('November 2026');
    const group = screen.getByRole('group', { name: 'Calendar view' });
    const trailing = screen.getByRole('button', { name: 'Your calendars' });
    expect(before(label, group)).toBe(true);
    expect(before(group, trailing)).toBe(true);
    // A row item beside the trailing controls, so below 1024px they start their line together.
    expect(group.parentElement).toBe(trailing.parentElement);
    // From 1024px the label's group already pushes it right; a second auto margin would split the free space.
    expect(window.getComputedStyle(group).marginLeft).not.toBe('auto');
    expect(window.getComputedStyle(group).flexBasis).not.toBe('100%');
    cleanup();
  }
});

test('the label stays 216px wide in both views', () => {
  renderToolbar({ view: 'month' });
  expect(window.getComputedStyle(screen.getByText('November 2026')).width).toBe('216px');
  cleanup();
  renderToolbar({ view: 'week', label: 'Dec 28, 2026 to Jan 3, 2027' });
  expect(window.getComputedStyle(screen.getByText('Dec 28, 2026 to Jan 3, 2027')).width).toBe('216px');
});

test('CalendarFilters is the “Show on the calendar” group of pressed chips; Your calendar only when the location has a calendar', () => {
  const onFilter = jest.fn();
  const onChart = jest.fn();
  const { rerender } = render(<CalendarFilters filters={{ ...ALL_FILTERS, terms: false }} onFilter={onFilter} imported={false} chart onChart={onChart} />);
  const group = screen.getByRole('group', { name: 'Show on the calendar' });
  const chips = within(group).getAllByRole('button');
  // The last chip shows or hides the forecast chart (D64).
  expect(chips.map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
    ['Holidays', 'true'], ['Town events', 'true'], ['Term dates', 'false'], ['Your notes', 'true'], ['Forecast chart', 'true'],
  ]);
  fireEvent.click(within(group).getByRole('button', { name: 'Term dates' }));
  expect(onFilter).toHaveBeenCalledWith('terms');
  fireEvent.click(within(group).getByRole('button', { name: 'Forecast chart' }));
  expect(onChart).toHaveBeenCalledTimes(1);
  expect(onFilter).toHaveBeenCalledTimes(1);
  rerender(<CalendarFilters filters={ALL_FILTERS} onFilter={onFilter} imported chart={false} onChart={onChart} />);
  expect(within(screen.getByRole('group', { name: 'Show on the calendar' })).getByRole('button', { name: 'Forecast chart' }).getAttribute('aria-pressed')).toBe('false');
  expect(within(screen.getByRole('group', { name: 'Show on the calendar' })).getByRole('button', { name: 'Your calendar' })).toBeTruthy();
});
