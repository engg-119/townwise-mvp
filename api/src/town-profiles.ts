// GENERATED FILE: do not edit by hand. Generator: townwise-portal/tools/build-town-profiles.mjs (scratchpad tooling,
// not in the repo). Numbers and meta come from townwise-home.json (schema 1, year 2024, generated 2026-11-03), copied
// exactly. Notes, anchors and driver and date text are the homepage’s (client/src/marketing/map/towns.ts on
// develop), which relabels brand names as plain descriptions and keeps every link; the generator checks each link and
// date against the data file.
//
// Only what the Town tab, the Waiting page and the Forecast checklist show (spec 13, P4, P11, P15): the county’s 2024
// food-service employment index against the Northeast (BLS QCEW, NAICS 722, private), drivers and key dates with their
// sources, the caveats, the index definition and the employment source. County, not town; employment, not sales;
// historical public data, not a forecast. The map geometry and its sources stay with the homepage.

export const TOWN_DATA_YEAR = 2024;

export const INDEX_DEFINITION = 'Index: each month’s private food-service employment (BLS QCEW, NAICS 722) divided by that series’ 2024 monthly average, times 100. Northeast: the sum of the nine state series.';

export const CAVEATS: readonly string[] = [
  'County, not town: each series covers the whole county.',
  'Employment is a stand-in for demand, not sales or covers.',
  'Historical public data, not a Townwise forecast.',
];

export interface Source { readonly label: string; readonly url: string }

/** The employment data. Each county also lists its quarterly files in `series.sourceUrls`. */
export const SOURCES: readonly Source[] = [
  { label: 'BLS QCEW open data area slices, NAICS 722, private ownership, 2024', url: 'https://www.bls.gov/cew/additional-resources/open-data/' },
];

export interface Series { readonly label: string; readonly index: readonly number[] }

export const NORTHEAST: Series = {
  label: 'Northeast (sum of CT ME MA NH RI VT NJ NY PA)',
  index: [94.68, 95.18, 96.88, 98.69, 102.21, 105, 103.51, 103.21, 101.58, 100.31, 99.16, 99.59],
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

/** county: the county the employment series covers. note: the one-line description the homepage shows. */
export interface TownProfileData {
  readonly townId: string;
  readonly anchor: string;
  readonly note: string;
  readonly county: string;
  readonly series: CountySeries;
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
      index: [99.08, 102.37, 96.2, 93.55, 94.95, 104.24, 109.06, 107.41, 98.49, 100.09, 97.43, 97.11],
      gap: [4.4, 7.19, -0.68, -5.14, -7.26, -0.76, 5.55, 4.2, -3.09, -0.22, -1.73, -2.48],
      largestGap: { monthIndex: 4, countyIndex: 94.95, northeastIndex: 102.21, signedGap: -7.26 },
      domain: [90, 110],
      divergenceVsNortheast: 3.56,
      correlationWithNortheast: 0.457,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/33009.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/33009.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/33009.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/33009.csv',
      ],
    },
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
      index: [93.32, 98.51, 97.96, 102.87, 105.82, 101.58, 96.7, 97.43, 102.36, 103.03, 100.61, 99.79],
      gap: [-1.36, 3.33, 1.08, 4.18, 3.61, -3.42, -6.81, -5.78, 0.78, 2.72, 1.45, 0.2],
      largestGap: { monthIndex: 6, countyIndex: 96.7, northeastIndex: 103.51, signedGap: -6.81 },
      domain: [90, 110],
      divergenceVsNortheast: 2.89,
      correlationWithNortheast: 0.409,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/25015.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/25015.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/25015.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/25015.csv',
      ],
    },
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
      index: [83.97, 96.87, 97.47, 102.04, 105.41, 106.11, 100, 101.4, 103.69, 102.07, 101.75, 99.22],
      gap: [-10.71, 1.69, 0.59, 3.35, 3.2, 1.11, -3.51, -1.81, 2.11, 1.76, 2.59, -0.37],
      largestGap: { monthIndex: 0, countyIndex: 83.97, northeastIndex: 94.68, signedGap: -10.71 },
      domain: [80, 110],
      divergenceVsNortheast: 2.73,
      correlationWithNortheast: 0.755,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/36109.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/36109.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/36109.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/36109.csv',
      ],
    },
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
      index: [94.71, 98.05, 95.12, 100.82, 101.74, 98.71, 101.45, 103.14, 104.11, 102.44, 100.2, 99.51],
      gap: [0.03, 2.87, -1.76, 2.13, -0.47, -6.29, -2.06, -0.07, 2.53, 2.13, 1.04, -0.08],
      largestGap: { monthIndex: 5, countyIndex: 98.71, northeastIndex: 105, signedGap: -6.29 },
      domain: [90, 105],
      divergenceVsNortheast: 1.79,
      correlationWithNortheast: 0.669,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/50007.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/50007.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/50007.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/50007.csv',
      ],
    },
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
      index: [93.18, 92.92, 89.04, 93.57, 103.41, 109.1, 110.79, 110.4, 101.98, 100.17, 98.62, 96.81],
      gap: [-1.5, -2.26, -7.84, -5.12, 1.2, 4.1, 7.28, 7.19, 0.4, -0.14, -0.54, -2.78],
      largestGap: { monthIndex: 2, countyIndex: 89.04, northeastIndex: 96.88, signedGap: -7.84 },
      domain: [85, 115],
      divergenceVsNortheast: 3.36,
      correlationWithNortheast: 0.915,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/50001.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/50001.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/50001.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/50001.csv',
      ],
    },
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
      index: [103.41, 108.58, 105.98, 107.01, 94.04, 87.12, 88.07, 87.19, 102.67, 104.79, 106.33, 104.81],
      gap: [8.73, 13.4, 9.1, 8.32, -8.17, -17.88, -15.44, -16.02, 1.09, 4.48, 7.17, 5.22],
      largestGap: { monthIndex: 5, countyIndex: 87.12, northeastIndex: 105, signedGap: -17.88 },
      domain: [85, 110],
      divergenceVsNortheast: 9.58,
      correlationWithNortheast: -0.824,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/42027.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/42027.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/42027.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/42027.csv',
      ],
    },
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
      index: [52.53, 51.6, 54.68, 68.61, 102.34, 143.06, 160.88, 161.77, 145.58, 121.62, 75.95, 61.38],
      gap: [-42.15, -43.58, -42.2, -30.08, 0.13, 38.06, 57.37, 58.56, 44, 21.31, -23.21, -38.21],
      largestGap: { monthIndex: 7, countyIndex: 161.77, northeastIndex: 103.21, signedGap: 58.56 },
      domain: [50, 165],
      divergenceVsNortheast: 36.57,
      correlationWithNortheast: 0.882,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/23009.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/23009.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/23009.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/23009.csv',
      ],
    },
    drivers: [
      {
        text: 'Acadia NP recreation visits by month, NPS IRMA Stats: 2024 Aug 795,332 vs Dec 14,960; 2025 Aug 844,268 vs Dec 11,980; 2024 annual 3,961,661',
        sourceUrls: [
          'https://irmaservices.nps.gov/v3/rest/stats/visitation?unitCodes=ACAD&startMonth=1&startYear=2024&endMonth=12&endYear=2024',
          'https://irmaservices.nps.gov/v3/rest/stats/visitation?unitCodes=ACAD&startMonth=1&startYear=2025&endMonth=12&endYear=2025',
        ],
      },
      {
        text: '2026 cruise season: a local news site, citing the Town of Bar Harbor, reports 67 scheduled ship visits and roughly 50,000 possible passengers (if no visits are cancelled and ships sail at lower-berth capacity); calls by two ships of one cruise line run Aug 26 to Oct 14 2026',
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
      index: [109.18, 105.73, 104.01, 88.51, 86.36, 101.94, 108.32, 107.37, 96.95, 100.91, 88.08, 102.63],
      gap: [14.5, 10.55, 7.13, -10.18, -15.85, -3.06, 4.81, 4.16, -4.63, 0.6, -11.08, 3.04],
      largestGap: { monthIndex: 4, countyIndex: 86.36, northeastIndex: 102.21, signedGap: -15.85 },
      domain: [85, 110],
      divergenceVsNortheast: 7.47,
      correlationWithNortheast: -0.125,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/50015.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/50015.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/50015.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/50015.csv',
      ],
    },
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
      index: [94.34, 94.1, 91.34, 87.62, 94.58, 113.87, 124.9, 123.3, 100.45, 97.65, 87.98, 89.86],
      gap: [-0.34, -1.08, -5.54, -11.07, -7.63, 8.87, 21.39, 20.09, -1.13, -2.66, -11.18, -9.73],
      largestGap: { monthIndex: 6, countyIndex: 124.9, northeastIndex: 103.51, signedGap: 21.39 },
      domain: [85, 125],
      divergenceVsNortheast: 8.39,
      correlationWithNortheast: 0.7,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/33003.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/33003.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/33003.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/33003.csv',
      ],
    },
    drivers: [
      {
        text: '2025 local foliage reports: Kancamagus Highway and Pinkham/Crawford Notches nearing or at peak (report of Oct 3 2025); Pinkham Notch a bit past peak and Crawford Notch well past peak (Columbus Day weekend report, photos taken within 24 hours of Oct 8, labelled 10/9/25). The week-1 report described the North Conway area itself as predominantly green, so the color was in the notches and on the Kancamagus, not necessarily in town',
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
      index: [92.62, 90.59, 86.96, 79.44, 86.62, 115.94, 139.77, 136.56, 109.27, 96.17, 79.86, 86.2],
      gap: [-2.06, -4.59, -9.92, -19.25, -15.59, 10.94, 36.26, 33.35, 7.69, -4.14, -19.3, -13.39],
      largestGap: { monthIndex: 6, countyIndex: 139.77, northeastIndex: 103.51, signedGap: 36.26 },
      domain: [75, 140],
      divergenceVsNortheast: 14.71,
      correlationWithNortheast: 0.657,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/36031.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/36031.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/36031.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/36031.csv',
      ],
    },
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
      index: [69.12, 67.72, 71.27, 79.04, 98.29, 133.61, 152.65, 149.95, 117.3, 102.43, 81.02, 77.62],
      gap: [-25.56, -27.46, -25.61, -19.65, -3.92, 28.61, 49.14, 46.74, 15.72, 2.12, -18.14, -21.97],
      largestGap: { monthIndex: 6, countyIndex: 152.65, northeastIndex: 103.51, signedGap: 49.14 },
      domain: [65, 155],
      divergenceVsNortheast: 23.72,
      correlationWithNortheast: 0.881,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/25001.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/25001.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/25001.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/25001.csv',
      ],
    },
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
    series: {
      label: 'Nantucket County, MA',
      index: [34.91, 32.36, 36.4, 49.14, 102.75, 159.61, 197, 191.69, 147.15, 116.49, 66.42, 66.07],
      gap: [-59.77, -62.82, -60.48, -49.55, 0.54, 54.61, 93.49, 88.48, 45.57, 16.18, -32.74, -33.52],
      largestGap: { monthIndex: 6, countyIndex: 197, northeastIndex: 103.51, signedGap: 93.49 },
      domain: [30, 200],
      divergenceVsNortheast: 49.81,
      correlationWithNortheast: 0.898,
      sourceUrls: [
        'https://data.bls.gov/cew/data/api/2024/1/area/25019.csv',
        'https://data.bls.gov/cew/data/api/2024/2/area/25019.csv',
        'https://data.bls.gov/cew/data/api/2024/3/area/25019.csv',
        'https://data.bls.gov/cew/data/api/2024/4/area/25019.csv',
      ],
    },
    drivers: [],
    dates: [],
  },
];
