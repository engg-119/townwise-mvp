import { cleanup, render, screen } from '@testing-library/react';

import { sourceChipCss, SourceChips } from '../../src/marketing/SourceChip.web';
import { colorVar } from '../../src/theme';

// The public pages' source chip (refine-calendar-and-home design decision 6, source-chips' "A marketing page"): the
// portal's chip in DOM, to its measurements and tokens, with the same names and committed logos. On web the bundler
// hands a committed logo over as `{ uri }` on the site's own origin; jest's asset stub is a number, so each manifest
// entry with a logo is given such a URI here, named for its host.
jest.mock('../../src/portal/sources/logos', () => {
  const actual = jest.requireActual<{ SITES: Record<string, { name: string; logo: unknown }> }>('../../src/portal/sources/logos');
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
/** A host no manifest entry has: a fixture, since every host the shipped data cites is in sites.json. */
const UNKNOWN = { url: 'https://events.example.org/calendar' };

test('a chip is a link to its source showing the site’s logo and name, named by what it shows and titled by its label', () => {
  render(<SourceChips sources={REGISTRAR} />);
  const links = screen.getAllByRole('link');
  expect(links.map((link) => [link.textContent, link.getAttribute('aria-label'), link.getAttribute('title'), link.getAttribute('href')])).toEqual([
    ['Dartmouth Registrar', 'Dartmouth Registrar. Source: Dartmouth Registrar, 2025-26 key dates', 'Dartmouth Registrar, 2025-26 key dates', REGISTRAR[0]?.url],
    ['Dartmouth Registrar 2', 'Dartmouth Registrar 2. Source: Dartmouth Registrar, 2026-27 key dates', 'Dartmouth Registrar, 2026-27 key dates', REGISTRAR[1]?.url],
  ]);
  for (const link of links) {
    expect(link.getAttribute('rel')).toBe('noopener');
    // The site's committed logo, from the site's own origin and hidden from screen readers.
    const image = link.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/assets/assets/sources/registrar.dartmouth.edu.png');
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.closest('[aria-hidden="true"]')).not.toBeNull();
  }
});

test('a host no manifest entry has shows the globe and its host; no image comes from another site', () => {
  render(<SourceChips sources={[...REGISTRAR, UNKNOWN]} />);
  const unknown = screen.getByRole('link', { name: 'events.example.org. Source' });
  expect(unknown.textContent).toBe('events.example.org');
  expect(unknown.querySelector('img')).toBeNull();
  expect(unknown.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelectorAll('img')).toHaveLength(2);
  for (const image of document.querySelectorAll('img')) {
    expect(new URL(image.src, window.location.href).origin).toBe(window.location.origin);
  }
});

test('drawn to the portal chip’s measurements with the theme’s tokens and no color literal', () => {
  const token = (name: Parameters<typeof colorVar>[0]): string => `var(${colorVar(name)})`;
  expect(sourceChipCss).toContain('.src-chips{display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:0;');
  expect(sourceChipCss).toContain('.src-chip{display:inline-flex;align-items:center;min-height:44px;max-width:100%;');
  expect(sourceChipCss).toContain(`min-height:24px;max-width:100%;padding:3px 8px;border:1px solid ${token('border')};border-radius:12px;background:${token('raised')}}`);
  expect(sourceChipCss).toContain(`.src-logo{flex:none;display:block;width:16px;height:16px;border-radius:50%;overflow:hidden;background:${token('logoGround')}}`);
  expect(sourceChipCss).toContain(`.src-glb{flex:none;display:block;width:16px;height:16px;color:${token('text3')}}`);
  expect(sourceChipCss).toMatch(new RegExp(`\\.src-name\\{[^}]*font-size:12px;line-height:16px;font-weight:400;color:var\\(${colorVar('text2')}\\)`));
  expect(sourceChipCss).not.toMatch(/#[0-9a-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\(|ellipsis|nowrap|line-clamp/i);
});

test('no sources, no row', () => {
  const { container } = render(<SourceChips sources={[]} />);
  expect(container.textContent).toBe('');
});
