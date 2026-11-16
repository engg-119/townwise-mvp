import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { SalesDay } from '../../../src/portal/locations/api';
import { SalesChart } from '../../../src/portal/locations/SalesChart.web';

// Sales data's daily chart on web (spec P12, D21, design decision 10 of refine-calendar-and-home): a mouse or pen
// over the plot marks the nearest calendar day with a rule and a dot on its value and shows the charts' tooltip with
// the day and its value, or "No data" with no dot; a touch shows nothing, and the marks and tooltip are aria-hidden.

afterEach(cleanup);

// Nine calendar days, May 26 to Jun 3, 2026: May 28 has no row and Jun 1 has no value, so a pointer at k/8 of the
// plot's width is over the k-th day.
const DAYS: SalesDay[] = [
  { date: '2026-05-26', guests: 300, netSalesCents: 612_345 },
  { date: '2026-05-27', guests: 350, netSalesCents: 700_000 },
  { date: '2026-05-29', guests: 410, netSalesCents: 820_050 },
  { date: '2026-05-30', guests: 486, netSalesCents: 958_049 },
  { date: '2026-05-31', guests: 420, netSalesCents: 840_000 },
  { date: '2026-06-01', guests: null, netSalesCents: null },
  { date: '2026-06-02', guests: 280, netSalesCents: 560_000 },
  { date: '2026-06-03', guests: 260, netSalesCents: 520_000 },
];

function plotOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector<SVGSVGElement>('svg[data-chart="sales"]');
  if (svg === null) throw new Error('no sales chart');
  svg.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 196, right: 300, bottom: 196, x: 100, y: 0, toJSON: () => ({}) });
  return svg;
}

/** jsdom has no PointerEvent, so `pointerType` is set on a plain MouseEvent. */
function pointAt(svg: Element, fraction: number, pointerType: 'mouse' | 'pen' | 'touch' = 'mouse'): void {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: 100 + fraction * 200 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(svg, event);
}

function tipLines(): string[] {
  return Array.from(screen.getByTestId('chart-tooltip').children, (child) => child.textContent);
}

test('a pointer over the plot marks the nearest day with a rule and a dot on its value, and the tooltip reads its guests', () => {
  const { container } = render(<SalesChart days={DAYS} series="guests" />);
  const svg = plotOf(container);
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  expect(container.querySelector('[data-hover="day"]')).toBeNull();
  // 0.47 of the way is 3.76 days in: the nearest day is the 5th, May 30, not the 4th the pointer has passed.
  pointAt(svg, 0.47);
  expect(tipLines()).toEqual(['Sat, May 30, 2026', '486 guests']);
  const marks = container.querySelector('[data-hover="day"]');
  // The rule runs across the plot, between its two borders; the dot sits on the line at the day's value (the
  // highest, so the top of the line's box).
  expect(marks?.querySelector('path')?.getAttribute('d')).toBe('M150 8 V188');
  expect(container.querySelector('[data-hover="dot"] path')?.getAttribute('d')).toBe('M150 0 h0.01');
  // A pen hovers as a mouse does.
  pointAt(svg, 1, 'pen');
  expect(tipLines()).toEqual(['Wed, Jun 3, 2026', '260 guests']);
});

test('on the net sales series the tooltip reads the day’s net sales in dollars', () => {
  const { container } = render(<SalesChart days={DAYS} series="netSales" />);
  const svg = plotOf(container);
  pointAt(svg, 0.5);
  expect(tipLines()).toEqual(['Sat, May 30, 2026', '$9,580']);
  pointAt(svg, 0);
  expect(tipLines()).toEqual(['Tue, May 26, 2026', '$6,123']);
});

test('a day with no row or no value says "No data" and draws no dot', () => {
  const { container } = render(<SalesChart days={DAYS} series="guests" />);
  const svg = plotOf(container);
  pointAt(svg, 2 / 8);
  expect(tipLines()).toEqual(['Thu, May 28, 2026', 'No data']);
  expect(container.querySelector('[data-hover="day"]')).not.toBeNull();
  expect(container.querySelector('[data-hover="dot"]')).toBeNull();
  pointAt(svg, 6 / 8);
  expect(tipLines()).toEqual(['Mon, Jun 1, 2026', 'No data']);
  expect(container.querySelector('[data-hover="dot"]')).toBeNull();
});

test('a touch shows nothing, and a touch after a hover clears it', () => {
  const { container } = render(<SalesChart days={DAYS} series="guests" />);
  const svg = plotOf(container);
  pointAt(svg, 0.5, 'touch');
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  expect(container.querySelector('[data-hover="day"]')).toBeNull();
  pointAt(svg, 0.5);
  expect(screen.getByTestId('chart-tooltip')).toBeTruthy();
  pointAt(svg, 0.5, 'touch');
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
});

test('leaving the plot clears the rule, the dot and the tooltip', () => {
  const { container } = render(<SalesChart days={DAYS} series="guests" />);
  const svg = plotOf(container);
  pointAt(svg, 0.5);
  expect(container.querySelector('[data-hover="dot"]')).not.toBeNull();
  fireEvent.pointerLeave(svg);
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  expect(container.querySelector('[data-hover="day"]')).toBeNull();
  expect(container.querySelector('[data-hover="dot"]')).toBeNull();
});

test('the tooltip and the marks are hidden from screen readers', () => {
  const { container } = render(<SalesChart days={DAYS} series="guests" />);
  const svg = plotOf(container);
  pointAt(svg, 0.5);
  const tip = screen.getByTestId('chart-tooltip');
  expect(tip.getAttribute('aria-hidden')).toBe('true');
  // The marks are drawn inside the aria-hidden svg.
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  expect(svg.contains(container.querySelector('[data-hover="day"]'))).toBe(true);
  expect(within(tip).getByText('486 guests')).toBeTruthy();
});
