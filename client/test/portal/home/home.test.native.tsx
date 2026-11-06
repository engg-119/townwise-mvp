jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
// Every function of the secure store is a mock, so the test can say none was called.
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { cleanup, fireEvent, screen } from 'expo-router/testing-library';

import type { Calendar } from '../../../src/portal/analytics/api';
import type { DayRecord } from '../../../src/portal/analytics/history';
import { LAST_YEAR_FOOTNOTE } from '../../../src/portal/analytics/week';
import { BAR_ORDER_BODY } from '../../../src/portal/home/BarOrder';
import { FORECAST_LINE, QUESTIONS_PLANNED } from '../../../src/portal/home/Home';
import { PEOPLE_PLANNED } from '../../../src/portal/home/ThisMonth';
import type { LocationSummary, MeResponse } from '../../../src/portal/schemas';
import { ACCESS, deferred, fakePortalApi, locationOf, meOf, offline, orgOf, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';

// P11 Home on native (home.md 2, D21): no SVG and no heatmap, so every section keeps its words and its table.
// Synthetic days only. Pillars: the In progress and Planned lines name what Townwise doesn't do yet and the
// coverage line says what the town calendar covers (T); comparisons state their day counts and the footnote
// defines "last year" and "usual" (E); the page writes nothing and stores nothing (P).

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 5, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

const PATH = '/api/org/locations/l1';
const CALENDAR = `${PATH}/calendar?from=2024-10-07&to=2026-11-30`;
const SATURDAY = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
// Sep 1, 2024 to Wed, Nov 4, 2026: Saturdays 40 busier; last week (Oct 26 to Nov 1, 2026) 10% up on its year.
const DAYS = run('2024-09-01', '2026-11-04', (date) => Math.round((SATURDAY(date) ? 140 : 100) * (date >= '2026-10-26' ? 1.1 : 1)));
const HAS_DAYS = { dayCount: 795, guestsDayCount: 795, netSalesDayCount: 795, firstDate: '2024-09-01', lastDate: '2026-11-04', missingDays: 0 };
const EVENTS = [
  holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'),
  townEvent({ start: '2026-11-07', title: 'Sample game' }),
  townEvent({ start: '2025-11-08', title: 'Sample game last year' }),
];
const NOTES = [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })];

function portal(options: {
  me?: MeResponse;
  days?: readonly DayRecord[];
  calendar?: Partial<Calendar>;
  locations?: LocationSummary[];
  /** The history read never answers. */
  pending?: boolean;
  history?: unknown;
} = {}): FakePortalApi {
  const me = options.me ?? meOf(ACCESS.member);
  const fake = analyticsFake({
    [`${PATH}/sales/history`]: options.history ?? historyBody(options.days ?? DAYS),
    [`${PATH}/notes`]: { notes: NOTES },
    [CALENDAR]: calendarBody({ events: EVENTS, ...options.calendar }),
  });
  const base = fake.json.bind(fake);
  if (options.pending === true) fake.json = (path, schema, opts) => (path.endsWith('/sales/history') ? deferred<never>().promise : base(path, schema, opts));
  const role = me.access.state === 'member' ? me.access.role : 'member';
  return fakePortalApi({ me, org: orgOf(role, options.locations), fallback: fake });
}

const NO_STORE = ['setItemAsync', 'getItemAsync', 'deleteItemAsync'] as const;

test('with history: the lead, this week with the calendar and past years, bar order, last week, this month and the history', async () => {
  const api = portal();
  await renderApp('/locations/l1', api);
  expect(await screen.findByRole('heading', { name: 'Week of Nov 2, 2026' })).toBeTruthy();
  expect(screen.getByText('From your sales through Wed, Nov 4, 2026 and Hanover’s researched calendar.')).toBeTruthy();
  expect(screen.getByText(FORECAST_LINE)).toBeTruthy();
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByText(QUESTIONS_PLANNED)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Ask TownwiseAI' })).toBeTruthy();

  // This week: the summary of last year's same week, then each day.
  expect(screen.getByRole('heading', { name: 'What’s on the calendar, and how this week went before' })).toBeTruthy();
  expect(screen.getByText('740')).toBeTruthy();
  expect(screen.getByText('Same week last year, Mon, Nov 3 to Sun, Nov 9, 2025. From all 7 days.')).toBeTruthy();
  expect(screen.getByText('Busiest last year: Sat, Nov 8, 2025.')).toBeTruthy();
  expect(screen.getByText('On the calendar this week: Sample game (Saturday).')).toBeTruthy();
  expect(screen.getByText('Sample game')).toBeTruthy();
  expect(screen.getByText('Your note: Private event, more guests than usual')).toBeTruthy();
  expect(screen.getByText('A rehearsal dinner.')).toBeTruthy();
  expect(screen.getByText('Sat, Nov 8, 2025: 140 guests')).toBeTruthy();
  expect(screen.getByText('Sample game last year')).toBeTruthy();
  expect(screen.getByText('Sat, Nov 9, 2024: 140 guests')).toBeTruthy();
  expect(screen.getByText('Today')).toBeTruthy();
  expect(screen.getAllByText('Nothing listed').length).toBeGreaterThan(0);
  expect(screen.getByText(LAST_YEAR_FOOTNOTE)).toBeTruthy();
  expect(screen.getByText('Hanover’s researched calendar covers Sep 14, 2026 to Jan 5, 2027 so far, plus US federal holidays.')).toBeTruthy();
  // This week's own days carry a figure only up to the last day of data.
  expect(screen.getAllByText('110 guests')).toHaveLength(3);

  // Bar order: Planned, no inputs, and one line of history.
  expect(screen.getByRole('heading', { name: 'Order suggestions are planned' })).toBeTruthy();
  expect(screen.getByText(BAR_ORDER_BODY)).toBeTruthy();
  expect(screen.getByText('Last year this week, Thursday to Sunday brought 59% of the week’s guests.')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();

  // Last week against the same week last year; no chart on native.
  expect(screen.getByText('Last week, Oct 26 to Nov 1')).toBeTruthy();
  expect(screen.getByText('Last week: 814 guests, 10% more than the same week last year (740), compared over 7 days.')).toBeTruthy();
  expect(screen.queryByText(/^Scale 0 to/)).toBeNull();

  // This month in Hanover.
  expect(screen.getByRole('heading', { name: 'This month in Hanover' })).toBeTruthy();
  expect(screen.getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  expect(screen.getByText('Food-service jobs in Grafton County, November 2024: 97.4 (2024 average = 100).')).toBeTruthy();
  expect(screen.getByText('County, not town. Employment is a stand-in for demand.')).toBeTruthy();
  expect(screen.getByText('Your November in past years')).toBeTruthy();
  expect(screen.getByText(/^\d+ guests a day over 30 days in 2025, /)).toBeTruthy();
  expect(screen.getByText(/^\d+ guests a day over 30 days in 2024, /)).toBeTruthy();
  expect(screen.getByText(PEOPLE_PLANNED)).toBeTruthy();
  expect(screen.getAllByText('Planned')).toHaveLength(3);

  // Your history; the heatmap is web only, and native says where to upload.
  expect(screen.getByRole('heading', { name: '795 days' })).toBeTruthy();
  expect(screen.getByText('Sep 1, 2024 to Nov 4, 2026. No missing days in between. Last upload Nov 4, 2026 by owner@example.com.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'See it in Analytics' })).toBeTruthy();
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();

  // Three reads, in parallel, and no write; nothing stored.
  const reads = api.calls.filter((call) => call.path.startsWith(PATH)).map((call) => call.path);
  expect(reads.sort()).toEqual([CALENDAR, `${PATH}/notes`, `${PATH}/sales/history`].sort());
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  for (const name of NO_STORE) expect(jest.mocked(SecureStore[name])).not.toHaveBeenCalled();
});

test('a term period shows once with its span and source; the one-day event takes the headline', async () => {
  const registrar = [{ label: 'Registrar', url: 'https://www.dartmouth.edu/reg/' }];
  const term = (start: string, end: string): ReturnType<typeof townEvent> => townEvent({
    id: `hanover-nh:${start}:term`, start, end, title: 'Fall term classes', kind: 'term', sources: registrar,
  });
  await renderApp('/locations/l1', portal({
    calendar: { events: [term('2024-09-16', '2024-11-19'), term('2025-09-15', '2025-11-18'), term('2026-09-14', '2026-11-17'), ...EVENTS] },
  }));
  expect(await screen.findByText('On the calendar this week: Sample game (Saturday).')).toBeTruthy();
  expect(screen.getByText('Fall term classes. Term, Sep 14 to Nov 17, 2026.')).toBeTruthy();
  // Not in any day's cell, this year or past years: the bare title appears nowhere.
  expect(screen.queryByText('Fall term classes')).toBeNull();
  // One source link under This week and one in This month's list, not one per day.
  expect(screen.getAllByRole('link', { name: 'Source: Registrar' })).toHaveLength(2);
});

test('show the numbers lists last year, two years ago and usual', async () => {
  await renderApp('/locations/l1', portal());
  await screen.findByText(FORECAST_LINE);
  const [first] = screen.getAllByRole('button', { name: /Show the numbers/ });
  if (first === undefined) throw new Error('no Show the numbers');
  await fireEvent.press(first);
  expect(screen.getByLabelText('This week’s days in past years')).toBeTruthy();
  expect(screen.getByText('Usual (last year)')).toBeTruthy();
});

test('the coverage line for Nantucket and for a town outside the twelve, with no county line for the latter', async () => {
  const nantucket = [locationOf('l1', 'Main Street Bar', { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }, { coverage: HAS_DAYS })];
  await renderApp('/locations/l1', portal({
    locations: nantucket, calendar: { town: { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }, researched: false, covers: null, events: [] },
  }));
  expect(await screen.findByText('Townwise’s Nantucket calendar has no researched town events yet. Only US federal holidays and your notes show here.')).toBeTruthy();
  expect(screen.getByText('From your sales through Wed, Nov 4, 2026 and US federal holidays.')).toBeTruthy();
  expect(screen.getByText('Nothing on the calendar this week.')).toBeTruthy();
  expect(screen.getByText(/^Food-service jobs in Nantucket County, November 2024: /)).toBeTruthy();
  await cleanup();

  const norwich = [locationOf('l1', 'Main Street Bar', { townId: null, name: 'Norwich', state: 'VT' }, { coverage: HAS_DAYS })];
  await renderApp('/locations/l1', portal({
    locations: norwich, calendar: { town: { townId: null, name: 'Norwich', state: 'VT' }, researched: false, covers: null, events: [] },
  }));
  expect(await screen.findByText('Townwise hasn’t researched Norwich, VT yet. Only US federal holidays and your notes show here.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'This month in Norwich' })).toBeTruthy();
  expect(screen.queryByText(/^Food-service jobs in /)).toBeNull();
});

test('last week: no recent days, no last year, and a partial week that names its day count', async () => {
  await renderApp('/locations/l1', portal({ days: DAYS.filter((day) => day.date <= '2026-10-20') }));
  expect(await screen.findByText('Your history ends Oct 20, 2026. Upload the days since to compare last week.')).toBeTruthy();
  await cleanup();

  await renderApp('/locations/l1', portal({ days: DAYS.filter((day) => day.date >= '2026-01-01') }));
  expect(await screen.findByText('No data for the same week last year, so there is nothing to compare yet.')).toBeTruthy();
  // No past year, so no summary and no "two years ago" column; the footnote still defines the terms.
  expect(screen.queryByText(/^Same week last year/)).toBeNull();
  expect(screen.queryByText('Two years ago')).toBeNull();
  await cleanup();

  await renderApp('/locations/l1', portal({ days: DAYS.filter((day) => day.date !== '2025-10-28' && day.date !== '2026-10-30') }));
  expect(await screen.findByText(/^Last week: [\d,]+ guests on the 5 days both weeks have, 10% more than the same days last year \([\d,]+\)\.$/)).toBeTruthy();
});

test('while needsHistory is true, the history step takes the place of the cards that need days, and this week still shows', async () => {
  const empty = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })];
  await renderApp('/locations/l1', portal({ me: meOf(ACCESS.admin), locations: empty, days: [] }));
  expect(await screen.findByRole('heading', { name: 'Add your sales history' })).toBeTruthy();
  expect(screen.getByText('No sales history yet. Home shows Hanover’s researched calendar and your notes.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'What’s on the calendar, and how this week went before' })).toBeTruthy();
  expect(screen.getByText('Sample game')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'This month in Hanover' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Order suggestions are planned' })).toBeNull();
  expect(screen.queryByText('Against the same week last year')).toBeNull();
  expect(screen.queryByText('Your history')).toBeNull();
  // With no days there are no past-year columns and no footnote about them.
  expect(screen.queryByText('Last year')).toBeNull();
  expect(screen.queryByText(LAST_YEAR_FOOTNOTE)).toBeNull();
});

test('no days here but another location has some: the cards stay, each saying so', async () => {
  await renderApp('/locations/l1', portal({ days: [] }));
  expect(await screen.findByText('No sales history yet for this location.')).toBeTruthy();
  expect(screen.getByText('No sales history yet, so there is nothing to compare.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Order suggestions are planned' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Add your sales history' })).toBeNull();
});

test('view-as shows the same page and writes nothing', async () => {
  const api = portal({ me: viewAsMe(ACCESS.member) });
  await renderApp('/locations/l1', api);
  expect(await screen.findByText(FORECAST_LINE)).toBeTruthy();
  expect(screen.getByText('Last week: 814 guests, 10% more than the same week last year (740), compared over 7 days.')).toBeTruthy();
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('loading names the location, and a failed read offers Try again', async () => {
  await renderApp('/locations/l1', portal({ pending: true }));
  expect(await screen.findByText('Loading Main Street Bar')).toBeTruthy();
  await cleanup();

  await renderApp('/locations/l1', portal({ history: offline() }));
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
});
