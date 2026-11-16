import { cleanup, render, screen } from '@testing-library/react';

import { SourceChips } from '../../../src/portal/ui/SourceChip';

// The source chip on web (source-chips: "Every source is a round chip with the site's logo and name" and "A chip is
// named by what it shows"): an <a href> 44px tall around a 24px pill with the site's logo (hidden from screen readers)
// or the globe, and the site's name; its accessible name starts with what it shows; its title is the source's label.
// On web the bundler hands a committed logo over as `{ uri }` on the site's own origin; jest's asset stub is a number,
// which react-native-web draws as no image, so each manifest entry with a logo is given such a URI here, named for its
// host, as test/marketing/source-chip.test.web.tsx does.
jest.mock('../../../src/portal/sources/logos', () => {
  const actual = jest.requireActual<{ SITES: Record<string, { name: string; logo: unknown }> }>('../../../src/portal/sources/logos');
  return {
    SITES: Object.fromEntries(Object.entries(actual.SITES).map(([host, site]) => [
      host, { ...site, logo: site.logo === null ? null : { uri: `/assets/assets/sources/${host}.png`, width: 152, height: 152 } },
    ])),
  };
});

afterEach(cleanup);

const REGISTRAR = [
  { label: 'Dartmouth Registrar, 2025-26 key dates', url: 'https://registrar.dartmouth.edu/calendars/2025-2026-key-dates' },
  { label: 'Dartmouth Registrar, 2026-27 key dates', url: 'https://registrar.dartmouth.edu/calendars/2026-2027-key-dates' },
];
const OPM = { label: 'U.S. Office of Personnel Management', url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/' };
/** A host no manifest entry has: a fixture, since every host the shipped data cites is in sites.json. */
const UNKNOWN = { label: 'Sample events page', url: 'https://events.example.org/calendar' };

test('each source is a link drawn as a pill: the site’s name, never the label, in a 44px target', () => {
  render(<SourceChips sources={[...REGISTRAR, OPM]} />);
  const links = screen.getAllByRole('link');
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Dartmouth Registrar', REGISTRAR[0]?.url], ['Dartmouth Registrar 2', REGISTRAR[1]?.url], ['U.S. Office of Personnel Management', OPM.url],
  ]);
  for (const link of links) {
    expect(link.tagName).toBe('A');
    const target = window.getComputedStyle(link);
    expect(target.minHeight).toBe('44px');
    expect(target.justifyContent).toBe('center');
    const pill = link.firstElementChild;
    if (!(pill instanceof HTMLElement)) throw new Error('no pill');
    const box = window.getComputedStyle(pill);
    expect(box.minHeight).toBe('24px');
    expect(box.borderTopLeftRadius).toBe('12px');
    expect(box.borderTopWidth).toBe('1px');
    expect(box.paddingLeft).toBe('8px');
    // The name is never cut: no line clamp, no ellipsis, no single line; it may wrap inside the pill.
    const name = pill.lastElementChild;
    if (!(name instanceof HTMLElement)) throw new Error('no name');
    expect(name.className).not.toMatch(/lineclamp|oneline|textoverflow|whitespace/i);
    expect(window.getComputedStyle(name).flexShrink).toBe('1');
  }
});

test('the accessible name starts with what the chip shows, number included, and the label is the title', () => {
  render(<SourceChips sources={[...REGISTRAR, OPM]} />);
  const [first, second, opm] = screen.getAllByRole('link');
  expect(first?.getAttribute('aria-label')).toBe('Dartmouth Registrar. Source: Dartmouth Registrar, 2025-26 key dates');
  expect(second?.getAttribute('aria-label')).toBe('Dartmouth Registrar 2. Source: Dartmouth Registrar, 2026-27 key dates');
  // A label that is the site's name adds nothing to it.
  expect(opm?.getAttribute('aria-label')).toBe('U.S. Office of Personnel Management. Source');
  // react-native-web passes no title prop through, so the chip sets it on its <a>.
  expect(first?.getAttribute('title')).toBe('Dartmouth Registrar, 2025-26 key dates');
  expect(second?.getAttribute('title')).toBe('Dartmouth Registrar, 2026-27 key dates');
  expect(screen.getByRole('link', { name: 'Dartmouth Registrar 2. Source: Dartmouth Registrar, 2026-27 key dates' })).toBe(second);
});

test('the logo is hidden from screen readers; a host no manifest entry has shows the globe and its host', () => {
  // The Registrar's chip has its committed logo (OPM's site has none, so it shows the globe too).
  render(<SourceChips sources={[REGISTRAR[0] ?? OPM, UNKNOWN]} />);
  const [known, unknown] = screen.getAllByRole('link');
  if (known === undefined || unknown === undefined) throw new Error('two chips');
  for (const link of [known, unknown]) {
    const logo = link.firstElementChild?.firstElementChild;
    expect(logo?.getAttribute('aria-hidden')).toBe('true');
  }
  // react-native-web draws the logo as a background image with a hidden <img> of the same URL, both in the hidden part.
  const image = known.querySelector('[aria-hidden="true"] img');
  expect(image?.getAttribute('src')).toBe('/assets/assets/sources/registrar.dartmouth.edu.png');
  expect(known.querySelector('[aria-hidden="true"] [style*="background-image"]')?.getAttribute('style'))
    .toContain('url("/assets/assets/sources/registrar.dartmouth.edu.png")');
  expect(known.querySelector('svg')).toBeNull();
  expect(unknown.textContent).toBe('events.example.org');
  expect(unknown.getAttribute('aria-label')).toBe('events.example.org. Source: Sample events page');
  expect(unknown.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  expect(unknown.querySelector('img')).toBeNull();
  expect(unknown.querySelector('[style*="background-image"]')).toBeNull();
});

test('no image comes from another site', () => {
  render(<SourceChips sources={[...REGISTRAR, OPM, UNKNOWN]} />);
  // The two Registrar chips draw their logo; OPM's site and the unknown host draw the globe.
  const images = document.querySelectorAll('img');
  expect(images).toHaveLength(2);
  for (const image of images) {
    expect(new URL(image.src, window.location.href).origin).toBe(window.location.origin);
  }
  const backgrounds = document.querySelectorAll<HTMLElement>('[style*="background-image"]');
  expect(backgrounds).toHaveLength(2);
  for (const element of backgrounds) {
    const url = /url\("([^"]+)"\)/.exec(element.style.backgroundImage)?.[1] ?? '';
    expect(url).not.toBe('');
    expect(new URL(url, window.location.href).origin).toBe(window.location.origin);
  }
});

test('chips in a row sit 8px apart and a wrapped row 20px lower, with no hitSlop; a link keeps its target and rel', () => {
  render(<SourceChips sources={[UNKNOWN]} target="_blank" rel="noopener" />);
  const link = screen.getByRole('link');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener');
  const parent = link.parentElement;
  if (parent === null) throw new Error('no row');
  const row = window.getComputedStyle(parent);
  expect(row.flexWrap).toBe('wrap');
  expect(row.columnGap).toBe('8px');
  expect(row.rowGap).toBe('0px');
});

test('no sources, no row', () => {
  const { container } = render(<SourceChips sources={[]} />);
  expect(container.textContent).toBe('');
  expect(screen.queryAllByRole('link')).toEqual([]);
});
