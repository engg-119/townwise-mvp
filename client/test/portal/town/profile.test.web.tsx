import { cleanup, render, screen, within } from '@testing-library/react';

import { TownProfile } from '../../../src/portal/town/TownProfile';

// The Town profile's sources on web (spec P15 and D40, source-chips' "Every source is a round chip with the site's logo
// and name"): each driver's and key date's sources and the BLS list are source chips named by their sites, from the
// bundled data, while the plain-text "Source: U.S. Bureau of Labor Statistics, QCEW, …" sentence stays text.

afterEach(cleanup);

const HANOVER_KEY_DATES = 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates';

/** The item a line of the profile sits in, with its chips. */
function itemOf(line: HTMLElement): HTMLElement {
  const item = line.parentElement;
  if (item === null) throw new Error('no item');
  return item;
}

test('a driver’s and a key date’s sources are chips named by their site', () => {
  render(<TownProfile town={{ townId: 'hanover-nh', name: 'Hanover', state: 'NH' }} heading="Hanover, NH" />);
  const date = screen.getByText('Fall term classes begin, Sep 14, 2026');
  const chip = within(itemOf(date)).getByRole('link', { name: 'Dartmouth Registrar. Source' });
  expect(chip.textContent).toBe('Dartmouth Registrar');
  expect(chip.getAttribute('href')).toBe(HANOVER_KEY_DATES);
  // The bundled data has a link and no label, so the chip's title is the link.
  expect(chip.getAttribute('title')).toBe(HANOVER_KEY_DATES);
  // Two drivers and three key dates, each with its own chip; no source is a bare host or "Source" any more.
  expect(screen.getAllByRole('link', { name: 'Dartmouth Registrar. Source' })).toHaveLength(5);
  expect(screen.queryByRole('link', { name: 'registrar.dartmouth.edu' })).toBeNull();
  expect(screen.queryByRole('link', { name: /^Source/ })).toBeNull();
});

test('an item citing two sites shows one chip for each', () => {
  render(<TownProfile town={{ townId: 'provincetown-ma', name: 'Provincetown', state: 'MA' }} heading="Provincetown, MA" />);
  const carnival = screen.getByText(/^The town’s carnival week, 2026/);
  const chips = within(itemOf(carnival)).getAllByRole('link');
  expect(chips.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Provincetown Business Guild', 'https://www.ptown.org/carnival/'],
    ['Out x Out', 'https://outxout.com/blog/provincetown-carnival-2026'],
  ]);
});

test('the BLS source is a chip with its label in its name, and the QCEW sentence stays text', () => {
  render(<TownProfile town={{ townId: 'hanover-nh', name: 'Hanover', state: 'NH' }} heading="Hanover, NH" />);
  const bls = screen.getByRole('link', {
    name: 'U.S. Bureau of Labor Statistics. Source: BLS QCEW open data area slices, NAICS 722, private ownership, 2024',
  });
  expect(bls.textContent).toBe('U.S. Bureau of Labor Statistics');
  expect(bls.getAttribute('href')).toBe('https://www.bls.gov/cew/additional-resources/open-data/');
  const sentence = screen.getByText('Source: U.S. Bureau of Labor Statistics, QCEW, private food services and drinking places (NAICS 722), Grafton County, 2024.');
  expect(sentence.closest('a')).toBeNull();
});
