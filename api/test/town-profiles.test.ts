// The Townwise copy of the public town data (src/town-profiles.ts, spec 13): the twelve towns in order, internally
// consistent series, a source on every driver and date, and the researched gaps the spec's Data facts list.
import { describe, expect, it } from 'vitest';

import * as data from '../src/town-profiles.ts';
import { CAVEATS, INDEX_DEFINITION, NORTHEAST, SOURCES, TOWN_DATA_YEAR, TOWN_PROFILES } from '../src/town-profiles.ts';
import { TOWN_IDS } from '../src/towns.ts';

describe('town profiles', () => {
  it('cover exactly the twelve towns, in the order of towns.ts', () => {
    expect(TOWN_PROFILES.map((profile) => profile.townId)).toEqual([...TOWN_IDS]);
  });

  it('hold twelve months per series, gaps that are the county index minus the Northeast index, and the largest gap', () => {
    expect(NORTHEAST.index).toHaveLength(12);
    for (const { townId, series } of TOWN_PROFILES) {
      if (series === null) continue;
      expect({ townId, index: series.index.length, gap: series.gap.length }).toEqual({ townId, index: 12, gap: 12 });
      series.gap.forEach((gap, month) => {
        expect(Math.abs(gap - ((series.index[month] ?? Number.NaN) - (NORTHEAST.index[month] ?? Number.NaN)))).toBeLessThan(0.011);
      });
      const largest = series.gap.reduce((best, gap, month) => (Math.abs(gap) > Math.abs(series.gap[best] ?? 0) ? month : best), 0);
      expect(series.largestGap).toEqual({
        monthIndex: largest, countyIndex: series.index[largest], northeastIndex: NORTHEAST.index[largest], signedGap: series.gap[largest],
      });
      expect(series.domain[0]).toBeLessThan(series.domain[1]);
      expect(series.sourceUrls).toHaveLength(4);
      for (const url of series.sourceUrls) expect(url).toMatch(/^https:\/\/data\.bls\.gov\/cew\/data\/api\/2025\/[1-4]\/area\/\d{5}\.csv$/);
    }
  });

  // BLS withheld Nantucket County for 2025 Q2: no annual mean, so no index. Its series is null and the profile says why;
  // every other profile has its series and no reason.
  it('give a county BLS did not publish for the whole year a null series and the reason, and every other one none', () => {
    const missing = TOWN_PROFILES.filter((profile) => profile.series === null).map((profile) => [profile.townId, profile.seriesUnavailable]);
    expect(missing).toEqual([['nantucket-ma', 'BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.']]);
    for (const profile of TOWN_PROFILES) if (profile.series !== null) expect([profile.townId, profile.seriesUnavailable]).toEqual([profile.townId, null]);
  });

  // BLS withheld Rhode Island and Vermont for 2025 Q1, so the Northeast is the seven states published all year.
  it('state the seven-state Northeast wherever the definition is given', () => {
    expect(TOWN_DATA_YEAR).toBe(2025);
    expect(NORTHEAST.label).toBe('Northeast (sum of CT ME MA NH NJ NY PA)');
    expect(INDEX_DEFINITION).toContain('Northeast: the sum of seven state series (CT ME MA NH NJ NY PA); BLS withheld Rhode Island and Vermont for January to March 2025.');
  });

  it('give every driver and key date at least one https source, and key dates as ISO days', () => {
    for (const { drivers, dates } of TOWN_PROFILES) {
      for (const entry of [...drivers, ...dates]) {
        expect(entry.sourceUrls.length).toBeGreaterThan(0);
        for (const url of entry.sourceUrls) expect(url).toMatch(/^https:\/\/\S+$/);
      }
      for (const date of dates) {
        expect(date.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (date.end !== null) expect(date.end > date.start).toBe(true);
      }
    }
  });

  it('match the researched gaps: Conway, North Elba and Provincetown have one driver and no dates; Nantucket has neither', () => {
    const shape = Object.fromEntries(TOWN_PROFILES.map((p) => [p.townId, [p.drivers.length, p.dates.length]]));
    expect(shape).toMatchObject({
      'conway-nh': [1, 0], 'north-elba-ny': [1, 0], 'provincetown-ma': [1, 0], 'nantucket-ma': [0, 0],
    });
    for (const id of ['hanover-nh', 'amherst-ma', 'ithaca-ny', 'burlington-vt', 'middlebury-vt', 'state-college-pa', 'bar-harbor-me', 'stowe-vt']) {
      expect(shape[id]).toEqual([2, 3]);
    }
  });

  it('carry the three caveats and only the employment source, and no em dash anywhere', () => {
    expect(CAVEATS).toEqual([
      'County, not town: each series covers the whole county.',
      'Employment is a stand-in for demand, not sales or covers.',
      'Historical public data, not a Townwise forecast.',
    ]);
    expect(SOURCES).toEqual([{ label: 'BLS QCEW open data area slices, NAICS 722, private ownership, 2025 (Northeast: CT ME MA NH NJ NY PA; RI and VT withheld for January to March)', url: 'https://www.bls.gov/cew/additional-resources/open-data/' }]);
    expect(JSON.stringify(data)).not.toContain(String.fromCharCode(0x2014));
  });
});
