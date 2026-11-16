import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { BarChart, LineChart, YEAR_DASHES, yearStroke } from '../../../src/portal/analytics/AnalyticsCharts.web';
import { theme } from '../../../src/theme';

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

test('years are told apart by more than color: the newest mint and solid, each older year gray with a dash of its own', () => {
  expect(yearStroke(2026, [2024, 2025, 2026])).toEqual({ color: theme.color.mint, dash: null });
  expect(yearStroke(2025, [2024, 2025, 2026])).toEqual({ color: theme.color.line, dash: YEAR_DASHES[0] });
  expect(yearStroke(2024, [2024, 2025, 2026])).toEqual({ color: theme.color.line, dash: YEAR_DASHES[1] });
  expect(new Set(YEAR_DASHES).size).toBe(YEAR_DASHES.length);
  const point = { value: 40, complete: true };
  const { container } = render(<LineChart metric="guests" lines={[2025, 2026].map((year) => ({ year, points: Array.from({ length: 12 }, () => point) }))} />);
  // Each year's line and its swatch in the key carry the same dash; the key names every year.
  const line = (year: number): Element | null => container.querySelector(`svg g[data-year="${String(year)}"] path`);
  const swatch = (year: number): string => container.querySelector<HTMLElement>(`span[data-year="${String(year)}"] [data-swatch]`)?.style.background ?? '';
  expect(line(2026)?.hasAttribute('stroke-dasharray')).toBe(false);
  expect(swatch(2026)).not.toContain('gradient');
  expect(line(2025)?.getAttribute('stroke-dasharray')).toBe(YEAR_DASHES[0]);
  expect(line(2025)?.getAttribute('stroke-linecap')).toBe('butt');
  // '4 3': 4px of the line, then a 3px gap.
  expect(swatch(2025).replace(/\s+/g, ' ')).toMatch(/repeating-linear-gradient\(to right, .+ 0px 4px, transparent 4px 7px\)/);
  expect([...container.querySelectorAll('span[data-year]')].map((each) => each.textContent)).toEqual(['2025', '2026']);
});

test('a complete month with no month beside it is a solid dot, so a year with one month still shows', () => {
  const points = Array.from({ length: 12 }, () => null as { value: number; complete: boolean } | null);
  points[0] = { value: 40, complete: true };
  points[3] = { value: 50, complete: true };
  points[4] = { value: 60, complete: true };
  const { container } = render(<LineChart metric="guests" lines={[{ year: 2026, points }]} />);
  // January alone is a dot; April and May share a line.
  expect(container.querySelectorAll('[data-lone]')).toHaveLength(1);
});

function pointer(target: Element, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  fireEvent(target, event);
}

test('the year lines keep a gutter at the right, so a year label at December stays inside the chart', () => {
  const point = { value: 40, complete: true };
  const { container } = render(<LineChart metric="guests" lines={[2025, 2026].map((year) => ({ year, points: Array.from({ length: 12 }, () => point) }))} />);
  const svg = container.querySelector('svg');
  const plot = svg?.parentElement;
  if (svg === null || plot === null || plot === undefined) throw new Error('no chart');
  // The plot and the month letters under it leave 40px at the right for a 4-digit label pushed 6px past its point.
  expect(plot.style.marginRight).toBe('40px');
  expect((plot.nextElementSibling as HTMLElement | null)?.style.marginRight).toBe('40px');
  const labels = [...plot.querySelectorAll<HTMLElement>('span')].filter((span) => /^\d{4}$/.test(span.textContent));
  expect(labels.map((label) => label.style.left)).toEqual(['98%', '98%']);
});

test('hovering the year lines marks the nearest month and shows each year’s value there, newest first', () => {
  const points = (values: (number | null)[]): ({ value: number; complete: boolean } | null)[] => values.map((value, index) => (value === null ? null : { value, complete: index < 11 }));
  const { container } = render(
    <LineChart
      metric="guests"
      lines={[
        { year: 2025, points: points([30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52]) },
        { year: 2026, points: points([35, 37, null, null, null, null, null, null, null, null, null, 60]) },
      ]}
    />,
  );
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('no chart');
  svg.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 160, right: 300, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  // x 6 is January's point; 294 December's.
  act(() => { pointer(svg, 'pointermove', 8); });
  const tip = screen.getByTestId('chart-tooltip');
  expect([...tip.children].map((each) => each.textContent)).toEqual(['January', '2026: 35 guests', '2025: 30 guests']);
  expect(container.querySelector('[data-hover="month"]')?.getAttribute('d')).toBe('M6.00 0 V160');
  // March has 2025 only; December is not complete in either year.
  act(() => { pointer(svg, 'pointermove', 59); });
  expect([...screen.getByTestId('chart-tooltip').children].map((each) => each.textContent)).toEqual(['March', '2025: 34 guests']);
  act(() => { pointer(svg, 'pointermove', 299); });
  expect([...screen.getByTestId('chart-tooltip').children].map((each) => each.textContent)).toEqual([
    'December', '2026: 60 guests (month not complete)', '2025: 52 guests (month not complete)',
  ]);
  act(() => { fireEvent.pointerLeave(svg); });
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  expect(container.querySelector('[data-hover="month"]')).toBeNull();
});
