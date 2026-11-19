import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { OwnerCalendar } from '../../../src/portal/calendar/api';
import { BOOKINGS } from '../../../src/portal/data/item/bookingWords';
import type { MeResponse, OrgResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, openAsAdminMe, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { choose, choicesOf } from '../../helpers/select';
import { ownerCalendar, ownerEvent } from '../calendar/fakes';
import { locationsFake } from '../locations/fakes';
import { dataFake, type DataFake } from './fakes';

// A file calendar's Bookings section on its page in Your data, on web (D58, learn-from-calendar-bookings design
// decisions 7, 10, 11 and 15): the state and counts per label for everyone; for an org admin outside view-as Sort
// with TownwiseAI (its words shown before the press) and Use for forecasts, and a label choice under each event that
// sends the event's uid in the body only; members and view-as read only; staff open as admin may label and confirm but
// not sort. Today is Tue, Nov 17, 2026. Made-up titles only. At a phone's width, where the page keeps the month's
// agenda, so every event's label choice is in one list (D62); the month grid's own tests are in calendar-month.test.web.tsx.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 375 });

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 17, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const ID = 'aaaabbbbccccdddd00001111';
const BASE = `/api/org/locations/l1/owner-calendars/${ID}`;
const COUNTS = { buyout: 1, party: 1, own_event: 0, other: 0, unlabeled: 1 };
const SORTED = { state: 'sorted', sortedAt: '2026-11-16T15:00:00.000Z', confirmedAt: null, counts: COUNTS };
const MASTER = ownerCalendar({ id: ID, label: 'Master calendar', kind: 'file', eventCount: 3, format: 'csv', bookings: SORTED });
const EVENTS = [
  ownerEvent({
    calendarId: ID, calendar: 'Master calendar', uid: 'x/1', title: 'Retirement party', startDate: '2026-11-21', startTime: '18:00', endTime: '21:00',
    booking: 'party', bookingBy: 'ai',
  }),
  ownerEvent({ calendarId: ID, calendar: 'Master calendar', uid: 'x/2', title: 'Wine tasting', startDate: '2026-11-25' }),
  ownerEvent({ calendarId: ID, calendar: 'Master calendar', uid: 'x/3', title: 'Full house dinner', startDate: '2026-11-28', booking: 'buyout', bookingBy: 'person' }),
];

function setup(opts: { me?: MeResponse; org?: OrgResponse; sortAvailable?: boolean; calendar?: OwnerCalendar } = {}): { fake: DataFake; api: FakePortalApi } {
  const fake = dataFake({ inner: locationsFake() });
  fake.calendars = [opts.calendar ?? MASTER];
  fake.bookingSort = { available: opts.sortAvailable ?? true };
  fake.calendarEvents = EVENTS;
  const api = fakePortalApi({ me: opts.me ?? meOf(ACCESS.admin), org: opts.org ?? orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/data/c_${ID}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return { fake, api };
}

function labelSelects(): HTMLElement[] {
  return screen.queryAllByRole('combobox').filter((box) => (box.getAttribute('aria-label') ?? '').startsWith('Label for '));
}

/** The label choice of the month's event at `index`, in date order. */
function labelSelect(index: number): HTMLElement {
  const found = labelSelects()[index];
  if (found === undefined) throw new Error(`no label choice ${String(index)}`);
  return found;
}

async function shownPage(): Promise<HTMLElement> {
  expect(await screen.findByRole('heading', { name: 'Bookings' })).toBeTruthy();
  return screen.findByRole('list', { name: 'Master calendar events, November 2026' });
}

test('an org admin sees the state, the counts, each event’s label, and Sort’s words before pressing it', async () => {
  setup();
  const november = await shownPage();
  expect(screen.getByText('Sorted, not used for forecasts yet.')).toBeTruthy();
  // One row per label: buyout, party and no label hold an event each, your own event and not a booking none.
  expect(screen.getAllByText('1 event')).toHaveLength(3);
  expect(screen.getAllByText('0 events')).toHaveLength(2);
  const words = screen.getByText(BOOKINGS.sortExplain);
  expect(BOOKINGS.sortExplain).toBe('Sends this calendar’s event titles, dates and hours to Anthropic once, to sort them. Anthropic doesn’t train on them. Nothing changes until you press Use for forecasts.');
  const sort = screen.getByRole('button', { name: 'Sort with TownwiseAI' });
  expect(sort.getAttribute('aria-describedby')).toBe(words.id);
  expect(screen.getByRole('button', { name: 'Use for forecasts' })).toBeTruthy();
  expect(within(november).getByText('Party (alongside regular service), suggested by TownwiseAI')).toBeTruthy();
  expect(within(november).getByRole('link', { name: 'Wine tasting, Wed, Nov 25, 2026. Opens the day on the Calendar. No label.' })).toBeTruthy();
  expect(labelSelects().map((box) => box.getAttribute('aria-label'))).toEqual([
    'Label for Retirement party, Sat, Nov 21, 2026', 'Label for Wine tasting, Wed, Nov 25, 2026', 'Label for Full house dinner, Sat, Nov 28, 2026',
  ]);
  expect(choicesOf(labelSelect(1))).toEqual([
    'Buyout (takes the whole restaurant)', 'Party (alongside regular service)', 'Your own event', 'Not a booking', 'No label',
  ]);
});

test('Sort sends no body, says how many it labeled and that some weren’t, and reads the month again', async () => {
  const { fake, api } = setup();
  await shownPage();
  const reads = (): number => fake.paths.filter((path) => path.includes('/owner-calendars/events?')).length;
  const before = reads();
  const sorted = { ...MASTER, bookings: { ...SORTED, counts: { ...COUNTS, other: 1, unlabeled: 0 } } };
  api.answers[`${BASE}/bookings/sort`] = () => ({ calendar: sorted, sent: 1, labeled: 1, batchesFailed: 1 });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sort with TownwiseAI' })); await Promise.resolve(); });
  expect(await screen.findByText('TownwiseAI labeled 1 of 1 event. Some events weren’t labeled. Sort again to try them.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: `${BASE}/bookings/sort`, body: undefined }]);
  expect(reads()).toBeGreaterThan(before);
});

test('a refused sort says why in the section: the month’s budget, the hourly limit, TownwiseAI off', async () => {
  const { api } = setup();
  await shownPage();
  const cases: [ReturnType<typeof refusal>, string][] = [
    [refusal(409, 'chat_budget_exhausted'), 'Your organization’s TownwiseAI budget for this month is spent, so TownwiseAI can’t sort this calendar until next month. You can still label events yourself.'],
    [refusal(429, 'rate_limited', 1200), 'This calendar was sorted 3 times in the last hour. Try again in 20 minutes.'],
    [refusal(503, 'chat_unavailable'), 'TownwiseAI isn’t available right now, so it can’t sort this calendar. You can still label events yourself.'],
  ];
  for (const [error, words] of cases) {
    api.answers[`${BASE}/bookings/sort`] = () => error;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sort with TownwiseAI' })); await Promise.resolve(); });
    expect(await screen.findByText(words)).toBeTruthy();
  }
});

test('a label change sends the event’s uid in the body, never the path, and says the note it kept', async () => {
  const { api } = setup();
  await shownPage();
  const relabeled = { ...MASTER, bookings: { ...SORTED, counts: { ...COUNTS, buyout: 0, other: 1 } } };
  const answer = deferred<unknown>();
  api.answers[`${BASE}/bookings`] = () => answer.promise;
  choose(labelSelect(2), 'Not a booking');
  await act(async () => { answer.resolve({ calendar: relabeled, noteMade: false, noteKept: true }); await Promise.resolve(); });
  expect(await screen.findByText('Set Full house dinner to Not a booking. Its note is still on the Calendar.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'PATCH', path: `${BASE}/bookings`, body: { uid: 'x/3', booking: 'other' } }]);
  expect(writes(api).some((call) => call.path.includes('x%2F3') || call.path.includes('x/3'))).toBe(false);
  // The event shows its new label, set by a person, and the counts are the answer's.
  const november = screen.getByRole('list', { name: 'Master calendar events, November 2026' });
  expect(within(november).getAllByText('Not a booking').length).toBeGreaterThan(0);
  api.answers[`${BASE}/bookings`] = () => ({ calendar: relabeled, noteMade: true, noteKept: false });
  choose(labelSelect(1), 'Party (alongside regular service)');
  expect(await screen.findByText('Set Wine tasting to Party. Made a note for it on the Calendar.')).toBeTruthy();
  expect(writes(api).at(-1)).toEqual({ method: 'PATCH', path: `${BASE}/bookings`, body: { uid: 'x/2', booking: 'party' } });
});

test('Use for forecasts says the notes made, those left, and that learning started; or when it will', async () => {
  const { api } = setup();
  await shownPage();
  const confirmed = { ...MASTER, bookings: { ...SORTED, state: 'confirmed', confirmedAt: '2026-11-17T17:00:00.000Z' } };
  api.answers[`${BASE}/bookings/confirm`] = () => ({ calendar: confirmed, notesMade: 2, notesLeft: 1, calibration: { status: 'started', id: 'k1' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use for forecasts' })); await Promise.resolve(); });
  expect(await screen.findByText('Made 2 notes for upcoming bookings. 1 more upcoming booking got no note. Press Use for forecasts again. Townwise started learning from them now.')).toBeTruthy();
  expect(screen.getByText('Used for forecasts since Nov 17, 2026.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: `${BASE}/bookings/confirm`, body: undefined }]);
  api.answers[`${BASE}/bookings/confirm`] = () => ({ calendar: confirmed, notesMade: 0, notesLeft: 0, calibration: { status: 'lab_unavailable', id: null } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use for forecasts' })); await Promise.resolve(); });
  expect(await screen.findByText('Made 0 notes for upcoming bookings. The next weekly refresh will learn from them.')).toBeTruthy();
});

test('the filter shows one label’s events, and says when the month has none', async () => {
  setup();
  await shownPage();
  const filter = screen.getByRole('combobox', { name: 'Show' });
  choose(filter, 'Buyout (takes the whole restaurant)');
  const november = screen.getByRole('list', { name: 'Master calendar events, November 2026' });
  expect(within(november).getAllByRole('listitem')).toHaveLength(1);
  expect(within(november).getByText('Full house dinner')).toBeTruthy();
  choose(filter, 'Your own event');
  expect(screen.getByText('No events labeled Your own event in November 2026.')).toBeTruthy();
});

test('a member reads the counts and labels, with no Sort, no Use for forecasts and no label choice', async () => {
  setup({ me: meOf(ACCESS.member), org: orgOf('member') });
  const november = await shownPage();
  expect(screen.getByText('Party (alongside regular service)')).toBeTruthy();
  expect(within(november).getByText('Party (alongside regular service), suggested by TownwiseAI')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sort with TownwiseAI' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use for forecasts' })).toBeNull();
  expect(screen.queryByText(BOOKINGS.sortExplain)).toBeNull();
  expect(labelSelects()).toEqual([]);
});

test('under view-as as an org admin the section is read-only, with its line', async () => {
  setup({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
  await shownPage();
  expect(screen.getByText(/^Read-only while viewing as /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sort with TownwiseAI' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use for forecasts' })).toBeNull();
  expect(labelSelects()).toEqual([]);
});

test('staff open as admin may label and confirm, but have no Sort, with the line that says so', async () => {
  setup({ me: openAsAdminMe(), org: orgOf('org_admin') });
  await shownPage();
  expect(screen.getByText('Sort with TownwiseAI isn’t available while setting up as Townwise staff.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sort with TownwiseAI' })).toBeNull();
  expect(screen.queryByText(BOOKINGS.sortExplain)).toBeNull();
  expect(screen.getByRole('button', { name: 'Use for forecasts' })).toBeTruthy();
  expect(labelSelects()).toHaveLength(3);
});

test('with no model key there is no Sort, and a link calendar has no Bookings section', async () => {
  setup({ sortAvailable: false });
  await shownPage();
  expect(screen.queryByRole('button', { name: 'Sort with TownwiseAI' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Use for forecasts' })).toBeTruthy();
  cleanup();
  setup({ calendar: { ...MASTER, kind: 'link', host: 'calendar.google.com', format: null, bookings: null } });
  expect(await screen.findByRole('heading', { name: 'Master calendar' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Bookings' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Show' })).toBeNull();
});

test('a file calendar’s Earlier goes back 36 months, to November 2023', async () => {
  setup();
  await shownPage();
  for (let step = 0; step < 36; step += 1) {
    const earlier = screen.getByRole('button', { name: /^Earlier: / });
    await act(async () => { fireEvent.click(earlier); await Promise.resolve(); });
  }
  expect(await screen.findByText('No events in November 2023.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Earlier: October 2023' }).getAttribute('aria-disabled')).toBe('true');
});
