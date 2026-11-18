import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ITEM } from '../../../src/portal/data/item/copy';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { ownerCalendar, ownerEvent } from '../calendar/fakes';
import { locationsFake } from '../locations/fakes';
import { dataFake, type DataFake } from './fakes';

// A calendar's page in Your data on web (D49, calendar-detail): P27 at the client-only ref `c_<calendarId>`, which
// reads the calendar routes and never the data item's. Its name, kind and host as text, counts and last refresh, then
// one month at a time of its events, each linking to its day on the Calendar. Today is Tue, Nov 17, 2026. Made-up
// titles only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

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

const ID = 'fedcba9876543210fedcba98';
const SECRET = 'https://calendar.google.com/calendar/ical/sample/private-0a1b2c/basic.ics';
const HOLIDAYS = ownerCalendar({
  id: ID, label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 2, skippedRepeating: 1, lastSuccessAt: '2026-11-16T15:00:00.000Z',
});

function setup(path: string): DataFake {
  const fake = dataFake({ inner: locationsFake() });
  fake.calendars = [HOLIDAYS, ownerCalendar({ id: '0123456789abcdef01234567', label: 'Kitchen' })];
  fake.calendarEvents = [
    ownerEvent({ calendarId: ID, calendar: 'US holidays', uid: 'v1', title: 'Veterans Day', startDate: '2026-11-11' }),
    ownerEvent({ calendarId: ID, calendar: 'US holidays', uid: 't1', title: 'Thanksgiving Day', startDate: '2026-11-26' }),
    // Another calendar's event in the same month: not this page's.
    ownerEvent({ calendarId: '0123456789abcdef01234567', calendar: 'Kitchen', uid: 'k1', title: 'Wine delivery', startDate: '2026-11-20' }),
  ];
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return fake;
}

test('a linked calendar’s page: its name, kind and host as text, counts and refresh, then November’s events linking to their days', async () => {
  const fake = setup(`/locations/l1/data/c_${ID}`);
  expect(await screen.findByRole('heading', { name: 'US holidays' })).toBeTruthy();
  expect(screen.getByText('Link, calendar.google.com, 2 events')).toBeTruthy();
  expect(screen.getByText('1 repeating event wasn’t imported. Add it as a note with weekdays.')).toBeTruthy();
  expect(screen.getByText(/^Updated Nov 16, 2026/)).toBeTruthy();
  const november = await screen.findByRole('list', { name: 'US holidays events, November 2026' });
  expect(within(november).getAllByRole('link').map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')])).toEqual([
    ['Veterans Day, Wed, Nov 11, 2026. Opens the day on the Calendar.', '/locations/l1/calendar?day=2026-11-11'],
    ['Thanksgiving Day, Thu, Nov 26, 2026. Opens the day on the Calendar.', '/locations/l1/calendar?day=2026-11-26'],
  ]);
  expect(screen.queryByText('Wine delivery')).toBeNull();
  // It read the calendars and the month's events, never the data item route; and no page link holds the address.
  expect(fake.paths.some((path) => path.includes('/data/c_'))).toBe(false);
  expect(fake.paths).toContain('/api/org/locations/l1/owner-calendars/events?from=2026-11-01&to=2026-11-30');
  expect(document.body.innerHTML).not.toContain(SECRET);
  expect([...document.querySelectorAll('a[href]')].some((link) => (link.getAttribute('href') ?? '').includes('calendar.google.com'))).toBe(false);
});

test('Later moves a month on; a month with none says so; Earlier comes back', async () => {
  setup(`/locations/l1/data/c_${ID}`);
  await screen.findByRole('list', { name: 'US holidays events, November 2026' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Later: December 2026' })); await Promise.resolve(); });
  expect(await screen.findByText('No events in December 2026.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Earlier: November 2026' }));
  expect(await screen.findByRole('list', { name: 'US holidays events, November 2026' })).toBeTruthy();
});

test('an unknown calendar, or another organization’s, shows the not-found state', async () => {
  const fake = setup('/locations/l1/data/c_aaaaaaaaaaaaaaaaaaaaaaaa');
  expect(await screen.findByText(ITEM.gone)).toBeTruthy();
  expect(screen.getByRole('link', { name: ITEM.back })).toBeTruthy();
  expect(fake.paths.some((path) => path.includes('/data/c_'))).toBe(false);
});
