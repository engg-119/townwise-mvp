import type { EstimatesAbout, PeopleInTown, PeoplePeriod } from '../../../src/portal/estimates/api';

// Synthetic bodies for the estimate reads: a Hanover location in November with term periods and no headcount, the
// model card with no forecast, and helpers to add a headcount or history. Every figure is made up; ids are
// low-entropy so the secret scanner never mistakes one for a key.

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const PEOPLE_PATH = `/api/org/locations/${LOCATION_ID}/people-in-town?from=2026-11-01&to=2026-11-30`;
export const ABOUT_PATH = `/api/org/locations/${LOCATION_ID}/estimates/about`;

export function period(fields: Partial<PeoplePeriod> & Pick<PeoplePeriod, 'from' | 'to' | 'fromWeekday' | 'toWeekday'>): PeoplePeriod {
  return {
    termState: 'in_session', termLabel: 'Fall term classes', termSourceIds: ['cal-1'], headcount: null, headcountWhy: 'no_population',
    events: [], ...fields,
  };
}

export const NOVEMBER: PeopleInTown = {
  available: true,
  reason: null,
  from: '2026-11-01',
  to: '2026-11-30',
  town: { name: 'Hanover', state: 'NH', kind: 'college' },
  timeZone: 'America/New_York',
  periods: [
    period({ from: '2026-11-01', fromWeekday: 'Sun', to: '2026-11-10', toWeekday: 'Tue' }),
    period({
      from: '2026-11-11', fromWeekday: 'Wed', to: '2026-11-11', toWeekday: 'Wed',
      events: [{ id: 'us:veterans-day:2026', title: 'Veterans Day', kind: 'holiday', attendanceHigh: null, sourceIds: ['cal-2'] }],
    }),
    period({ from: '2026-11-12', fromWeekday: 'Thu', to: '2026-11-17', toWeekday: 'Tue' }),
    period({ from: '2026-11-18', fromWeekday: 'Wed', to: '2026-11-19', toWeekday: 'Thu', termState: 'unknown', termLabel: null, termSourceIds: [], headcountWhy: 'no_term_dates' }),
    period({ from: '2026-11-20', fromWeekday: 'Fri', to: '2026-11-25', toWeekday: 'Wed', termState: 'finals', termLabel: 'Fall term finals' }),
    period({ from: '2026-11-26', fromWeekday: 'Thu', to: '2026-11-30', toWeekday: 'Mon', termState: 'unknown', termLabel: null, termSourceIds: [], headcountWhy: 'no_term_dates' }),
  ],
  season: [{ month: '2026-11', countyFoodServiceJobsIndex: 100, baseYear: 2024, county: 'Grafton County', sourceIds: ['bls-qcew'] }],
  visitors: [],
  yourHistory: { metric: 'guests', cells: [], first: null, last: null },
  sources: [
    { id: 'cal-1', label: 'Dartmouth Registrar', url: 'https://registrar.dartmouth.edu/calendars/test', confidence: 'high' },
    { id: 'cal-2', label: 'U.S. Office of Personnel Management', url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/', confidence: 'high' },
    { id: 'bls-qcew', label: 'BLS QCEW', url: 'https://www.bls.gov/cew/additional-resources/open-data/', confidence: 'high' },
  ],
  caveats: ['County, not town: the jobs index covers the whole county.'],
};

export const ABOUT: EstimatesAbout = {
  version: '2026-11-05',
  card: {
    estimates: 'Guests per day and per week, each as a range.',
    inputs: ['Your daily guests and net sales.', 'Your notes.'],
    cannotSee: ['Weather.', 'Your staffing.'],
    limits: ['The model was built for one restaurant.'],
    checked: 'Forecasts are saved before their days happen.',
    whoCanSee: 'Townwise staff only.',
  },
  location: { name: 'Test Taproom', town: { name: 'Hanover', state: 'NH' } },
  today: { date: '2026-11-05', weekday: 'Thu', timeZone: 'America/New_York', approximate: false },
  forecast: { run: null, live: null },
  calendar: { researched: true, covers: { from: '2025-01-06', to: '2027-01-05' } },
  people: { headcountInputs: [], sources: [] },
};
