// GENERATED FILE: do not edit by hand. Generator: a scratch script run 2026-11-15 (scratchpad tooling, not in the repo).
// Inputs: the BLS QCEW open data area slices for 2025 Q1 to Q4 (each county's sourceUrls below, and the same files for
// the seven state areas 09000 23000 25000 33000 34000 36000 42000), the row with own_code 5 and industry_code 722,
// month1 to month3_emplvl. Before writing any 2025 value, the same script rebuilt every value of the previous 2024 copy
// (townwise-home.json, schema 1, generated 2026-11-03, Northeast of nine states) from the 2024 slices, exactly. Labels,
// towns and groups are unchanged. Rounding: index to 2 places; gap is the rounded county index minus the rounded
// Northeast index; divergenceVsNortheast is the mean absolute gap to 2 places, half to even (2025 has two exact ties,
// Lamoille 7.655 and Essex 12.155, so 7.66 and 12.16); correlationWithNortheast is Pearson r of the two rounded series
// to 3 places; domain is the county and Northeast values out to multiples of 5.
//
// [CONFIRM: the Northeast is the 7 states BLS published for all of 2025; RI and VT were withheld for Jan to Mar]
// BLS withheld (disclosure code N) the Rhode Island and Vermont statewide series for 2025 Q1 and the Nantucket
// County series for 2025 Q2. So the Northeast is the sum of the seven states published all year, and Nantucket has
// no 2025 index (unavailableCounties). Nothing withheld is estimated.
//
// Provenance: BLS Quarterly Census of Employment and Wages (QCEW), NAICS 722 (food services and drinking
// places), private ownership, 2025, county level, from the open data area slices
// (https://www.bls.gov/cew/additional-resources/open-data/). Each county lists its quarterly files in sourceUrls.
// Index: each month's employment over the series' 2025 monthly mean, times 100. The Northeast is the sum of
// the seven state series CT ME MA NH NJ NY PA. gap is the county index minus the Northeast index, in
// index points. County, not town; employment, not sales; historical public data, not a forecast.

export const DATA_YEAR = 2025;
export const MONTHS: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const INDEX_DEFINITION = 'Index: each month’s private food-service employment (BLS QCEW, NAICS 722) divided by that series’ 2025 monthly average, times 100. Northeast: the sum of seven state series (CT ME MA NH NJ NY PA); BLS withheld Rhode Island and Vermont for January to March 2025.';
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
    label: 'BLS QCEW open data area slices, NAICS 722, private ownership, 2025 (Northeast: CT ME MA NH NJ NY PA; RI and VT withheld for January to March)',
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

// A county BLS did not publish for every month of the data year (a quarter withheld, disclosure code N). With no
// annual mean there is no index, so it has no series: only its quarterly files and the reason, said plainly.
export interface UnavailableCounty {
  fips: string;
  label: string;
  townId: string;
  group: TownGroup;
  reason: string;
  sourceUrls: readonly string[];
}

export const northeastSeries: Series = {
  label: 'Northeast (sum of CT ME MA NH NJ NY PA)',
  index: [95.15, 94.95, 96.74, 98.27, 102.46, 104.53, 103.35, 103.56, 101.64, 100.79, 99.34, 99.21],
};

export const countySeries: readonly CountySeries[] = [
  {
    fips: '33009',
    label: 'Grafton County, NH',
    townId: 'hanover-nh',
    group: 'college',
    index: [98.88, 100.13, 97.23, 92.43, 94.53, 105.66, 109.05, 108.9, 99.21, 102.16, 95.52, 96.29],
    gap: [3.73, 5.18, 0.49, -5.84, -7.93, 1.13, 5.7, 5.34, -2.43, 1.37, -3.82, -2.92],
    largestGap: { monthIndex: 4, countyIndex: 94.53, northeastIndex: 102.46, signedGap: -7.93 },
    divergenceVsNortheast: 3.82,
    correlationWithNortheast: 0.547,
    domain: [90, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/33009.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/33009.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/33009.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/33009.csv',
    ],
  },
  {
    fips: '25015',
    label: 'Hampshire County, MA',
    townId: 'amherst-ma',
    group: 'college',
    index: [90.33, 94.62, 95.51, 102.92, 103.59, 101.47, 99.21, 99.97, 102.67, 105.99, 102.35, 101.36],
    gap: [-4.82, -0.33, -1.23, 4.65, 1.13, -3.06, -4.14, -3.59, 1.03, 5.2, 3.01, 2.15],
    largestGap: { monthIndex: 9, countyIndex: 105.99, northeastIndex: 100.79, signedGap: 5.2 },
    divergenceVsNortheast: 2.86,
    correlationWithNortheast: 0.644,
    domain: [90, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/25015.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/25015.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/25015.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/25015.csv',
    ],
  },
  {
    fips: '36109',
    label: 'Tompkins County, NY',
    townId: 'ithaca-ny',
    group: 'college',
    index: [87.28, 96.05, 94.66, 102.74, 108.1, 105.91, 101.76, 104.31, 103.09, 102.39, 97.86, 95.84],
    gap: [-7.87, 1.1, -2.08, 4.47, 5.64, 1.38, -1.59, 0.75, 1.45, 1.6, -1.48, -3.37],
    largestGap: { monthIndex: 0, countyIndex: 87.28, northeastIndex: 95.15, signedGap: -7.87 },
    divergenceVsNortheast: 2.73,
    correlationWithNortheast: 0.831,
    domain: [85, 110],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/36109.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/36109.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/36109.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/36109.csv',
    ],
  },
  {
    fips: '50007',
    label: 'Chittenden County, VT',
    townId: 'burlington-vt',
    group: 'college',
    index: [97.07, 99.08, 95.81, 100.81, 103.09, 100.06, 100.47, 103.65, 103.4, 102.25, 99.32, 94.98],
    gap: [1.92, 4.13, -0.93, 2.54, 0.63, -4.47, -2.88, 0.09, 1.76, 1.46, -0.02, -4.23],
    largestGap: { monthIndex: 5, countyIndex: 100.06, northeastIndex: 104.53, signedGap: -4.47 },
    divergenceVsNortheast: 2.09,
    correlationWithNortheast: 0.625,
    domain: [90, 105],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/50007.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/50007.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/50007.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/50007.csv',
    ],
  },
  {
    fips: '50001',
    label: 'Addison County, VT',
    townId: 'middlebury-vt',
    group: 'college',
    index: [93.01, 88.59, 90.28, 94.44, 105.87, 107.43, 113.79, 111.84, 103.14, 100.41, 95.61, 95.61],
    gap: [-2.14, -6.36, -6.46, -3.83, 3.41, 2.9, 10.44, 8.28, 1.5, -0.38, -3.73, -3.6],
    largestGap: { monthIndex: 6, countyIndex: 113.79, northeastIndex: 103.35, signedGap: 10.44 },
    divergenceVsNortheast: 4.42,
    correlationWithNortheast: 0.933,
    domain: [85, 115],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/50001.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/50001.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/50001.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/50001.csv',
    ],
  },
  {
    fips: '42027',
    label: 'Centre County, PA',
    townId: 'state-college-pa',
    group: 'college',
    index: [90.74, 102.39, 102.07, 108.35, 94.58, 86.71, 89.24, 90.61, 106.86, 109.53, 110.18, 108.75],
    gap: [-4.41, 7.44, 5.33, 10.08, -7.88, -17.82, -14.11, -12.95, 5.22, 8.74, 10.84, 9.54],
    largestGap: { monthIndex: 5, countyIndex: 86.71, northeastIndex: 104.53, signedGap: -17.82 },
    divergenceVsNortheast: 9.53,
    correlationWithNortheast: -0.39,
    domain: [85, 115],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/42027.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/42027.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/42027.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/42027.csv',
    ],
  },
  {
    fips: '23009',
    label: 'Hancock County, ME',
    townId: 'bar-harbor-me',
    group: 'seasonalEvent',
    index: [51.97, 51.05, 52.84, 61.23, 104.57, 142.39, 159.64, 162.47, 147.71, 133.08, 72.05, 60.99],
    gap: [-43.18, -43.9, -43.9, -37.04, 2.11, 37.86, 56.29, 58.91, 46.07, 32.29, -27.29, -38.22],
    largestGap: { monthIndex: 7, countyIndex: 162.47, northeastIndex: 103.56, signedGap: 58.91 },
    divergenceVsNortheast: 38.92,
    correlationWithNortheast: 0.893,
    domain: [50, 165],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/23009.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/23009.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/23009.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/23009.csv',
    ],
  },
  {
    fips: '50015',
    label: 'Lamoille County, VT',
    townId: 'stowe-vt',
    group: 'seasonalEvent',
    index: [107.82, 103.89, 99, 84.23, 85.02, 102.58, 110.88, 112.1, 103.71, 101.53, 86.85, 102.4],
    gap: [12.67, 8.94, 2.26, -14.04, -17.44, -1.95, 7.53, 8.54, 2.07, 0.74, -12.49, 3.19],
    largestGap: { monthIndex: 4, countyIndex: 85.02, northeastIndex: 102.46, signedGap: -17.44 },
    divergenceVsNortheast: 7.66,
    correlationWithNortheast: 0.12,
    domain: [80, 115],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/50015.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/50015.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/50015.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/50015.csv',
    ],
  },
  {
    fips: '33003',
    label: 'Carroll County, NH',
    townId: 'conway-nh',
    group: 'seasonalEvent',
    index: [90.93, 89.07, 88.08, 86.41, 95.81, 112.54, 126.65, 124.67, 102.67, 99.3, 92.12, 91.76],
    gap: [-4.22, -5.88, -8.66, -11.86, -6.65, 8.01, 23.3, 21.11, 1.03, -1.49, -7.22, -7.45],
    largestGap: { monthIndex: 6, countyIndex: 126.65, northeastIndex: 103.35, signedGap: 23.3 },
    divergenceVsNortheast: 8.91,
    correlationWithNortheast: 0.795,
    domain: [85, 130],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/33003.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/33003.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/33003.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/33003.csv',
    ],
  },
  {
    fips: '36031',
    label: 'Essex County, NY',
    townId: 'north-elba-ny',
    group: 'seasonalEvent',
    index: [95.28, 93.73, 85.02, 73.12, 82.43, 113.47, 127.87, 125.63, 108.82, 110.89, 88.64, 95.11],
    gap: [0.13, -1.22, -11.72, -25.15, -20.03, 8.94, 24.52, 22.07, 7.18, 10.1, -10.7, -4.1],
    largestGap: { monthIndex: 3, countyIndex: 73.12, northeastIndex: 98.27, signedGap: -25.15 },
    divergenceVsNortheast: 12.16,
    correlationWithNortheast: 0.623,
    domain: [70, 130],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/36031.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/36031.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/36031.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/36031.csv',
    ],
  },
  {
    fips: '25001',
    label: 'Barnstable County, MA',
    townId: 'provincetown-ma',
    group: 'seasonalEvent',
    index: [69.93, 67.98, 71.12, 79.05, 103.55, 132.86, 152.01, 150.45, 118.09, 100.33, 79.43, 75.2],
    gap: [-25.22, -26.97, -25.62, -19.22, 1.09, 28.33, 48.66, 46.89, 16.45, -0.46, -19.91, -24.01],
    largestGap: { monthIndex: 6, countyIndex: 152.01, northeastIndex: 103.35, signedGap: 48.66 },
    divergenceVsNortheast: 23.57,
    correlationWithNortheast: 0.894,
    domain: [65, 155],
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/25001.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/25001.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/25001.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/25001.csv',
    ],
  },
];

export const unavailableCounties: readonly UnavailableCounty[] = [
  {
    fips: '25019',
    label: 'Nantucket County, MA',
    townId: 'nantucket-ma',
    group: 'seasonalEvent',
    reason: 'BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.',
    sourceUrls: [
      'https://data.bls.gov/cew/data/api/2025/1/area/25019.csv',
      'https://data.bls.gov/cew/data/api/2025/2/area/25019.csv',
      'https://data.bls.gov/cew/data/api/2025/3/area/25019.csv',
      'https://data.bls.gov/cew/data/api/2025/4/area/25019.csv',
    ],
  },
];

// The largest absolute gap of the year, and the shared chart scale of each group.
export const MAX_ABS_GAP = 58.91;
export const GROUP_DOMAIN: Record<TownGroup, readonly [number, number]> = { college: [85, 115], seasonalEvent: [50, 165] };
