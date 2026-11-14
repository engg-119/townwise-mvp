// GENERATED FILE: do not edit by hand. Generator: townwise-build/tools/build-marketing-data.mjs (scratchpad tooling, not in the repo).
// Input: townwise-home.json (schema 1, generated 2026-11-03); every value is copied exactly.
//
// Provenance: BLS Quarterly Census of Employment and Wages (QCEW), NAICS 722 (food services and drinking
// places), private ownership, 2024, county level, from the open data area slices
// (https://www.bls.gov/cew/additional-resources/open-data/). Each county lists its quarterly files in sourceUrls.
// Index: each month's employment over the series' 2024 monthly mean, times 100. The Northeast is the sum of
// the nine state series (CT ME MA NH RI VT NJ NY PA). gap is the county index minus the Northeast index, in
// index points. County, not town; employment, not sales; historical public data, not a forecast.

export const DATA_YEAR = 2024;
export const MONTHS: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const INDEX_DEFINITION = 'Index: each month’s private food-service employment (BLS QCEW, NAICS 722) divided by that series’ 2024 monthly average, times 100. Northeast: the sum of the nine state series.';
export const CAVEATS: readonly string[] = [
  'County, not town: each series covers the whole county.',
  'Employment is a stand-in for demand, not sales or covers.',
  'Historical public data, not a Townwise forecast.',
];

export interface Source {
  label: string;
  url: string;
}

// The full source list for the map's notes: the employment data, then the map geometry.
export const SOURCES: readonly Source[] = [
  {
    label: 'BLS QCEW open data area slices, NAICS 722, private ownership, 2024',
    url: 'https://www.bls.gov/cew/additional-resources/open-data/',
  },
  {
    label: 'Census TIGERweb Census 2020 areal hydrography (water removed from town outlines)',
    url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/Hydro/MapServer/1',
  },
  {
    label: 'Census TIGERweb Census 2020 county subdivisions',
    url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/20',
  },
  {
    label: 'us-atlas 3.0.1 state and county boundaries',
    url: 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/README.md',
  },
];

export interface Series {
  label: string;
  index: readonly number[];
}

export type TownGroup = 'college' | 'seasonalEvent';

// largestGap: the month (0 to 11) of the county's largest gap with the Northeast. domain: the fitted chart
// scale. divergenceVsNortheast: the mean absolute gap; correlationWithNortheast: Pearson r of the two series.
export interface CountySeries extends Series {
  fips: string;
  townId: string;
  group: TownGroup;
  gap: readonly number[];
  largestGap: { monthIndex: number; countyIndex: number; northeastIndex: number; signedGap: number };
  divergenceVsNortheast: number;
  correlationWithNortheast: number;
  domain: readonly [number, number];
  sourceUrls: readonly string[];
}

export const northeastSeries: Series = {
  label: 'Northeast (sum of CT ME MA NH RI VT NJ NY PA)',
  index: [94.68, 95.18, 96.88, 98.69, 102.21, 105, 103.51, 103.21, 101.58, 100.31, 99.16, 99.59],
};

export const countySeries: readonly CountySeries[] = [
  {
    fips: '33009',
    label: 'Grafton County, NH',
    townId: 'hanover-nh',
    group: 'college',
    index: [99.08, 102.37, 96.2, 93.55, 94.95, 104.24, 109.06, 107.41, 98.49, 100.09, 97.43, 97.11],
    gap: [4.4, 7.19, -0.68, -5.14, -7.26, -0.76, 5.55, 4.2, -3.09, -0.22, -1.73, -2.48],
    largestGap: { monthIndex: 4, countyIndex: 94.95, northeastIndex: 102.21, signedGap: -7.26 },
    divergenceVsNortheast: 3.56,
    correlationWithNortheast: 0.457,
    domain: [90, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/33009.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/33009.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/33009.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/33009.csv',
    ],
  },
  {
    fips: '25015',
    label: 'Hampshire County, MA',
    townId: 'amherst-ma',
    group: 'college',
    index: [93.32, 98.51, 97.96, 102.87, 105.82, 101.58, 96.7, 97.43, 102.36, 103.03, 100.61, 99.79],
    gap: [-1.36, 3.33, 1.08, 4.18, 3.61, -3.42, -6.81, -5.78, 0.78, 2.72, 1.45, 0.2],
    largestGap: { monthIndex: 6, countyIndex: 96.7, northeastIndex: 103.51, signedGap: -6.81 },
    divergenceVsNortheast: 2.89,
    correlationWithNortheast: 0.409,
    domain: [90, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/25015.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/25015.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/25015.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/25015.csv',
    ],
  },
  {
    fips: '36109',
    label: 'Tompkins County, NY',
    townId: 'ithaca-ny',
    group: 'college',
    index: [83.97, 96.87, 97.47, 102.04, 105.41, 106.11, 100, 101.4, 103.69, 102.07, 101.75, 99.22],
    gap: [-10.71, 1.69, 0.59, 3.35, 3.2, 1.11, -3.51, -1.81, 2.11, 1.76, 2.59, -0.37],
    largestGap: { monthIndex: 0, countyIndex: 83.97, northeastIndex: 94.68, signedGap: -10.71 },
    divergenceVsNortheast: 2.73,
    correlationWithNortheast: 0.755,
    domain: [80, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/36109.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/36109.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/36109.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/36109.csv',
    ],
  },
  {
    fips: '50007',
    label: 'Chittenden County, VT',
    townId: 'burlington-vt',
    group: 'college',
    index: [94.71, 98.05, 95.12, 100.82, 101.74, 98.71, 101.45, 103.14, 104.11, 102.44, 100.2, 99.51],
    gap: [0.03, 2.87, -1.76, 2.13, -0.47, -6.29, -2.06, -0.07, 2.53, 2.13, 1.04, -0.08],
    largestGap: { monthIndex: 5, countyIndex: 98.71, northeastIndex: 105, signedGap: -6.29 },
    divergenceVsNortheast: 1.79,
    correlationWithNortheast: 0.669,
    domain: [90, 105],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/50007.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/50007.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/50007.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/50007.csv',
    ],
  },
  {
    fips: '50001',
    label: 'Addison County, VT',
    townId: 'middlebury-vt',
    group: 'college',
    index: [93.18, 92.92, 89.04, 93.57, 103.41, 109.1, 110.79, 110.4, 101.98, 100.17, 98.62, 96.81],
    gap: [-1.5, -2.26, -7.84, -5.12, 1.2, 4.1, 7.28, 7.19, 0.4, -0.14, -0.54, -2.78],
    largestGap: { monthIndex: 2, countyIndex: 89.04, northeastIndex: 96.88, signedGap: -7.84 },
    divergenceVsNortheast: 3.36,
    correlationWithNortheast: 0.915,
    domain: [85, 115],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/50001.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/50001.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/50001.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/50001.csv',
    ],
  },
  {
    fips: '42027',
    label: 'Centre County, PA',
    townId: 'state-college-pa',
    group: 'college',
    index: [103.41, 108.58, 105.98, 107.01, 94.04, 87.12, 88.07, 87.19, 102.67, 104.79, 106.33, 104.81],
    gap: [8.73, 13.4, 9.1, 8.32, -8.17, -17.88, -15.44, -16.02, 1.09, 4.48, 7.17, 5.22],
    largestGap: { monthIndex: 5, countyIndex: 87.12, northeastIndex: 105, signedGap: -17.88 },
    divergenceVsNortheast: 9.58,
    correlationWithNortheast: -0.824,
    domain: [85, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/42027.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/42027.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/42027.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/42027.csv',
    ],
  },
  {
    fips: '23009',
    label: 'Hancock County, ME',
    townId: 'bar-harbor-me',
    group: 'seasonalEvent',
    index: [52.53, 51.6, 54.68, 68.61, 102.34, 143.06, 160.88, 161.77, 145.58, 121.62, 75.95, 61.38],
    gap: [-42.15, -43.58, -42.2, -30.08, 0.13, 38.06, 57.37, 58.56, 44, 21.31, -23.21, -38.21],
    largestGap: { monthIndex: 7, countyIndex: 161.77, northeastIndex: 103.21, signedGap: 58.56 },
    divergenceVsNortheast: 36.57,
    correlationWithNortheast: 0.882,
    domain: [50, 165],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/23009.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/23009.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/23009.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/23009.csv',
    ],
  },
  {
    fips: '50015',
    label: 'Lamoille County, VT',
    townId: 'stowe-vt',
    group: 'seasonalEvent',
    index: [109.18, 105.73, 104.01, 88.51, 86.36, 101.94, 108.32, 107.37, 96.95, 100.91, 88.08, 102.63],
    gap: [14.5, 10.55, 7.13, -10.18, -15.85, -3.06, 4.81, 4.16, -4.63, 0.6, -11.08, 3.04],
    largestGap: { monthIndex: 4, countyIndex: 86.36, northeastIndex: 102.21, signedGap: -15.85 },
    divergenceVsNortheast: 7.47,
    correlationWithNortheast: -0.125,
    domain: [85, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/50015.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/50015.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/50015.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/50015.csv',
    ],
  },
  {
    fips: '33003',
    label: 'Carroll County, NH',
    townId: 'conway-nh',
    group: 'seasonalEvent',
    index: [94.34, 94.1, 91.34, 87.62, 94.58, 113.87, 124.9, 123.3, 100.45, 97.65, 87.98, 89.86],
    gap: [-0.34, -1.08, -5.54, -11.07, -7.63, 8.87, 21.39, 20.09, -1.13, -2.66, -11.18, -9.73],
    largestGap: { monthIndex: 6, countyIndex: 124.9, northeastIndex: 103.51, signedGap: 21.39 },
    divergenceVsNortheast: 8.39,
    correlationWithNortheast: 0.7,
    domain: [85, 125],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/33003.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/33003.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/33003.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/33003.csv',
    ],
  },
  {
    fips: '36031',
    label: 'Essex County, NY',
    townId: 'north-elba-ny',
    group: 'seasonalEvent',
    index: [92.62, 90.59, 86.96, 79.44, 86.62, 115.94, 139.77, 136.56, 109.27, 96.17, 79.86, 86.2],
    gap: [-2.06, -4.59, -9.92, -19.25, -15.59, 10.94, 36.26, 33.35, 7.69, -4.14, -19.3, -13.39],
    largestGap: { monthIndex: 6, countyIndex: 139.77, northeastIndex: 103.51, signedGap: 36.26 },
    divergenceVsNortheast: 14.71,
    correlationWithNortheast: 0.657,
    domain: [75, 140],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/36031.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/36031.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/36031.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/36031.csv',
    ],
  },
  {
    fips: '25001',
    label: 'Barnstable County, MA',
    townId: 'provincetown-ma',
    group: 'seasonalEvent',
    index: [69.12, 67.72, 71.27, 79.04, 98.29, 133.61, 152.65, 149.95, 117.3, 102.43, 81.02, 77.62],
    gap: [-25.56, -27.46, -25.61, -19.65, -3.92, 28.61, 49.14, 46.74, 15.72, 2.12, -18.14, -21.97],
    largestGap: { monthIndex: 6, countyIndex: 152.65, northeastIndex: 103.51, signedGap: 49.14 },
    divergenceVsNortheast: 23.72,
    correlationWithNortheast: 0.881,
    domain: [65, 155],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/25001.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/25001.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/25001.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/25001.csv',
    ],
  },
  {
    fips: '25019',
    label: 'Nantucket County, MA',
    townId: 'nantucket-ma',
    group: 'seasonalEvent',
    index: [34.91, 32.36, 36.4, 49.14, 102.75, 159.61, 197, 191.69, 147.15, 116.49, 66.42, 66.07],
    gap: [-59.77, -62.82, -60.48, -49.55, 0.54, 54.61, 93.49, 88.48, 45.57, 16.18, -32.74, -33.52],
    largestGap: { monthIndex: 6, countyIndex: 197, northeastIndex: 103.51, signedGap: 93.49 },
    divergenceVsNortheast: 49.81,
    correlationWithNortheast: 0.898,
    domain: [30, 200],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2024/1/area/25019.csv',
      'https://data.bls.gov/cew/data/api/2024/2/area/25019.csv',
      'https://data.bls.gov/cew/data/api/2024/3/area/25019.csv',
      'https://data.bls.gov/cew/data/api/2024/4/area/25019.csv',
    ],
  },
];

// The largest absolute gap of the year, and the shared chart scale of each group.
export const MAX_ABS_GAP = 93.49;
export const GROUP_DOMAIN: Record<TownGroup, readonly [number, number]> = { college: [80, 115], seasonalEvent: [30, 200] };
