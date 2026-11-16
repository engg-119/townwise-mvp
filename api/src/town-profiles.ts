// GENERATED FILE: do not edit by hand. Generator: townwise-portal/tools/build-town-profiles.mjs (scratchpad tooling,
// not in the repo). The employment numbers and their meta were regenerated 2026-11-15 by a scratch script (also not in
// the repo) from the BLS QCEW open data area slices for 2025 Q1 to Q4 (the twelve counties and seven Northeast states,
// own_code 5, industry_code 722), the same values and rounding as client/src/marketing/map/countyData.ts, whose header
// states the rules; that script first rebuilt every 2024 value of the previous copy (townwise-home.json, schema 1, year
// 2024, generated 2026-11-03) exactly. Notes, anchors and driver and date text are the homepage’s
// (client/src/marketing/map/towns.ts on develop), which relabels brand names as plain descriptions and keeps every link;
// the generator checks each link and date against the data file.
//
// [CONFIRM: the Northeast is the 7 states BLS published for all of 2025; RI and VT were withheld for Jan to Mar]
// BLS withheld (disclosure code N) the Rhode Island and Vermont statewide series for 2025 Q1, so the Northeast is the
// sum of CT ME MA NH NJ NY PA, and the Nantucket County series for 2025 Q2, so Nantucket has no series (null) and
// says why in seriesUnavailable. Nothing withheld is estimated.
//
// Only what the Town tab, the Waiting page and the Forecast checklist show (spec 13, P4, P11, P15): the county’s 2025
// food-service employment index against the Northeast (BLS QCEW, NAICS 722, private), drivers and key dates with their
// sources, the caveats, the index definition and the employment source. County, not town; employment, not sales;
// historical public data, not a forecast. The map geometry and its sources stay with the homepage.

export const TOWN_DATA_YEAR = 2025;

export const INDEX_DEFINITION = 'Index: each month’s private food-service employment (BLS QCEW, NAICS 722) divided by that series’ 2025 monthly average, times 100. Northeast: the sum of seven state series (CT ME MA NH NJ NY PA); BLS withheld Rhode Island and Vermont for January to March 2025.';

export const CAVEATS: readonly string[] = [
  'County, not town: each series covers the whole county.',
  'Employment is a stand-in for demand, not sales or covers.',
  'Historical public data, not a Townwise forecast.',
];

export interface Source { readonly label: string; readonly url: string }

/** The employment data. Each county also lists its quarterly files in `series.sourceUrls`. */
export const SOURCES: readonly Source[] = [
  { label: 'BLS QCEW open data area slices, NAICS 722, private ownership, 2025 (Northeast: CT ME MA NH NJ NY PA; RI and VT withheld for January to March)', url: 'https://www.bls.gov/cew/additional-resources/open-data/' },
];

export interface Series { readonly label: string; readonly index: readonly number[] }

export const NORTHEAST: Series = {
  label: 'Northeast (sum of CT ME MA NH NJ NY PA)',
  index: [95.15, 94.95, 96.74, 98.27, 102.46, 104.53, 103.35, 103.56, 101.64, 100.79, 99.34, 99.21],
};

/** gap: the county index minus the Northeast index, in index points. largestGap.monthIndex: 0 (Jan) to 11 (Dec).
 *  domain: the chart scale fitted to this county. divergenceVsNortheast: the mean absolute gap;
 *  correlationWithNortheast: Pearson r of the two series. */
export interface CountySeries extends Series {
  readonly gap: readonly number[];
  readonly largestGap: { readonly monthIndex: number; readonly countyIndex: number; readonly northeastIndex: number; readonly signedGap: number };
  readonly domain: readonly [number, number];
  readonly divergenceVsNortheast: number;
  readonly correlationWithNortheast: number;
  readonly sourceUrls: readonly string[];
}

export interface Driver { readonly text: string; readonly sourceUrls: readonly string[] }

/** start and end are ISO dates; end is null for a single day. Dates print with their year (spec 13). */
export interface KeyDate { readonly text: string; readonly start: string; readonly end: string | null; readonly sourceUrls: readonly string[] }

/** county: the county the employment series covers. note: the one-line description the homepage shows. series is null
 *  when BLS did not publish the county for the whole data year, and seriesUnavailable then says why in one sentence;
 *  otherwise seriesUnavailable is null. */
export interface TownProfileData {
  readonly townId: string;
  readonly anchor: string;
  readonly note: string;
  readonly county: string;
  readonly series: CountySeries | null;
  readonly seriesUnavailable: string | null;
  readonly drivers: readonly Driver[];
  readonly dates: readonly KeyDate[];
}

/** The twelve towns, in the order of towns.ts. */
export const TOWN_PROFILES: readonly TownProfileData[] = [
  {
    townId: 'hanover-nh',
    anchor: 'Dartmouth College',
    note: 'Home of Dartmouth College.',
    county: 'Grafton County',
    series: {
      label: 'Grafton County, NH',
      index: [98.88, 100.13, 97.23, 92.43, 94.53, 105.66, 109.05, 108.9, 99.21, 102.16, 95.52, 96.29],
      gap: [3.73, 5.18, 0.49, -5.84, -7.93, 1.13, 5.7, 5.34, -2.43, 1.37, -3.82, -2.92],
      largestGap: { monthIndex: 4, countyIndex: 94.53, northeastIndex: 102.46, signedGap: -7.93 },
      domain: [90, 110],
      divergenceVsNortheast: 3.82,
      correlationWithNortheast: 0.547,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/33009.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/33009.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/33009.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/33009.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'Fall term classes Sep 15 to Nov 18 2025; winter term Jan 5 to Mar 10 2026; spring term Mar 30 to Jun 3 2026',
        sourceUrls: [
          'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2025-2026-key-dates',
        ],
      },
      {
        text: 'Break between fall and winter terms (fall exams end Nov 26; winter classes begin Jan 5)',
        sourceUrls: [
          'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2025-2026-key-dates',
        ],
      },
    ],
    dates: [
      {
        text: 'Fall term classes begin',
        start: '2026-09-14',
        end: null,
        sourceUrls: [
          'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates',
        ],
      },
      {
        text: 'Fall term classes end',
        start: '2026-11-17',
        end: null,
        sourceUrls: [
          'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates',
        ],
      },
      {
        text: 'Winter term classes begin',
        start: '2027-01-05',
        end: null,
        sourceUrls: [
          'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates',
        ],
      },
    ],
  },
  {
    townId: 'amherst-ma',
    anchor: 'UMass Amherst, Amherst College, Hampshire College',
    note: 'Home of UMass Amherst, Amherst College and Hampshire College.',
    county: 'Hampshire County',
    series: {
      label: 'Hampshire County, MA',
      index: [90.33, 94.62, 95.51, 102.92, 103.59, 101.47, 99.21, 99.97, 102.67, 105.99, 102.35, 101.36],
      gap: [-4.82, -0.33, -1.23, 4.65, 1.13, -3.06, -4.14, -3.59, 1.03, 5.2, 3.01, 2.15],
      largestGap: { monthIndex: 9, countyIndex: 105.99, northeastIndex: 100.79, signedGap: 5.2 },
      domain: [90, 110],
      divergenceVsNortheast: 2.86,
      correlationWithNortheast: 0.644,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/25015.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/25015.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/25015.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/25015.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'UMass fall semester Sep 8 to Dec 15 2026; spring Feb 2 to May 12 2027',
        sourceUrls: [
          'https://www.umass.edu/registrar/academic-calendar',
        ],
      },
      {
        text: 'Amherst College fall classes Sep 1 to Dec 9 2026; spring Feb 1 to May 11 2027',
        sourceUrls: [
          'https://www.fivecolleges.edu/academic-calendars',
        ],
      },
    ],
    dates: [
      {
        text: 'UMass first day of fall classes',
        start: '2026-09-08',
        end: null,
        sourceUrls: [
          'https://www.umass.edu/registrar/academic-calendar',
        ],
      },
      {
        text: 'UMass last day of fall classes',
        start: '2026-12-15',
        end: null,
        sourceUrls: [
          'https://www.umass.edu/registrar/academic-calendar',
        ],
      },
      {
        text: 'UMass fall final exams',
        start: '2026-12-17',
        end: '2026-12-23',
        sourceUrls: [
          'https://www.umass.edu/registrar/academic-calendar',
        ],
      },
    ],
  },
  {
    townId: 'ithaca-ny',
    anchor: 'Cornell University, Ithaca College',
    note: 'Home of Cornell University and Ithaca College.',
    county: 'Tompkins County',
    series: {
      label: 'Tompkins County, NY',
      index: [87.28, 96.05, 94.66, 102.74, 108.1, 105.91, 101.76, 104.31, 103.09, 102.39, 97.86, 95.84],
      gap: [-7.87, 1.1, -2.08, 4.47, 5.64, 1.38, -1.59, 0.75, 1.45, 1.6, -1.48, -3.37],
      largestGap: { monthIndex: 0, countyIndex: 87.28, northeastIndex: 95.15, signedGap: -7.87 },
      domain: [85, 110],
      divergenceVsNortheast: 2.73,
      correlationWithNortheast: 0.831,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/36109.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/36109.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/36109.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/36109.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'Cornell fall instruction Aug 24 to Dec 7 2026; spring instruction Jan 25 to May 11 2027',
        sourceUrls: [
          'https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/',
        ],
      },
      {
        text: 'Ithaca College fall classes Aug 24 to Dec 8 2026; spring Jan 19 to May 4 2027',
        sourceUrls: [
          'https://www.ithaca.edu/academics/registrar/academic-calendars/2026-2027-academic-calendar',
        ],
      },
    ],
    dates: [
      {
        text: 'Cornell fall instruction begins',
        start: '2026-08-24',
        end: null,
        sourceUrls: [
          'https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/',
        ],
      },
      {
        text: 'Cornell last day of fall instruction',
        start: '2026-12-07',
        end: null,
        sourceUrls: [
          'https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/',
        ],
      },
      {
        text: 'Cornell spring instruction begins',
        start: '2027-01-25',
        end: null,
        sourceUrls: [
          'https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/',
        ],
      },
    ],
  },
  {
    townId: 'burlington-vt',
    anchor: 'University of Vermont, Champlain College',
    note: 'Home of the University of Vermont and Champlain College.',
    county: 'Chittenden County',
    series: {
      label: 'Chittenden County, VT',
      index: [97.07, 99.08, 95.81, 100.81, 103.09, 100.06, 100.47, 103.65, 103.4, 102.25, 99.32, 94.98],
      gap: [1.92, 4.13, -0.93, 2.54, 0.63, -4.47, -2.88, 0.09, 1.76, 1.46, -0.02, -4.23],
      largestGap: { monthIndex: 5, countyIndex: 100.06, northeastIndex: 104.53, signedGap: -4.47 },
      domain: [90, 105],
      divergenceVsNortheast: 2.09,
      correlationWithNortheast: 0.625,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/50007.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/50007.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/50007.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/50007.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'UVM fall classes Aug 31 to Dec 11 2026; spring Jan 19 to May 7 2027',
        sourceUrls: [
          'https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027',
        ],
      },
      {
        text: 'Champlain College fall classes Aug 24 to Dec 4 2026; spring Jan 11 to Apr 23 2027',
        sourceUrls: [
          'https://www.champlain.edu/office/registrar/registrar-resources/calendars/',
        ],
      },
    ],
    dates: [
      {
        text: 'UVM first day of fall classes',
        start: '2026-08-31',
        end: null,
        sourceUrls: [
          'https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027',
        ],
      },
      {
        text: 'UVM last day of fall classes',
        start: '2026-12-11',
        end: null,
        sourceUrls: [
          'https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027',
        ],
      },
      {
        text: 'UVM first day of spring classes',
        start: '2027-01-19',
        end: null,
        sourceUrls: [
          'https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027',
        ],
      },
    ],
  },
  {
    townId: 'middlebury-vt',
    anchor: 'Middlebury College',
    note: 'Home of Middlebury College.',
    county: 'Addison County',
    series: {
      label: 'Addison County, VT',
      index: [93.01, 88.59, 90.28, 94.44, 105.87, 107.43, 113.79, 111.84, 103.14, 100.41, 95.61, 95.61],
      gap: [-2.14, -6.36, -6.46, -3.83, 3.41, 2.9, 10.44, 8.28, 1.5, -0.38, -3.73, -3.6],
      largestGap: { monthIndex: 6, countyIndex: 113.79, northeastIndex: 103.35, signedGap: 10.44 },
      domain: [85, 115],
      divergenceVsNortheast: 4.42,
      correlationWithNortheast: 0.933,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/50001.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/50001.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/50001.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/50001.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'Fall term Sep 14 to Dec 14 2026; Winter Term Jan 4 to Jan 29 2027; spring term Feb 8 to May 10 2027',
        sourceUrls: [
          'https://www.middlebury.edu/college/academics/academic-calendars',
        ],
      },
      {
        text: 'Language Schools and Bread Loaf commencement events listed in summer',
        sourceUrls: [
          'https://www.middlebury.edu/college/academics/academic-calendars',
        ],
      },
    ],
    dates: [
      {
        text: 'Fall term classes begin',
        start: '2026-09-14',
        end: null,
        sourceUrls: [
          'https://www.middlebury.edu/college/academics/academic-calendars',
        ],
      },
      {
        text: 'Fall term classes end',
        start: '2026-12-14',
        end: null,
        sourceUrls: [
          'https://www.middlebury.edu/college/academics/academic-calendars',
        ],
      },
      {
        text: 'Winter Term classes begin',
        start: '2027-01-04',
        end: null,
        sourceUrls: [
          'https://www.middlebury.edu/college/academics/academic-calendars',
        ],
      },
    ],
  },
  {
    townId: 'state-college-pa',
    anchor: 'Penn State University Park',
    note: 'Home of Penn State’s University Park campus.',
    county: 'Centre County',
    series: {
      label: 'Centre County, PA',
      index: [90.74, 102.39, 102.07, 108.35, 94.58, 86.71, 89.24, 90.61, 106.86, 109.53, 110.18, 108.75],
      gap: [-4.41, 7.44, 5.33, 10.08, -7.88, -17.82, -14.11, -12.95, 5.22, 8.74, 10.84, 9.54],
      largestGap: { monthIndex: 5, countyIndex: 86.71, northeastIndex: 104.53, signedGap: -17.82 },
      domain: [85, 115],
      divergenceVsNortheast: 9.53,
      correlationWithNortheast: -0.39,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/42027.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/42027.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/42027.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/42027.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'Fall 2026 classes Aug 24 to Dec 11; spring 2027 classes Jan 11 to Apr 30',
        sourceUrls: [
          'https://www.registrar.psu.edu/academic-calendars/2026-27.cfm',
        ],
      },
      {
        text: 'Commencement weekends (December 20 2026 and May 7 to 9 2027, dates may vary among campuses per registrar footnote)',
        sourceUrls: [
          'https://www.registrar.psu.edu/academic-calendars/2026-27.cfm',
        ],
      },
    ],
    dates: [
      {
        text: 'Fall semester classes begin',
        start: '2026-08-24',
        end: null,
        sourceUrls: [
          'https://www.registrar.psu.edu/academic-calendars/2026-27.cfm',
        ],
      },
      {
        text: 'Fall semester classes end',
        start: '2026-12-11',
        end: null,
        sourceUrls: [
          'https://www.registrar.psu.edu/academic-calendars/2026-27.cfm',
        ],
      },
      {
        text: 'Fall final exams',
        start: '2026-12-14',
        end: '2026-12-18',
        sourceUrls: [
          'https://www.registrar.psu.edu/academic-calendars/2026-27.cfm',
        ],
      },
    ],
  },
  {
    townId: 'bar-harbor-me',
    anchor: 'Acadia National Park gateway, cruise ship port',
    note: 'Gateway to Acadia National Park and a cruise ship port.',
    county: 'Hancock County',
    series: {
      label: 'Hancock County, ME',
      index: [51.97, 51.05, 52.84, 61.23, 104.57, 142.39, 159.64, 162.47, 147.71, 133.08, 72.05, 60.99],
      gap: [-43.18, -43.9, -43.9, -37.04, 2.11, 37.86, 56.29, 58.91, 46.07, 32.29, -27.29, -38.22],
      largestGap: { monthIndex: 7, countyIndex: 162.47, northeastIndex: 103.56, signedGap: 58.91 },
      domain: [50, 165],
      divergenceVsNortheast: 38.92,
      correlationWithNortheast: 0.893,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/23009.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/23009.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/23009.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/23009.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'Acadia NP recreation visits by month, NPS IRMA Stats: 2024 Aug 795,332 vs Dec 14,960; 2025 Aug 844,268 vs Dec 11,980; 2024 annual 3,961,661',
        sourceUrls: [
          'https://irmaservices.nps.gov/v3/rest/stats/visitation?unitCodes=ACAD&startMonth=1&startYear=2024&endMonth=12&endYear=2024',
          'https://irmaservices.nps.gov/v3/rest/stats/visitation?unitCodes=ACAD&startMonth=1&startYear=2025&endMonth=12&endYear=2025',
        ],
      },
      {
        text: '2026 cruise season: a local news site, citing the Town of Bar Harbor, reports 67 scheduled ship visits and roughly 50,000 possible passengers (if no visits are canceled and ships sail at lower-berth capacity); calls by two ships of one cruise line run Aug 26 to Oct 14 2026',
        sourceUrls: [
          'https://barharborstory.com/2026/04/30/how-many-cruise-ships-are-actually-heading-to-bar-harbor-this-year/',
          'https://www.barharbormaine.gov/190/Cruise-Ship-Information',
        ],
      },
    ],
    dates: [
      {
        text: 'One cruise ship’s first scheduled 2026 call',
        start: '2026-08-26',
        end: null,
        sourceUrls: [
          'https://barharborstory.com/2026/04/30/how-many-cruise-ships-are-actually-heading-to-bar-harbor-this-year/',
        ],
      },
      {
        text: 'One cruise ship’s last scheduled 2026 call',
        start: '2026-10-14',
        end: null,
        sourceUrls: [
          'https://barharborstory.com/2026/04/30/how-many-cruise-ships-are-actually-heading-to-bar-harbor-this-year/',
        ],
      },
      {
        text: 'Acadia NP peak recreation-visit months (July and August 2025: 797,030 and 844,268)',
        start: '2025-07-01',
        end: '2025-08-31',
        sourceUrls: [
          'https://irmaservices.nps.gov/v3/rest/stats/visitation?unitCodes=ACAD&startMonth=1&startYear=2025&endMonth=12&endYear=2025',
        ],
      },
    ],
  },
  {
    townId: 'stowe-vt',
    anchor: 'Ski resort, fall foliage',
    note: 'A ski resort in winter, foliage in the fall.',
    county: 'Lamoille County',
    series: {
      label: 'Lamoille County, VT',
      index: [107.82, 103.89, 99, 84.23, 85.02, 102.58, 110.88, 112.1, 103.71, 101.53, 86.85, 102.4],
      gap: [12.67, 8.94, 2.26, -14.04, -17.44, -1.95, 7.53, 8.54, 2.07, 0.74, -12.49, 3.19],
      largestGap: { monthIndex: 4, countyIndex: 85.02, northeastIndex: 102.46, signedGap: -17.44 },
      domain: [80, 115],
      divergenceVsNortheast: 7.66,
      correlationWithNortheast: 0.12,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/50015.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/50015.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/50015.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/50015.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'The ski resort’s 2025/26 season: target opening Sat Nov 22 2025 (the operator’s release of Oct 27 2025); it opened Fri Nov 21 2025, a day early (a ski news report)',
        sourceUrls: [
          'https://news.vailresorts.com/stowe-okemo-mount-snow-opening-day',
          'https://www.tetongravity.com/stowe-mountain-resort-kicks-off-season-with-massive-early-opening/',
        ],
      },
      {
        text: 'Fall foliage: leaves start changing in northern states by mid-September; a regional forecast had much of New England at or near peak by Oct 11 2025 (regional, not Stowe-specific). A Vermont news report on Oct 22 2026 showed much of Vermont past peak.',
        sourceUrls: [
          'https://www.vermontpublic.org/npr-news/2025-09-22/when-will-fall-foliage-peak-near-you-here-are-some-leaf-peeping-predictions',
          'https://vtdigger.org/2026/10/22/stick-season-approaches-but-a-beautiful-weekend-ahead-across-vermont/',
        ],
      },
    ],
    dates: [
      {
        text: 'The ski resort’s target opening day',
        start: '2025-11-22',
        end: null,
        sourceUrls: [
          'https://news.vailresorts.com/stowe-okemo-mount-snow-opening-day',
        ],
      },
      {
        text: 'The ski resort’s actual opening day',
        start: '2025-11-21',
        end: null,
        sourceUrls: [
          'https://www.tetongravity.com/stowe-mountain-resort-kicks-off-season-with-massive-early-opening/',
        ],
      },
      {
        text: 'A ski school’s 90th anniversary weekend begins',
        start: '2025-12-10',
        end: null,
        sourceUrls: [
          'https://news.vailresorts.com/stowe-okemo-mount-snow-opening-day',
        ],
      },
    ],
  },
  {
    townId: 'conway-nh',
    anchor: 'White Mountains, outlet shopping',
    note: 'North Conway, the White Mountains and outlet shopping.',
    county: 'Carroll County',
    series: {
      label: 'Carroll County, NH',
      index: [90.93, 89.07, 88.08, 86.41, 95.81, 112.54, 126.65, 124.67, 102.67, 99.3, 92.12, 91.76],
      gap: [-4.22, -5.88, -8.66, -11.86, -6.65, 8.01, 23.3, 21.11, 1.03, -1.49, -7.22, -7.45],
      largestGap: { monthIndex: 6, countyIndex: 126.65, northeastIndex: 103.35, signedGap: 23.3 },
      domain: [85, 130],
      divergenceVsNortheast: 8.91,
      correlationWithNortheast: 0.795,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/33003.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/33003.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/33003.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/33003.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: '2025 local foliage reports: Kancamagus Highway and Pinkham/Crawford Notches nearing or at peak (report of Oct 3 2025); Pinkham Notch a bit past peak and Crawford Notch well past peak (Columbus Day weekend report, photos taken within 24 hours of Oct 8, labeled 10/9/25). The week-1 report described the North Conway area itself as predominantly green, so the color was in the notches and on the Kancamagus, not necessarily in town',
        sourceUrls: [
          'https://northconwaynh.com/foliage-report-oct-week-1-2025/',
          'https://northconwaynh.com/foliage-report-oct-week2-2025/',
        ],
      },
    ],
    dates: [],
  },
  {
    townId: 'north-elba-ny',
    anchor: 'Olympic venues, large events',
    note: 'Lake Placid village, its Olympic venues and large events.',
    county: 'Essex County',
    series: {
      label: 'Essex County, NY',
      index: [95.28, 93.73, 85.02, 73.12, 82.43, 113.47, 127.87, 125.63, 108.82, 110.89, 88.64, 95.11],
      gap: [0.13, -1.22, -11.72, -25.15, -20.03, 8.94, 24.52, 22.07, 7.18, 10.1, -10.7, -4.1],
      largestGap: { monthIndex: 3, countyIndex: 73.12, northeastIndex: 98.27, signedGap: -25.15 },
      domain: [70, 130],
      divergenceVsNortheast: 12.16,
      correlationWithNortheast: 0.623,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/36031.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/36031.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/36031.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/36031.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'The Lake Placid triathlon: Sunday July 19 2026 (27th edition; the course spans Lake Placid, Keene, Wilmington, Au Sable Forks and Jay); next race listed July 25 2027',
        sourceUrls: [
          'https://www.roostadk.com/news/2026/ironman-lake-placid-takes-place-july-19',
          'https://www.lakeplacid.com/events/ironman-lake-placid',
        ],
      },
    ],
    dates: [],
  },
  {
    townId: 'provincetown-ma',
    anchor: 'Outer Cape summer season',
    note: 'The Outer Cape’s summer season.',
    county: 'Barnstable County',
    series: {
      label: 'Barnstable County, MA',
      index: [69.93, 67.98, 71.12, 79.05, 103.55, 132.86, 152.01, 150.45, 118.09, 100.33, 79.43, 75.2],
      gap: [-25.22, -26.97, -25.62, -19.22, 1.09, 28.33, 48.66, 46.89, 16.45, -0.46, -19.91, -24.01],
      largestGap: { monthIndex: 6, countyIndex: 152.01, northeastIndex: 103.35, signedGap: 48.66 },
      domain: [65, 155],
      divergenceVsNortheast: 23.57,
      correlationWithNortheast: 0.894,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2025/1/area/25001.csv',
        'https://data.bls.gov/cew/data/api/2025/2/area/25001.csv',
        'https://data.bls.gov/cew/data/api/2025/3/area/25001.csv',
        'https://data.bls.gov/cew/data/api/2025/4/area/25001.csv',
      ],
    },
    seriesUnavailable: null,
    drivers: [
      {
        text: 'The town’s carnival week, 2026: Aug 15 to Aug 22, parade Thursday Aug 20 (confirmed by the organizer, the town’s business guild; the chamber page retrieved showed a prior-year parade date)',
        sourceUrls: [
          'https://www.ptown.org/carnival/',
          'https://outxout.com/blog/provincetown-carnival-2026',
        ],
      },
    ],
    dates: [],
  },
  {
    townId: 'nantucket-ma',
    anchor: 'Island summer season',
    note: 'An island with a summer season.',
    county: 'Nantucket County',
    series: null,
    seriesUnavailable: 'BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.',
    drivers: [],
    dates: [],
  },
];
