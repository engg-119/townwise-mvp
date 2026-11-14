import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { visualSchema } from '../../src/chat/visuals/schema';
import { VisualView } from '../../src/chat/visuals/Visual';
import { daily, dailyWithBand, daysTable, down12, forecastOnly, mixed, storedBeforeMid, weekdays } from './visuals-fixtures';

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
  expect(screen.getByText('Guests and forecast, Oct 1 to Oct 5, 2026')).toBeTruthy();
  // Stored before the API sent the forecast's middle: no dashed line.
  expect(container.querySelector('[data-series="middle"]')).toBeNull();
  expect(screen.queryByText('Forecast middle')).toBeNull();
});

test('a range with no sales yet draws the forecast alone: the band, the middle as a 1px dashed line, and only their legend', () => {
  const { container } = render(<VisualView visual={forecastOnly} />);
  expect(container.querySelector('svg[data-chart="daily"]')).not.toBeNull();
  // Nov 16 and 17, Nov 19 and 20, then Nov 22 alone: the closed and booked days have no band.
  expect(container.querySelectorAll('[data-series="band"]')).toHaveLength(3);
  const middle = container.querySelectorAll('[data-series="middle"]');
  expect(middle).toHaveLength(1);
  expect(middle[0]?.getAttribute('stroke-dasharray')).toBe('4 3');
  expect(middle[0]?.getAttribute('stroke-width')).toBe('1');
  expect(middle[0]?.getAttribute('d')?.match(/M/g)).toHaveLength(3);
  expect(container.querySelector('[data-series="line"]')?.getAttribute('d')).toBe('');
  expect(screen.getByText('Forecast range')).toBeTruthy();
  expect(screen.getByText('Forecast middle')).toBeTruthy();
  expect(screen.queryByText('Daily guests')).toBeNull();
  expect(screen.getByText('Guests and forecast, Nov 16 to Nov 22, 2026')).toBeTruthy();
  expect(screen.getByText(/^No sales yet for these days\. The shaded band/)).toBeTruthy();
  // The scale reaches the band's highest, 280.
  expect(screen.getByText('Scale 0 to 500 guests. Scale fitted to this location.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Show the numbers/ }));
  expect(screen.getAllByText('Forecast middle').length).toBeGreaterThan(1);
  expect(screen.getAllByText('Closed').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Booked').length).toBeGreaterThan(0);
});

test('sales before today and the forecast from today on draw the line, the band and the middle, each in the legend', () => {
  const { container } = render(<VisualView visual={mixed} />);
  expect(container.querySelector('[data-series="line"]')?.getAttribute('d')).toMatch(/^M0 /);
  expect(container.querySelectorAll('[data-series="band"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-series="middle"]')).toHaveLength(1);
  for (const label of ['Daily guests', 'Forecast range', 'Forecast middle']) expect(screen.getByText(label)).toBeTruthy();
});

test('a daily visual stored before the forecast’s middle was sent still draws, with its band and no middle', () => {
  const { container } = render(<VisualView visual={visualSchema.parse(storedBeforeMid)} />);
  expect(container.querySelectorAll('[data-series="band"]')).toHaveLength(1);
  expect(container.querySelector('[data-series="middle"]')).toBeNull();
  expect(screen.getByText('Daily guests')).toBeTruthy();
  expect(screen.getByText(/^2 days with data\./)).toBeTruthy();
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

test('hovering a forecast day reads the forecast as the product does', () => {
  const { container } = render(<VisualView visual={forecastOnly} />);
  const svg = svgOf(container, 'svg[data-chart="daily"]');
  hoverAt(svg, 0);
  const tip = screen.getByTestId('chart-tooltip');
  expect(tip.textContent).toContain('Mon, Nov 16, 2026');
  expect(tip.textContent).toContain('Forecast about 180, likely 117 to 256');
  expect(tip.textContent).not.toContain('No data');
  hoverAt(svg, 2 / 6);
  expect(screen.getByTestId('chart-tooltip').textContent).toContain('Forecast: closed');
  cleanup();
  // A day with sales reads its actual; a day from today on, the forecast.
  const both = svgOf(render(<VisualView visual={mixed} />).container, 'svg[data-chart="daily"]');
  hoverAt(both, 0);
  expect(screen.getByTestId('chart-tooltip').textContent).toBe('Tue, Nov 10, 2026120 guests');
  hoverAt(both, 3 / 5);
  expect(screen.getByTestId('chart-tooltip').textContent).toContain('Forecast about 180, likely 117 to 256');
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
