import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  countyShapes,
  FEATURED_D,
  stateShapes,
  STATES_D,
  townShapes,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from '../../src/marketing/map/geometry';
import { towns } from '../../src/marketing/map/towns';

const FILE = join(__dirname, '../../src/marketing/map/geometry.ts');
// The byte budget stated in the module's header (56 KiB). Raise it only on purpose.
const BUDGET_BYTES = 56 * 1024;

const NUM = String.raw`-?\d+(?:\.\d+)?`;
// Absolute M, L and Z commands only: every subpath is M x,y (L x,y)* Z.
const PATH = new RegExp(`^(?:M${NUM},${NUM}(?:L${NUM},${NUM})*Z)+$`);

function points(d: string): [number, number][] {
  return [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

const allPaths = [...stateShapes, ...countyShapes, ...townShapes].map((shape) => shape.d);

test('the nine Northeast states, the twelve featured counties and the twelve towns are present', () => {
  expect(stateShapes.map((state) => state.abbr)).toEqual(['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA']);
  expect(countyShapes.map((county) => county.fips)).toEqual(towns.map((town) => town.countyFips));
  expect(townShapes.map((town) => town.id)).toEqual(towns.map((town) => town.id));
});

test('every path is absolute M, L and Z data inside the viewBox', () => {
  for (const d of allPaths) {
    expect(d.startsWith('M')).toBe(true);
    expect(PATH.test(d)).toBe(true);
    const outside = points(d).filter(([x, y]) => x < 0 || x > VIEW_WIDTH || y < 0 || y > VIEW_HEIGHT);
    expect(outside).toEqual([]);
  }
  expect(STATES_D).toBe(stateShapes.map((state) => state.d).join(' '));
  expect(FEATURED_D).toBe(countyShapes.map((county) => county.d).join(' '));
});

test('each town bbox bounds its path and holds its centroid', () => {
  for (const { id, d, bbox, centroid } of townShapes) {
    const pts = points(d);
    const xs = pts.map(([x]) => x);
    const ys = pts.map(([, y]) => y);
    expect([id, ...bbox]).toEqual([id, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    const [cx, cy] = centroid;
    expect([id, cx > bbox[0] && cx < bbox[2] && cy > bbox[1] && cy < bbox[3]]).toEqual([id, true]);
  }
});

test('the state labels sit in the view, and only Rhode Island has a leader line', () => {
  for (const { label } of stateShapes) {
    expect(label[0] > 0 && label[0] < VIEW_WIDTH && label[1] > 0 && label[1] < VIEW_HEIGHT).toBe(true);
  }
  expect(stateShapes.filter((state) => state.leaderTo !== null).map((state) => state.abbr)).toEqual(['RI']);
});

test('the module stays within its byte budget', () => {
  expect(statSync(FILE).size).toBeLessThanOrEqual(BUDGET_BYTES);
});

test('the header records the source, vintage, projection, tolerance and generator', () => {
  const header = readFileSync(FILE, 'utf8').split('\nexport ')[0] ?? '';
  for (const fact of [
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/20',
    'https://registry.npmjs.org/us-atlas/-/us-atlas-3.0.1.tgz',
    'January 1, 2020 vintage',
    '2017 edition',
    'd3.geoConicConformal, standard parallels 40.5N and 46N, central meridian 74W',
    'tolerance of 0.02 units',
    'Generator: townwise-build/tools/build-marketing-data.mjs',
    'Byte budget: 56 KiB',
  ]) {
    expect(header).toContain(fact);
  }
});
