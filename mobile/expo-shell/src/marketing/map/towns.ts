// GENERATED FILE: do not edit by hand. Generator: townwise-build/tools/build-marketing-data.mjs (scratchpad tooling, not in the repo).
// Input: townwise-home.json (schema 1, generated 2026-11-03) for the towns, their anchors,
// drivers and dated events, and ConsoleV2.dc.html for each town's note and for the relabels.
//
// The 12 fixed towns of the homepage map, in list order: six college towns, then the seasonal and event
// towns. Every driver and date is public and carries its source URLs. Labels that named a company or brand
// read as plain descriptions, as on the mockup; the links are unchanged. Drivers and dates are already cut to
// what the panel shows (one driver and no dates for a low-confidence town; otherwise up to two and three).
// No partner data.

export type TownKind = 'college' | 'seasonal' | 'event';

export interface Driver {
  text: string;
  sourceUrls: readonly string[];
}

// start and end are ISO dates; end is null for a single day.
export interface KeyDate {
  text: string;
  start: string;
  end: string | null;
  sourceUrls: readonly string[];
}

// county is the county the town's employment series covers (countyData.ts, by countyFips). anchor names the
// institutions or attractions that set the town's rhythm; note is the panel's one-line description.
export interface Town {
  id: string;
  name: string;
  state: string;
  kind: TownKind;
  county: string;
  countyFips: string;
  anchor: string;
  note: string;
  drivers: readonly Driver[];
  dates: readonly KeyDate[];
}

export const towns: readonly Town[] = [
  {
    id: 'hanover-nh',
    name: 'Hanover',
    state: 'NH',
    kind: 'college',
    county: 'Grafton County',
    countyFips: '33009',
    anchor: 'Dartmouth College',
    note: 'Home of Dartmouth College.',
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
    id: 'amherst-ma',
    name: 'Amherst',
    state: 'MA',
    kind: 'college',
    county: 'Hampshire County',
    countyFips: '25015',
    anchor: 'UMass Amherst, Amherst College, Hampshire College',
    note: 'Home of UMass Amherst, Amherst College and Hampshire College.',
    drivers: [
      {
        text: 'UMass fall semester Sep 8 to Dec 15 2026; spring Feb 2 to May 12 2027',
        sourceUrls: ['https://www.umass.edu/registrar/academic-calendar'],
      },
      {
        text: 'Amherst College fall classes Sep 1 to Dec 9 2026; spring Feb 1 to May 11 2027',
        sourceUrls: ['https://www.fivecolleges.edu/academic-calendars'],
      },
    ],
    dates: [
      {
        text: 'UMass first day of fall classes',
        start: '2026-09-08',
        end: null,
        sourceUrls: ['https://www.umass.edu/registrar/academic-calendar'],
      },
      {
        text: 'UMass last day of fall classes',
        start: '2026-12-15',
        end: null,
        sourceUrls: ['https://www.umass.edu/registrar/academic-calendar'],
      },
      {
        text: 'UMass fall final exams',
        start: '2026-12-17',
        end: '2026-12-23',
        sourceUrls: ['https://www.umass.edu/registrar/academic-calendar'],
      },
    ],
  },
  {
    id: 'ithaca-ny',
    name: 'Ithaca',
    state: 'NY',
    kind: 'college',
    county: 'Tompkins County',
    countyFips: '36109',
    anchor: 'Cornell University, Ithaca College',
    note: 'Home of Cornell University and Ithaca College.',
    drivers: [
      {
        text: 'Cornell fall instruction Aug 24 to Dec 7 2026; spring instruction Jan 25 to May 11 2027',
        sourceUrls: ['https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/'],
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
        sourceUrls: ['https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/'],
      },
      {
        text: 'Cornell last day of fall instruction',
        start: '2026-12-07',
        end: null,
        sourceUrls: ['https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/'],
      },
      {
        text: 'Cornell spring instruction begins',
        start: '2027-01-25',
        end: null,
        sourceUrls: ['https://courses.cornell.edu/enrollment-credit-requirements/academic-calendar/'],
      },
    ],
  },
  {
    id: 'burlington-vt',
    name: 'Burlington',
    state: 'VT',
    kind: 'college',
    county: 'Chittenden County',
    countyFips: '50007',
    anchor: 'University of Vermont, Champlain College',
    note: 'Home of the University of Vermont and Champlain College.',
    drivers: [
      {
        text: 'UVM fall classes Aug 31 to Dec 11 2026; spring Jan 19 to May 7 2027',
        sourceUrls: ['https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027'],
      },
      {
        text: 'Champlain College fall classes Aug 24 to Dec 4 2026; spring Jan 11 to Apr 23 2027',
        sourceUrls: ['https://www.champlain.edu/office/registrar/registrar-resources/calendars/'],
      },
    ],
    dates: [
      {
        text: 'UVM first day of fall classes',
        start: '2026-08-31',
        end: null,
        sourceUrls: ['https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027'],
      },
      {
        text: 'UVM last day of fall classes',
        start: '2026-12-11',
        end: null,
        sourceUrls: ['https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027'],
      },
      {
        text: 'UVM first day of spring classes',
        start: '2027-01-19',
        end: null,
        sourceUrls: ['https://www.uvm.edu/registrar/uvm-academic-calendar-2026-2027'],
      },
    ],
  },
  {
    id: 'middlebury-vt',
    name: 'Middlebury',
    state: 'VT',
    kind: 'college',
    county: 'Addison County',
    countyFips: '50001',
    anchor: 'Middlebury College',
    note: 'Home of Middlebury College.',
    drivers: [
      {
        text: 'Fall term Sep 14 to Dec 14 2026; Winter Term Jan 4 to Jan 29 2027; spring term Feb 8 to May 10 2027',
        sourceUrls: ['https://www.middlebury.edu/college/academics/academic-calendars'],
      },
      {
        text: 'Language Schools and Bread Loaf commencement events listed in summer',
        sourceUrls: ['https://www.middlebury.edu/college/academics/academic-calendars'],
      },
    ],
    dates: [
      {
        text: 'Fall term classes begin',
        start: '2026-09-14',
        end: null,
        sourceUrls: ['https://www.middlebury.edu/college/academics/academic-calendars'],
      },
      {
        text: 'Fall term classes end',
        start: '2026-12-14',
        end: null,
        sourceUrls: ['https://www.middlebury.edu/college/academics/academic-calendars'],
      },
      {
        text: 'Winter Term classes begin',
        start: '2027-01-04',
        end: null,
        sourceUrls: ['https://www.middlebury.edu/college/academics/academic-calendars'],
      },
    ],
  },
  {
    id: 'state-college-pa',
    name: 'State College',
    state: 'PA',
    kind: 'college',
    county: 'Centre County',
    countyFips: '42027',
    anchor: 'Penn State University Park',
    note: 'Home of Penn State’s University Park campus.',
    drivers: [
      {
        text: 'Fall 2026 classes Aug 24 to Dec 11; spring 2027 classes Jan 11 to Apr 30',
        sourceUrls: ['https://www.registrar.psu.edu/academic-calendars/2026-27.cfm'],
      },
      {
        text: 'Commencement weekends (December 20 2026 and May 7 to 9 2027, dates may vary among campuses per registrar footnote)',
        sourceUrls: ['https://www.registrar.psu.edu/academic-calendars/2026-27.cfm'],
      },
    ],
    dates: [
      {
        text: 'Fall semester classes begin',
        start: '2026-08-24',
        end: null,
        sourceUrls: ['https://www.registrar.psu.edu/academic-calendars/2026-27.cfm'],
      },
      {
        text: 'Fall semester classes end',
        start: '2026-12-11',
        end: null,
        sourceUrls: ['https://www.registrar.psu.edu/academic-calendars/2026-27.cfm'],
      },
      {
        text: 'Fall final exams',
        start: '2026-12-14',
        end: '2026-12-18',
        sourceUrls: ['https://www.registrar.psu.edu/academic-calendars/2026-27.cfm'],
      },
    ],
  },
  {
    id: 'bar-harbor-me',
    name: 'Bar Harbor',
    state: 'ME',
    kind: 'seasonal',
    county: 'Hancock County',
    countyFips: '23009',
    anchor: 'Acadia National Park gateway, cruise ship port',
    note: 'Gateway to Acadia National Park and a cruise ship port.',
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
    id: 'stowe-vt',
    name: 'Stowe',
    state: 'VT',
    kind: 'seasonal',
    county: 'Lamoille County',
    countyFips: '50015',
    anchor: 'Ski resort, fall foliage',
    note: 'A ski resort in winter, foliage in the fall.',
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
        sourceUrls: ['https://news.vailresorts.com/stowe-okemo-mount-snow-opening-day'],
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
        sourceUrls: ['https://news.vailresorts.com/stowe-okemo-mount-snow-opening-day'],
      },
    ],
  },
  {
    id: 'conway-nh',
    name: 'Conway',
    state: 'NH',
    kind: 'seasonal',
    county: 'Carroll County',
    countyFips: '33003',
    anchor: 'White Mountains, outlet shopping',
    note: 'North Conway, the White Mountains and outlet shopping.',
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
    id: 'north-elba-ny',
    name: 'North Elba',
    state: 'NY',
    kind: 'event',
    county: 'Essex County',
    countyFips: '36031',
    anchor: 'Olympic venues, large events',
    note: 'Lake Placid village, its Olympic venues and large events.',
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
    id: 'provincetown-ma',
    name: 'Provincetown',
    state: 'MA',
    kind: 'seasonal',
    county: 'Barnstable County',
    countyFips: '25001',
    anchor: 'Outer Cape summer season',
    note: 'The Outer Cape’s summer season.',
    drivers: [
      {
        text: 'The town’s carnival week, 2026: Aug 15 to Aug 22, parade Thursday Aug 20 (confirmed by the organizer, the town’s business guild; the chamber page retrieved showed a prior-year parade date)',
        sourceUrls: ['https://www.ptown.org/carnival/', 'https://outxout.com/blog/provincetown-carnival-2026'],
      },
    ],
    dates: [],
  },
  {
    id: 'nantucket-ma',
    name: 'Nantucket',
    state: 'MA',
    kind: 'seasonal',
    county: 'Nantucket County',
    countyFips: '25019',
    anchor: 'Island summer season',
    note: 'An island with a summer season.',
    drivers: [],
    dates: [],
  },
];
