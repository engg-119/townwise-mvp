import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAVEATS,
  countySeries,
  DATA_YEAR,
  GROUP_DOMAIN,
  INDEX_DEFINITION,
  MAX_ABS_GAP,
  MONTHS,
  northeastSeries,
  SOURCES,
} from '../../src/marketing/map/countyData';

const round2 = (v: number): number => Math.round(v * 100) / 100;
const series = [northeastSeries, ...countySeries];

function county(townId: string) {
  const found = countySeries.find((c) => c.townId === townId);
  if (!found) throw new Error(`no series for ${townId}`);
  return found;
}

test('every series has 12 finite monthly values for the data year', () => {
  expect(DATA_YEAR).toBe(2024);
  expect(MONTHS).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  expect(countySeries).toHaveLength(12);
  expect(new Set(countySeries.map((c) => c.fips)).size).toBe(12);
  for (const s of series) {
    expect([s.label, s.index.length]).toEqual([s.label, 12]);
    expect(s.index.every(Number.isFinite)).toBe(true);
  }
  for (const c of countySeries) {
    expect([c.label, c.gap.length]).toEqual([c.label, 12]);
    expect([c.divergenceVsNortheast, c.correlationWithNortheast, ...c.gap].every(Number.isFinite)).toBe(true);
  }
});

test('each index averages 100 over the year', () => {
  for (const s of series) {
    const mean = s.index.reduce((sum, v) => sum + v, 0) / 12;
    expect([s.label, Math.abs(mean - 100) < 0.05]).toEqual([s.label, true]);
  }
});

test('each gap is the county index minus the Northeast index', () => {
  for (const c of countySeries) {
    expect(c.gap).toEqual(c.index.map((v, m) => round2(v - (northeastSeries.index[m] ?? Number.NaN))));
  }
  expect(MAX_ABS_GAP).toBe(Math.max(...countySeries.flatMap((c) => c.gap.map(Math.abs))));
});

test('each largest gap is the largest absolute gap of its county', () => {
  for (const c of countySeries) {
    const m = c.largestGap.monthIndex;
    expect([c.label, c.gap[m], c.index[m], northeastSeries.index[m]]).toEqual([
      c.label, c.largestGap.signedGap, c.largestGap.countyIndex, c.largestGap.northeastIndex,
    ]);
    expect(Math.abs(c.largestGap.signedGap)).toBe(Math.max(...c.gap.map(Math.abs)));
  }
});

test('each chart scale holds its series in multiples of 5', () => {
  for (const c of countySeries) {
    const [lo, hi] = c.domain;
    const values = [...c.index, ...northeastSeries.index];
    expect([c.label, lo % 5, hi % 5, lo <= Math.min(...values), hi >= Math.max(...values)]).toEqual([c.label, 0, 0, true, true]);
    const [glo, ghi] = GROUP_DOMAIN[c.group];
    expect([c.label, glo <= lo, ghi >= hi]).toEqual([c.label, true, true]);
  }
});

// The map story ends on the reader's month with the counties furthest above and below the Northeast, so every
// month needs a county on each side.
test('every month has a county above the Northeast and one below it', () => {
  const sides = MONTHS.map((_, m) => {
    const gaps = countySeries.map((c) => c.gap[m] ?? Number.NaN);
    return [Math.max(...gaps) > 0, Math.min(...gaps) < 0];
  });
  expect(sides).toEqual(MONTHS.map(() => [true, true]));
});

test('the July gaps for Nantucket and State College match the data', () => {
  const july = 6;
  expect(northeastSeries.index[july]).toBe(103.51);
  const nantucket = county('nantucket-ma');
  expect([nantucket.label, nantucket.index[july], nantucket.gap[july]]).toEqual(['Nantucket County, MA', 197, 93.49]);
  const stateCollege = county('state-college-pa');
  expect([stateCollege.label, stateCollege.index[july], stateCollege.gap[july]]).toEqual(['Centre County, PA', 88.07, -15.44]);
});

test('the provenance is BLS QCEW, NAICS 722, private ownership, 2024, county level', () => {
  const header = readFileSync(join(__dirname, '../../src/marketing/map/countyData.ts'), 'utf8').split('\nexport ')[0] ?? '';
  for (const fact of ['BLS', 'QCEW', 'NAICS 722', 'private ownership', '2024', 'county level']) expect(header).toContain(fact);
  expect(SOURCES[0]).toEqual({
    label: 'BLS QCEW open data area slices, NAICS 722, private ownership, 2024',
    url: 'https://www.bls.gov/cew/additional-resources/open-data/',
  });
  for (const c of countySeries) {
    expect(c.sourceUrls).toEqual([1, 2, 3, 4].map((q) => `https://data.bls.gov/cew/data/api/2024/${String(q)}/area/${c.fips}.csv`));
  }
  for (const { url } of SOURCES) expect(new URL(url).protocol).toBe('https:');
});

test('the notes copy uses typographic apostrophes and no dashes', () => {
  for (const text of [INDEX_DEFINITION, ...CAVEATS, ...SOURCES.map((s) => s.label)]) {
    expect(text).not.toMatch(/['"\u2013\u2014]/);
  }
});
