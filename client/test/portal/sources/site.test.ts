import { SITES } from '../../../src/portal/sources/logos';
import { sourceChips, sourceSite } from '../../../src/portal/sources/site';

// A source's site for its chip (refine-calendar-and-home design decision 6, source-chips' "Logos are committed assets,
// with a globe for any site without one"): looked up by the URL's host without www., then its parent domains down to
// two labels, else the host itself with no logo. And a row's chips: their names, numbers, accessible names and titles.

test('a host with its own entry is found exactly', () => {
  expect(sourceSite('https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2025-2026-key-dates'))
    .toBe(SITES['registrar.dartmouth.edu']);
  expect(sourceSite('https://dartmouthsports.com/news/2025/8/26/football').name).toBe('Dartmouth Athletics');
});

test('www. is left out of the host', () => {
  expect(sourceSite('https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/').name).toBe('U.S. Office of Personnel Management');
  expect(sourceSite('https://WWW.UVM.EDU/registrar')).toBe(SITES['uvm.edu']);
});

test('a subdomain without its own entry takes its parent domain’s name and logo', () => {
  expect(sourceSite('https://home.dartmouth.edu/news/2025/10/get-ready-homecoming-2025')).toBe(SITES['dartmouth.edu']);
  expect(sourceSite('https://data.bls.gov/cew/data/api/2024/1/area/33009.csv')).toBe(SITES['bls.gov']);
  expect(sourceSite('https://tigerweb.geo.census.gov/arcgis/rest/services').name).toBe('U.S. Census Bureau');
});

test('a host no entry has is its own name, with no logo (the globe)', () => {
  expect(sourceSite('https://example.org/events')).toEqual({ name: 'example.org', logo: null });
  expect(sourceSite('https://www.events.example.org:8443/a?b=c')).toEqual({ name: 'events.example.org', logo: null });
  // The lookup stops at two labels, so a bare top-level domain never matches.
  expect(sourceSite('https://edu/')).toEqual({ name: 'edu', logo: null });
});

test('a row’s chips: the site’s name, numbered from the second repeat, named by what they show, titled by their label', () => {
  const chips = sourceChips([
    { label: 'Dartmouth Registrar, 2025-26 key dates', url: 'https://registrar.dartmouth.edu/2025-2026-key-dates' },
    { label: 'Dartmouth Registrar, 2026-27 key dates', url: 'https://registrar.dartmouth.edu/2026-2027-key-dates' },
    { label: 'U.S. Office of Personnel Management', url: 'https://www.opm.gov/federal-holidays/' },
    { url: 'https://www.bls.gov/cew/' },
    { label: 'Sample events page', url: 'https://example.org/events' },
  ]);
  expect(chips.map(({ shown, name, title }) => ({ shown, name, title }))).toEqual([
    { shown: 'Dartmouth Registrar', name: 'Dartmouth Registrar. Source: Dartmouth Registrar, 2025-26 key dates', title: 'Dartmouth Registrar, 2025-26 key dates' },
    { shown: 'Dartmouth Registrar 2', name: 'Dartmouth Registrar 2. Source: Dartmouth Registrar, 2026-27 key dates', title: 'Dartmouth Registrar, 2026-27 key dates' },
    // A label that is the site's name says nothing more.
    { shown: 'U.S. Office of Personnel Management', name: 'U.S. Office of Personnel Management. Source', title: 'U.S. Office of Personnel Management' },
    // A source with no label (a town profile's, TownwiseAI's) is titled by its link.
    { shown: 'U.S. Bureau of Labor Statistics', name: 'U.S. Bureau of Labor Statistics. Source', title: 'https://www.bls.gov/cew/' },
    { shown: 'example.org', name: 'example.org. Source: Sample events page', title: 'Sample events page' },
  ]);
  expect(chips.map((chip) => chip.url)).toEqual([
    'https://registrar.dartmouth.edu/2025-2026-key-dates', 'https://registrar.dartmouth.edu/2026-2027-key-dates',
    'https://www.opm.gov/federal-holidays/', 'https://www.bls.gov/cew/', 'https://example.org/events',
  ]);
  expect(chips[4]?.logo).toBeNull();
});
