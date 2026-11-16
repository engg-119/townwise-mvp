import { countySeries, unavailableCounties } from '../../src/marketing/map/countyData';
import { townShapes } from '../../src/marketing/map/geometry';
import { towns, type Town } from '../../src/marketing/map/towns';

const IDS = [
  'hanover-nh', 'amherst-ma', 'ithaca-ny', 'burlington-vt', 'middlebury-vt', 'state-college-pa',
  'bar-harbor-me', 'stowe-vt', 'conway-nh', 'north-elba-ny', 'provincetown-ma', 'nantucket-ma',
];
const TOWN_KEYS: (keyof Town)[] = [
  'id', 'name', 'state', 'kind', 'county', 'countyFips', 'anchor', 'note', 'drivers', 'dates',
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const facts = towns.flatMap((town) => [...town.drivers, ...town.dates].map((fact) => ({ id: town.id, ...fact })));
const copy = towns.flatMap((town) => [town.name, town.county, town.anchor, town.note, ...facts.filter((f) => f.id === town.id).map((f) => f.text)]);

test('the twelve fixed towns, each once, in list order', () => {
  expect(towns.map((town) => town.id)).toEqual(IDS);
  expect(new Set(towns.map((town) => town.id)).size).toBe(12);
  expect(towns.map((town) => town.kind)).toEqual([
    'college', 'college', 'college', 'college', 'college', 'college',
    'seasonal', 'seasonal', 'seasonal', 'event', 'seasonal', 'seasonal',
  ]);
  for (const town of towns) expect(town.id).toBe(`${town.name.toLowerCase().replace(/ /g, '-')}-${town.state.toLowerCase()}`);
});

test('every driver and every date carries https source URLs', () => {
  expect(facts.length).toBeGreaterThan(0);
  for (const fact of facts) {
    expect([fact.id, fact.sourceUrls.length > 0]).toEqual([fact.id, true]);
    for (const url of fact.sourceUrls) expect([url, new URL(url).protocol]).toEqual([url, 'https:']);
  }
});

test('dates are ISO days, and a range ends after it starts', () => {
  for (const { start, end } of towns.flatMap((town) => town.dates)) {
    expect(start).toMatch(ISO_DATE);
    if (end !== null) {
      expect(end).toMatch(ISO_DATE);
      expect(end > start).toBe(true);
    }
  }
});

test('no partner data: only public fields, and no sales figures', () => {
  for (const town of towns) expect(Object.keys(town)).toEqual(TOWN_KEYS);
  for (const text of copy) {
    expect(text).not.toMatch(/\$|\b(?:sales|revenue|covers|receipts|transactions)\b/i);
  }
});

test('copy uses typographic apostrophes and no dashes', () => {
  for (const text of copy) expect(text).not.toMatch(/['"\u2013\u2014]/);
});

// A county BLS did not publish for the whole year (Nantucket in 2025) is in unavailableCounties instead, with no values.
test('each town has its county series, or its county marked unavailable, and its map shape', () => {
  for (const town of towns) {
    const series = countySeries.find((county) => county.townId === town.id) ?? unavailableCounties.find((county) => county.townId === town.id);
    expect([town.id, series?.fips, series?.label]).toEqual([town.id, town.countyFips, `${town.county}, ${town.state}`]);
    expect(townShapes.some((shape) => shape.id === town.id)).toBe(true);
  }
});
