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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as SecureStore from 'expo-secure-store';
import { StyleSheet } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import type { Calendar } from '../../../src/portal/analytics/api';
import type { DayRecord } from '../../../src/portal/analytics/history';
import { LAST_YEAR_FOOTNOTE } from '../../../src/portal/analytics/week';
import { REORDER_OVERVIEW } from '../../../src/portal/home/beside';
import { forecastLine } from '../../../src/portal/home/Home';
import { PEOPLE_HEAD } from '../../../src/portal/home/ThisMonth';
import type { LocationSummary, MeResponse } from '../../../src/portal/schemas';
import { theme } from '../../../src/theme';
import { ACCESS, deferred, fakePortalApi, LOCATIONS, locationOf, meOf, offline, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';
import { forecastDay, forecastOf, NO_FORECAST } from '../calendar/fakes';
import { NOVEMBER } from '../estimates/fakes';

// P11 Home on native (home.md 2, D21): no heatmap and no Last week chart, so those sections keep their words and their
// tables; This week's chart is the one Home draws on native too (owner request, 2026-11-18; week-chart.test.native.tsx).
// Synthetic days and a synthetic order board only. Pillars: the In progress and Planned lines name what Townwise doesn't do yet and the
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
// Sep 1, 2024 to Wed, Nov 4, 2026: Saturdays 40 busier; from Oct 26, 2026, 10% up on its year, so last week (the seven days
// before today, Oct 29 to Nov 4) is too.
const DAYS = run('2024-09-01', '2026-11-04', (date) => Math.round((SATURDAY(date) ? 140 : 100) * (date >= '2026-10-26' ? 1.1 : 1)));
const HAS_DAYS = { dayCount: 795, guestsDayCount: 795, netSalesDayCount: 795, firstDate: '2024-09-01', lastDate: '2026-11-04', missingDays: 0 };
const EVENTS = [
  holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'),
  townEvent({ start: '2026-11-07', title: 'Sample game' }),
  townEvent({ start: '2025-11-08', title: 'Sample game last year' }),
];
const NOTES = [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })];
const AGENT = `${PATH}/agent`;
const PEOPLE = `${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`;
const FORECAST = `${PATH}/forecast?from=2026-11-01&to=2026-11-30`;
const FORECAST_LINE = forecastLine('Main Street Bar');
const GAP = (from: string, to: string, dayCount: number) => ({ id: `gap_${from}_${to}`, kind: 'gap', from, to, dayCount });
/** GET .../orders: one next order per supplier, soonest first (api/src/orders/board.ts). */
const ORDER_LINE = {
  supplier: 'Sample distributor', unit: 'cases', neverRunOut: false, alternative: null, par: 2, mu: null, sigma: null, orderUpTo: null,
  target: 0.95, onHand: null, countAgeDays: null, confidence: 'low', dealSize: null, coveredDays: 0, why: 'No count, so this is the par.',
  sample: false, edit: null, rules: [],
};
const BOARD = {
  available: true, today: '2026-11-05', sample: false, missing: ['a recent count'],
  orders: [
    {
      supplierId: 's1', supplier: 'Sample brewery', cutoff: '2026-11-09', cutoffTime: '12:00', delivery: '2026-11-10', coversThrough: '2026-11-12',
      deadline: 'Order by Mon, Nov 9, 12:00pm. Tuesday’s delivery lasts until Thursday’s.',
      lines: [{ ...ORDER_LINE, itemId: 'keg', name: 'Sample keg', supplier: 'Sample brewery', unit: 'kegs', recommended: 0 }],
    },
    {
      supplierId: 's2', supplier: 'Sample distributor', cutoff: '2026-11-11', cutoffTime: '14:00', delivery: '2026-11-12', coversThrough: '2026-11-16',
      deadline: 'Order by Wed, Nov 11, 2:00pm. Thursday’s delivery lasts until Monday’s.',
      lines: [{ ...ORDER_LINE, itemId: 'lager', name: 'Sample lager', recommended: 6 }, { ...ORDER_LINE, itemId: 'seltzer', name: 'Sample seltzer', recommended: 3 }],
    },
  ],
};
const QUESTIONS = [
  { id: 'likely_closed_2026-05-23', kind: 'likely_closed', date: '2026-05-23', guests: 1, typicalGuests: 100 },
  GAP('2026-05-12', '2026-05-13', 2),
];

/** Two suggested closure rules (D46), in GET .../agent's shape (client/test/chat/agent-panel.json). */
const RULE_SUGGESTIONS = (JSON.parse(readFileSync(join(__dirname, '../../chat/agent-panel.json'), 'utf8')) as { panel: { ruleSuggestions: unknown[] } })
  .panel.ruleSuggestions;

function portal(options: {
  me?: MeResponse;
  days?: readonly DayRecord[];
  calendar?: Partial<Calendar>;
  locations?: LocationSummary[];
  /** The history read never answers. */
  pending?: boolean;
  history?: unknown;
  /** GET .../agent's body, or an error; two questions by default. */
  agent?: unknown;
  /** GET .../people-in-town's body for November, or an error. */
  people?: unknown;
  /** GET .../orders's body, or an error; the board above by default. */
  orders?: unknown;
  /** GET .../forecast's body for November, or an error; no published forecast by default. */
  forecast?: unknown;
} = {}): FakePortalApi {
  const me = options.me ?? meOf(ACCESS.member);
  const fake = analyticsFake({
    [`${PATH}/sales/history`]: options.history ?? historyBody(options.days ?? DAYS),
    [`${PATH}/notes`]: { notes: NOTES },
    [CALENDAR]: calendarBody({ events: EVENTS, ...options.calendar }),
    [AGENT]: options.agent ?? { questions: QUESTIONS, activity: [] },
    [PEOPLE]: options.people ?? NOVEMBER,
    [`${PATH}/orders`]: options.orders ?? BOARD,
    // The Ordering setup page, which the Bar order card links to, for a location that has saved none.
    [`${PATH}/orders/setup`]: { today: '2026-11-05', setup: null, coverage: null, itemCoverage: {}, counts: {}, itemsWithHistory: [] },
    [FORECAST]: options.forecast ?? NO_FORECAST,
    // Stored files are off, as in production today.
    [`${PATH}/imports/current`]: refusal(503, 'files_unavailable'),
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
  expect(await screen.findByRole('heading', { name: /^Welcome back/ })).toBeTruthy();
  expect(screen.getByText('From your sales through Wed, Nov 4, 2026 and Hanover’s researched calendar.')).toBeTruthy();
  expect(screen.getByText(FORECAST_LINE)).toBeTruthy();
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(await screen.findByRole('link', { name: '2 questions from TownwiseAI' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Ask TownwiseAI' })).toBeTruthy();

  // This week: the summary of the same 7 days last year, then each day from today.
  expect(screen.getByRole('heading', { name: 'What’s on the calendar, and how this week went before' })).toBeTruthy();
  expect(screen.getByText('740')).toBeTruthy();
  expect(screen.getByText('Same 7 days last year, Thu, Nov 6 to Wed, Nov 12, 2025. From all 7 days.')).toBeTruthy();
  expect(screen.getByText('Busiest last year: Sat, Nov 8, 2025 (140 guests).')).toBeTruthy();
  expect(screen.getByText('On the calendar this week: Sample game (Saturday), and 1 more.')).toBeTruthy();
  // The days are behind This week's Show the numbers, under its chart (owner request, 2026-11-18).
  const [weekNumbers] = screen.getAllByRole('button', { name: /Show the numbers/ });
  if (weekNumbers === undefined) throw new Error('no Show the numbers');
  await fireEvent.press(weekNumbers);
  // On Saturday's row, and as the next event at a glance.
  expect(screen.getAllByText('Sample game')).toHaveLength(2);
  expect(screen.getByText('Sat, Nov 7, 2026, in 2 days')).toBeTruthy();
  expect(screen.getByText('+10% against the same week last year (740), over all 7 days.')).toBeTruthy();
  // Friday's compact entry (D49): the note's words and its kind; its detail is in the Calendar and the day detail.
  expect(screen.getByText('Private event')).toBeTruthy();
  expect(screen.getAllByText('Your note').length).toBeGreaterThan(0);
  expect(screen.getByText('Sat, Nov 8, 2025: 140 guests')).toBeTruthy();
  expect(screen.getByText('Sample game last year')).toBeTruthy();
  expect(screen.getByText('Sat, Nov 9, 2024: 140 guests')).toBeTruthy();
  expect(screen.getByText('Today')).toBeTruthy();
  expect(screen.getAllByText('Nothing listed').length).toBeGreaterThan(0);
  expect(screen.getByText(LAST_YEAR_FOOTNOTE)).toBeTruthy();
  expect(screen.getByText('Hanover’s researched calendar covers Sep 14, 2026 to Jan 5, 2027 so far, plus US federal holidays.')).toBeTruthy();
  // This week starts today, after the last day of data, so none of its days has a figure of its own.
  expect(screen.queryByText('110 guests')).toBeNull();

  // Bar order: how many items the soonest order holds, its supplier and deadline, how many orders there are, what the
  // board lacks, no inputs, and one line of history.
  expect(await screen.findByRole('heading', { name: '0 items to order from Sample brewery' })).toBeTruthy();
  expect(screen.getByText('Order by Mon, Nov 9, 12:00pm. Tuesday’s delivery lasts until Thursday’s.')).toBeTruthy();
  expect(screen.getByText('The soonest of 2 orders, one per supplier. Orders lists them all.')).toBeTruthy();
  expect(screen.getByText('Townwise still can’t see a recent count.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Orders' })).toBeTruthy();
  // The selected day (today) against the same board: neither order's window holds Nov 5, so its Reorder part names
  // the soonest order and says the day is outside it, with the link to that day on Orders.
  expect(screen.getByText(
    'The next order from Sample brewery arrives Tue, Nov 10, 2026 and lasts until its next delivery, Thu, Nov 12, 2026. Thu, Nov 5, 2026 is outside it.',
  )).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open this day on Orders' })).toBeTruthy();
  expect(screen.getByText('Last year this week, Thursday to Sunday brought 59% of the week’s guests.')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();

  // Last week against the same week last year; no chart on native.
  expect(screen.getByText('Last week, Oct 29 to Nov 4')).toBeTruthy();
  expect(screen.getByText('Last week: 814 guests, 10% more than the same week last year (740), compared over 7 days.')).toBeTruthy();
  // The one scale on native is This week's chart's (owner request, 2026-11-18); Last week draws none.
  expect(screen.getAllByText(/^Scale 0 to/)).toHaveLength(1);
  expect(within(screen.getByLabelText('Last week')).queryByText(/^Scale 0 to/)).toBeNull();

  // This month in Hanover.
  expect(screen.getByRole('heading', { name: 'This month in Hanover' })).toBeTruthy();
  expect(screen.getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  // The county's jobs under their own heading, more or fewer said in words, the unit named.
  expect(screen.getByRole('heading', { name: 'Food-service jobs in Grafton County' })).toBeTruthy();
  expect(screen.getByText('4.5% fewer jobs in November 2025 than in an average month that year.')).toBeTruthy();
  expect(screen.getByText('County, not town. Employment is a stand-in for demand.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'U.S. Bureau of Labor Statistics. Source: U.S. Bureau of Labor Statistics, QCEW' })).toBeTruthy();
  expect(screen.queryByText(/average = 100/)).toBeNull();
  expect(screen.getByText('Your November in past years')).toBeTruthy();
  expect(screen.getByText(/^\d+ guests a day over 30 days in 2025, /)).toBeTruthy();
  expect(screen.getByText(/^\d+ guests a day over 30 days in 2024, /)).toBeTruthy();
  // Who's in town: the honest no-number line with its Planned tag, then the term by time under headings, past days
  // left out, one row per run of days, and the term's source once, as a chip with its site's name.
  expect(screen.getByText(PEOPLE_HEAD)).toBeTruthy();
  expect(await screen.findByText('Fall term classes until Tue, Nov 17.')).toBeTruthy();
  expect(screen.getByText('Townwise can’t put a number on how many people are in Hanover yet.')).toBeTruthy();
  expect(screen.queryByText('A headcount from public counts is planned.')).toBeNull();
  expect(screen.queryByText('An estimate of how many people are in town each day is planned.')).toBeNull();
  expect(screen.getByRole('heading', { name: 'This week' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Later in November' })).toBeTruthy();
  expect(screen.getByText('Nov 20 to 25')).toBeTruthy();
  expect(screen.getByText('Fall term finals')).toBeTruthy();
  expect(screen.getByText('From Nov 26')).toBeTruthy();
  expect(screen.getAllByText('Townwise has no term dates')).toHaveLength(2);
  expect(screen.getByRole('link', { name: 'Dartmouth Registrar. Source' })).toBeTruthy();
  expect(screen.queryByText('registrar.dartmouth.edu')).toBeNull();
  expect(screen.queryByText(/County jobs are/)).toBeNull();
  // The headcount; Bar order and TownwiseAI's questions are no longer Planned.
  expect(screen.getAllByText('Planned')).toHaveLength(1);
  expect(screen.queryByText(/can’t see your stock/)).toBeNull();

  // Your history; the heatmap is web only, and native says where to upload.
  expect(screen.getByRole('heading', { name: '795 days' })).toBeTruthy();
  expect(screen.getByText('Sep 1, 2024 to Nov 4, 2026. No missing days in between. Last upload Nov 4, 2026 by owner@example.com.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'See it in Analytics' })).toBeTruthy();
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();

  // Three reads in parallel, then the questions, the business rules, the month's forecast, Last week's forecast (D42),
  // its people in town, the next orders and the location's calendars' events over the forecast's range (D49) on their
  // own: the board once, for Bar order and the selected day's Reorder part (#68 review C6); no write, nothing stored.
  const reads = api.calls.filter((call) => call.path.startsWith(PATH)).map((call) => call.path);
  expect(reads.sort()).toEqual([
    AGENT, CALENDAR, FORECAST, `${PATH}/forecast?from=2026-10-29&to=2026-11-04`, PEOPLE, `${PATH}/notes`, `${PATH}/rules`, `${PATH}/sales/history`,
    `${PATH}/orders`, `${PATH}/owner-calendars/events?from=2026-11-01&to=2026-11-30`,
  ].sort());
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  for (const name of NO_STORE) expect(jest.mocked(SecureStore[name])).not.toHaveBeenCalled();
});

test('tapping a day opens the calendar at that day', async () => {
  const { router } = await renderApp('/locations/l1', portal());
  // This month's selected day and This week's chosen day both start on today.
  expect(await screen.findAllByRole('heading', { name: 'Today, Thu, Nov 5, 2026' })).toHaveLength(2);
  expect(screen.getByText('Tap a day to open it in the Calendar.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the calendar' })).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Wed, Nov 11, 2026. This week. No forecast. Veterans Day.'));
  expect(router.getPathname()).toBe('/locations/l1/calendar');
  expect(router.getSearchParams()).toMatchObject({ day: '2026-11-11' });
});

test('with a published forecast, each day from today shows its figure and the lead has no tagline', async () => {
  const days = [];
  for (let day = 5; day <= 30; day += 1) days.push(forecastDay({ date: `2026-11-${String(day).padStart(2, '0')}` }));
  await renderApp('/locations/l1', portal({ forecast: forecastOf(days) }));
  expect(await screen.findByLabelText('Wed, Nov 11, 2026. This week. 212 guests, forecast, likely 180 to 240. Veterans Day.')).toBeTruthy();
  expect(screen.queryByText(FORECAST_LINE)).toBeNull();
  expect(screen.queryByText('In progress')).toBeNull();
  // The selected day (today) gives its forecast, in This month and in This week's chart.
  expect(screen.getAllByText('About 212 guests, likely 180 to 240.')).toHaveLength(2);
});

test('a term period shows once with its span and source; the one-day event takes the headline', async () => {
  const registrar = [{ label: 'Registrar', url: 'https://www.dartmouth.edu/reg/' }];
  const term = (start: string, end: string): ReturnType<typeof townEvent> => townEvent({
    id: `hanover-nh:${start}:term`, start, end, title: 'Fall term classes', kind: 'term', sources: registrar,
  });
  await renderApp('/locations/l1', portal({
    calendar: { events: [term('2024-09-16', '2024-11-19'), term('2025-09-15', '2025-11-18'), term('2026-09-14', '2026-11-17'), ...EVENTS] },
  }));
  expect(await screen.findByText('On the calendar this week: Sample game (Saturday), and 1 more.')).toBeTruthy();
  expect(screen.getByText('Fall term classes. Term, Sep 14 to Nov 17, 2026.')).toBeTruthy();
  // Not in any day's cell, this year or past years: the bare title appears nowhere.
  expect(screen.queryByText('Fall term classes')).toBeNull();
  // One source chip under This week and one in This month's list, not one per day.
  expect(screen.getAllByRole('link', { name: 'Dartmouth. Source: Registrar' })).toHaveLength(2);
});

test('the questions link counts what GET .../agent asks, and shows nothing with none or when the read fails', async () => {
  await renderApp('/locations/l1', portal({ agent: { questions: [GAP('2026-05-12', '2026-05-13', 2)], activity: [] } }));
  // It opens TownwiseAI with the questions showing (?panel=questions).
  expect((await screen.findByRole('link', { name: '1 question from TownwiseAI' })).props.href).toBe('/locations/l1/agent?panel=questions');
  await cleanup();

  // A question kind this client doesn't know is not counted.
  await renderApp('/locations/l1', portal({ agent: { questions: [...QUESTIONS, { id: 'later_1', kind: 'unusual_night' }], activity: [] } }));
  expect(await screen.findByRole('link', { name: '2 questions from TownwiseAI' })).toBeTruthy();
  await cleanup();
  // D46: suggested closure rules count too, and a weekday question from an API before them is left out.
  const weekday = { id: 'weekday_1_2026-03-01_2026-05-31', kind: 'weekday', weekday: 1, from: '2026-03-01', to: '2026-05-31', noSalesCount: 13, weekdayCount: 13 };
  await renderApp('/locations/l1', portal({ agent: { questions: [...QUESTIONS, weekday], activity: [], ruleSuggestions: RULE_SUGGESTIONS } }));
  expect(await screen.findByRole('link', { name: '4 questions from TownwiseAI' })).toBeTruthy();
  await cleanup();

  for (const agent of [{ questions: [], activity: [] }, offline()]) {
    const api = portal({ agent });
    await renderApp('/locations/l1', api);
    await screen.findByText(FORECAST_LINE);
    await screen.findByText('Fall term classes until Tue, Nov 17.');
    expect(api.calls.some((call) => call.path === AGENT)).toBe(true);
    expect(screen.queryByRole('link', { name: /questions? from TownwiseAI/ })).toBeNull();
    expect(screen.queryByText(/a count here is planned/)).toBeNull();
    // The rest of Home is unchanged, and a failed count raises no error of its own.
    expect(screen.getByRole('link', { name: 'Ask TownwiseAI' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await cleanup();
  }
});

test('who’s in town: a headcount leads as one figure with its unit, later days say when they have none; a failed read stays in its place', async () => {
  const range = { low: 9500, high: 10_500, sourceIds: ['census-test', 'cal-1'], excludes: [] };
  const counted = {
    ...NOVEMBER,
    periods: NOVEMBER.periods.map((each) => (each.termState === 'in_session' ? { ...each, headcount: range, headcountWhy: null } : each)),
    sources: [...NOVEMBER.sources, { id: 'census-test', label: 'Synthetic census', url: 'https://census.example.test/p1', confidence: 'high' }],
    yourHistory: {
      metric: 'guests',
      cells: [{ state: 'in_session', weekday: 'Sat', days: 18, mean: 250 }, { state: 'between_terms', weekday: 'Sat', days: 6, mean: 140 }],
      first: '2025-01-04', last: '2026-10-31',
    },
  };
  await renderApp('/locations/l1', portal({ people: counted }));
  // The number first, read as one phrase with its unit, then the term in words.
  expect(await screen.findByText('9,500 to 10,500 people in town')).toBeTruthy();
  expect(screen.getByText('Fall term classes until Tue, Nov 17.')).toBeTruthy();
  expect(screen.getAllByText('No headcount')).toHaveLength(3);
  // A source on a host no manifest entry has shows that host, with the globe.
  expect(screen.getByRole('link', { name: 'census.example.test. Source: Synthetic census' })).toBeTruthy();
  expect(screen.getByText('census.example.test')).toBeTruthy();
  expect(screen.queryByText('Townwise can’t put a number on how many people are in Hanover yet.')).toBeNull();
  // With a headcount nothing on Home is Planned: Bar order is the live card (D35).
  expect(screen.queryAllByText('Planned')).toHaveLength(0);
  // The location's own days by term, under their own heading.
  expect(screen.getByRole('heading', { name: 'Your sales by term' })).toBeTruthy();
  expect(screen.getByText('Your Saturdays averaged 250 guests in term and 140 between terms (18 and 6 Saturdays).')).toBeTruthy();
  await cleanup();

  await renderApp('/locations/l1', portal({ people: offline() }));
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  // Only the summary failed: the rest of the month card and of Home still show.
  expect(screen.getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  expect(screen.getByText(PEOPLE_HEAD)).toBeTruthy();
  expect(screen.getByRole('heading', { name: '795 days' })).toBeTruthy();
});

test('bar order with no ordering setup says what is missing and links to Ordering setup; a failed read stays in its place', async () => {
  const { router } = await renderApp('/locations/l1', portal({
    orders: { available: false, today: '2026-11-05', reason: 'Townwise can’t build an order for this location until its ordering setup has a supplier schedule and items.', missing: ['the supplier schedule', 'the items'] },
  }));
  expect(await screen.findByRole('heading', { name: 'Ordering isn’t set up yet' })).toBeTruthy();
  expect(screen.getByText('Townwise still needs the supplier schedule and the items to build an order.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open Orders' })).toBeNull();
  await fireEvent.press(screen.getByRole('link', { name: 'Set up ordering' }));
  expect(router.getPathname()).toBe('/locations/l1/orders/setup');
  expect(await screen.findByRole('heading', { name: 'Ordering setup' })).toBeTruthy();
  expect(await screen.findByText('No items yet. Add each item you order.')).toBeTruthy();
  await cleanup();

  const failed = portal({ orders: offline() });
  await renderApp('/locations/l1', failed);
  // The card and the selected day's Reorder part each say so, from the one read.
  expect(await screen.findAllByText('Townwise couldn’t check the next order.')).toHaveLength(2);
  expect(failed.calls.filter((call) => call.path === `${PATH}/orders`)).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Open Orders' })).toBeTruthy();
  // Only the card's read failed: the rest of Home shows, with no Try again of its own.
  expect(screen.getByRole('heading', { name: '795 days' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
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
  // BLS withheld Nantucket County for April to June 2025: its jobs block says so, with no figure and no stale number.
  const nantucket = [locationOf('l1', 'Main Street Bar', { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }, { coverage: HAS_DAYS })];
  await renderApp('/locations/l1', portal({
    locations: nantucket, calendar: { town: { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }, researched: false, covers: null, events: [] },
  }));
  expect(await screen.findByText('Townwise’s Nantucket calendar has no researched town events yet. Only US federal holidays and your notes show here.')).toBeTruthy();
  expect(screen.getByText('From your sales through Wed, Nov 4, 2026 and US federal holidays.')).toBeTruthy();
  expect(screen.getByText('Nothing on the calendar this week.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Food-service jobs in Nantucket County' })).toBeTruthy();
  expect(screen.getByText('BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.')).toBeTruthy();
  expect(screen.queryByText(/% (fewer|more) jobs|About as many jobs/)).toBeNull();
  expect(screen.queryByText('County, not town. Employment is a stand-in for demand.')).toBeNull();
  expect(screen.getByRole('link', { name: 'U.S. Bureau of Labor Statistics. Source: U.S. Bureau of Labor Statistics, QCEW' })).toBeTruthy();
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
  expect(screen.queryByText(/^Same 7 days last year/)).toBeNull();
  expect(screen.queryByText('Two years ago')).toBeNull();
  await cleanup();

  // Two pairs broken inside last week (Oct 29 to Nov 4): Sat, Nov 1, 2025 and Fri, Oct 30, 2026.
  await renderApp('/locations/l1', portal({ days: DAYS.filter((day) => day.date !== '2025-11-01' && day.date !== '2026-10-30') }));
  expect(await screen.findByText(/^Last week: [\d,]+ guests on the 5 days both weeks have, 10% more than the same days last year \([\d,]+\)\.$/)).toBeTruthy();
});

test('while needsHistory is true, the history step takes the place of the cards that need days, and this week still shows', async () => {
  const empty = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })];
  await renderApp('/locations/l1', portal({ me: meOf(ACCESS.admin), locations: empty, days: [] }));
  expect(await screen.findByRole('heading', { name: 'Drop in everything you have' })).toBeTruthy();
  expect(screen.getByText('No sales history yet. Home shows Hanover’s researched calendar and your notes.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'What’s on the calendar, and how this week went before' })).toBeTruthy();
  expect(screen.getByText('Sample game')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'This month in Hanover' })).toBeTruthy();
  expect(screen.queryByText('Bar order')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open Orders' })).toBeNull();
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
  expect(await screen.findByRole('heading', { name: '0 items to order from Sample brewery' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Drop in everything you have' })).toBeNull();
});

test('every upload turned off: Home says so and points to Your data, not "no history"', async () => {
  await renderApp('/locations/l1', portal({ history: { ...historyBody([]), uploadsOff: true } }));
  expect(await screen.findByText('Every sales upload for this location is turned off. Turn one back on in Your data to see its days.')).toBeTruthy();
  expect(screen.getByText('Every sales upload is turned off, so there is nothing to compare.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Your data' })).toBeTruthy();
  expect(screen.queryByText('No sales history yet for this location.')).toBeNull();
  expect(screen.queryByText('No sales history yet, so there is nothing to compare.')).toBeNull();
});

test('one location whose every upload is off: no history step, the turned-off copy shows', async () => {
  const only = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, { offDayCount: 10 })];
  await renderApp('/locations/l1', portal({ locations: only, history: { ...historyBody([]), uploadsOff: true } }));
  expect(await screen.findByText('Every sales upload for this location is turned off. Turn one back on in Your data to see its days.')).toBeTruthy();
  expect(screen.getByText('Every sales upload is turned off, so there is nothing to compare.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Drop in everything you have' })).toBeNull();
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

test('with one location the loading line names the organization (D29)', async () => {
  await renderApp('/locations/l1', portal({ pending: true, locations: LOCATIONS.slice(0, 1) }));
  expect(await screen.findByText('Loading Test Group')).toBeTruthy();
  expect(screen.queryByText('Loading Main Street Bar')).toBeNull();
});

// D49 (design decision 9c): the Reorder part's explanation is behind a disclosure, closed by default, opened by a tap.
test('the day detail’s Reorder explanation opens from “How Townwise builds an order”', async () => {
  await renderApp('/locations/l1', portal());
  const how = await screen.findByRole('button', { name: 'How Townwise builds an order' });
  expect(how.props.accessibilityState).toMatchObject({ expanded: false });
  expect(screen.queryByText(REORDER_OVERVIEW)).toBeNull();
  await fireEvent.press(how);
  expect(screen.getByRole('button', { name: 'How Townwise builds an order' }).props.accessibilityState).toMatchObject({ expanded: true });
  expect(screen.getByText(REORDER_OVERVIEW)).toBeTruthy();
});

test('on native too, This month marks a forecast and an actual apart, keys both, and says how the month’s forecast did (D49)', async () => {
  const days = [forecastDay({ date: '2026-11-04', low: 90, mid: 100, high: 120, actual: 110, inRange: true, scored: true, madeAt: '2026-11-02' })];
  for (let day = 5; day <= 30; day += 1) days.push(forecastDay({ date: `2026-11-${String(day).padStart(2, '0')}` }));
  await renderApp('/locations/l1', portal({ forecast: forecastOf(days) }));
  const today = await screen.findByLabelText(/^Thu, Nov 5, 2026\. Today\. This week\. 212 guests, forecast/);
  const past = screen.getByLabelText('Wed, Nov 4, 2026. 110 guests, actual.');
  expect(screen.getByText('So far this month: 1 of 1 day inside the forecast range.')).toBeTruthy();
  const key = screen.getByTestId('month-key', { includeHiddenElements: true });
  expect(within(key).getByText('Actual guests', { includeHiddenElements: true })).toBeTruthy();
  expect(within(key).getByText('~82', { includeHiddenElements: true })).toBeTruthy();
  // The forecast's figure, after its “~”, is lighter than the actual's, with “forecast” under it.
  const colorOf = (node: { props: { style?: unknown } }): unknown => (StyleSheet.flatten(node.props.style as never) as { color?: unknown }).color;
  expect(colorOf(within(today).getByText('~212'))).toBe(theme.color.text2);
  expect(within(today).getByText('forecast')).toBeTruthy();
  expect(colorOf(within(past).getByText('110'))).toBe(theme.color.white);
  expect(within(past).queryByText('forecast')).toBeNull();
});
