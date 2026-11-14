import { cleanup, render } from '@testing-library/react';

import { BarChart, LineChart } from '../../../src/portal/analytics/AnalyticsCharts.web';

// The counts up the side of Analytics' bar and line charts (spec P24): 0, the middle and the top of the scale, each
// on its rule and hidden from readers, as the SVG is (the summary and "Show the numbers" carry the same numbers).

afterEach(cleanup);

function counts(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-count]')].map((each) => each.textContent);
}

function tops(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('[data-count]')].map((each) => Number.parseFloat(each.style.top));
}

/** The y of each horizontal rule in the chart's first path, top to bottom. */
function rules(container: HTMLElement): number[] {
  const d = container.querySelector('svg path')?.getAttribute('d') ?? '';
  return [...d.matchAll(/M0 ([\d.]+) H/g)].map((match) => Number(match[1]));
}

test('bars print 0, the middle and the top of the scale up the side, each on its rule, hidden from readers', () => {
  const { container } = render(<BarChart metric="guests" bars={[{ label: 'Mon', value: 120 }, { label: 'Sat', value: 180 }]} />);
  expect(counts(container)).toEqual(['200', '100', '0']);
  expect(tops(container)).toEqual(rules(container));
  for (const each of container.querySelectorAll('[data-count]')) expect(each.getAttribute('aria-hidden')).toBe('true');
});

test('the year-over-year lines print the same counts on their rules, in dollars for net sales', () => {
  const point = (cents: number): { value: number; complete: boolean } => ({ value: cents, complete: true });
  const points = [point(310_000), point(410_000), ...Array.from({ length: 10 }, () => null)];
  const { container } = render(<LineChart metric="netSales" lines={[{ year: 2026, points }]} />);
  expect(counts(container)).toEqual(['$5,000', '$2,500', '$0']);
  expect(tops(container)).toEqual(rules(container));
});
