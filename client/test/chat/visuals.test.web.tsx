import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { VisualView } from '../../src/chat/visuals/Visual';
import { daily, dailyWithBand, daysTable, down12, weekdays } from './visuals-fixtures';

afterEach(cleanup);

test('draws the daily chart as aria-hidden SVG at 100% width, the band only on forecast days', () => {
  const { container, rerender } = render(<VisualView visual={daily} />);
  const svg = container.querySelector('svg[data-chart="daily"]');
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect((svg as SVGElement).style.width).toBe('100%');
  expect(container.querySelectorAll('[data-series="band"]')).toHaveLength(0);
  expect(screen.queryByText('Forecast range')).toBeNull();
  expect(screen.getByText('Scale 0 to 100 guests. Scale fitted to this location.')).toBeTruthy();
  rerender(<VisualView visual={dailyWithBand} />);
  // Days 3 and 4 are adjacent forecast days: one band.
  expect(container.querySelectorAll('[data-series="band"]')).toHaveLength(1);
  expect(screen.getByText('Forecast range')).toBeTruthy();
  expect(screen.getByText('Daily guests, Oct 1 to Oct 5, 2026')).toBeTruthy();
});

test('charts are 100% wide and the numbers open from Show the numbers', () => {
  const { container } = render(<VisualView visual={weekdays} />);
  expect((container.querySelector('svg') as SVGElement).style.width).toBe('100%');
  expect(screen.getByText('Highest: Saturday, 150 guests. Lowest: Sunday, 30 guests.')).toBeTruthy();
  expect(screen.queryByText('Average guests')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Show the numbers/ }));
  expect(screen.getAllByText('Average guests').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Saturday').length).toBeGreaterThan(0);
});

test('a days table is the table itself and metrics are cards', () => {
  const table = render(<VisualView visual={daysTable} />);
  expect(table.queryByRole('button', { name: /Show the numbers/ })).toBeNull();
  expect(table.getAllByText('$1,235').length).toBeGreaterThan(0);
  table.unmount();
  render(<VisualView visual={down12} />);
  expect(screen.getByText('−12%')).toBeTruthy();
  expect(screen.getByText('Change from the same days last year')).toBeTruthy();
});
