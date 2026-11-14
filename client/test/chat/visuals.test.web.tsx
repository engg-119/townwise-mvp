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

function svgOf(container: HTMLElement, selector: string): Element {
  const found = container.querySelector(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
}

function hoverAt(svg: Element, fraction: number): void {
  svg.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 196, right: 300, bottom: 196, x: 100, y: 0, toJSON: () => ({}) });
  pointer(svg, 'pointermove', 100 + fraction * 200, 'mouse');
}

/** jsdom has no PointerEvent, so `pointerType` is set on a plain MouseEvent. */
function pointer(target: Element, type: string, clientX: number, pointerType: 'mouse' | 'touch'): void {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(target, event);
}

test('hovering the daily chart shows the nearest day, its value and range, and clears on leave', () => {
  const { container } = render(<VisualView visual={dailyWithBand} />);
  const svg = svgOf(container, 'svg[data-chart="daily"]');
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  hoverAt(svg, 0.5);
  const tip = screen.getByTestId('chart-tooltip');
  expect(tip.getAttribute('aria-hidden')).toBe('true');
  expect(tip.textContent).toContain('Sat, Oct 3, 2026');
  expect(tip.textContent).toContain('90 guests');
  expect(tip.textContent).toContain('Forecast 70 to 110');
  expect(container.querySelector('[data-hover="day"]')).not.toBeNull();
  hoverAt(svg, 0.27);
  expect(screen.getByTestId('chart-tooltip').textContent).toContain('No data');
  fireEvent.pointerLeave(svg);
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  expect(container.querySelector('[data-hover="day"]')).toBeNull();
});

test('a touch does not open the daily tooltip', () => {
  const { container } = render(<VisualView visual={daily} />);
  const svg = svgOf(container, 'svg[data-chart="daily"]');
  svg.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 196, right: 200, bottom: 196, x: 0, y: 0, toJSON: () => ({}) });
  pointer(svg, 'pointermove', 100, 'touch');
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
});

test('hovering a bar highlights it and shows its label, value and days; a bar with no value shows nothing', () => {
  const { container } = render(<VisualView visual={weekdays} />);
  const svg = svgOf(container, 'svg');
  hoverAt(svg, 0.5 / 7 + 4 / 7); // fifth bar: key 5, Friday
  const tip = screen.getByTestId('chart-tooltip');
  expect(tip.textContent).toContain('Friday');
  expect(tip.textContent).toContain('120 guests');
  expect(tip.textContent).toContain('5 days with data');
  expect(container.querySelector('[data-hover="bar"]')).not.toBeNull();
  hoverAt(svg, 1.5 / 7); // second bar has no value
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  hoverAt(svg, 0.5 / 7);
  fireEvent.pointerLeave(svg);
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
});
