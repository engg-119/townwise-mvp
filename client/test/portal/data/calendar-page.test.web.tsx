import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { OwnerCalendar } from '../../../src/portal/calendar/api';
import type { DataItem } from '../../../src/portal/data/api';
import { ITEM } from '../../../src/portal/data/item/copy';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { ownerCalendar, ownerEvent } from '../calendar/fakes';
import { locationsFake } from '../locations/fakes';
import { dataFake, itemOf, type DataFake } from './fakes';

// A calendar's page in Your data on web (D49, calendar-detail): P27 at the client-only ref `c_<calendarId>`, which
// reads the calendar routes and never the data item's. Its name, kind and host as text, counts and last refresh, then
// one month at a time of its events, as a month grid (D62) whose chosen day lists its events, each linking to its day
// on the Calendar; a phone keeps the month's agenda. Today is Tue, Nov 17, 2026. Made-up titles only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

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
  width = 1280;
  window.dispatchEvent(new Event('resize'));
});

const ID = 'fedcba9876543210fedcba98';
const SECRET = 'https://calendar.google.com/calendar/ical/sample/private-0a1b2c/basic.ics';
const HOLIDAYS = ownerCalendar({
  id: ID, label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 2, skippedRepeating: 1, lastSuccessAt: '2026-11-16T15:00:00.000Z',
});

function setup(path: string, kitchen: Partial<OwnerCalendar> = {}, items: DataItem[] = []): DataFake {
  const fake = dataFake({ inner: locationsFake(), items });
  fake.calendars = [HOLIDAYS, ownerCalendar({ id: '0123456789abcdef01234567', label: 'Kitchen', ...kitchen })];
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

test('a linked calendar’s page: its name, kind and host as text, counts and refresh, then November as a grid whose chosen day links its events', async () => {
  const fake = setup(`/locations/l1/data/c_${ID}`);
  expect(await screen.findByRole('heading', { name: 'US holidays' })).toBeTruthy();
  expect(screen.getByText('Link, calendar.google.com, 2 events')).toBeTruthy();
  expect(screen.getByText('1 repeating event wasn’t imported. Add it as a note with weekdays.')).toBeTruthy();
  expect(screen.getByText(/^Updated Nov 16, 2026/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Events' }).getAttribute('aria-level')).toBe('3');
  const grid = await screen.findByRole('grid', { name: 'US holidays, November 2026' });
  await within(grid).findByRole('gridcell', { name: 'Wed, Nov 11, 2026. 1 event: Veterans Day.' });
  // The month opens on today, which has none.
  const today = within(grid).getByRole('gridcell', { name: 'Tue, Nov 17, 2026. Today. No events.' });
  expect(today.getAttribute('aria-selected')).toBe('true');
  expect(today.getAttribute('tabindex')).toBe('0');
  expect(screen.getByText('No events on Tue, Nov 17, 2026.')).toBeTruthy();
  // Choosing a day lists its events as the agenda's rows, each linking to its day on the Calendar.
  fireEvent.click(within(grid).getByRole('gridcell', { name: /^Wed, Nov 11, 2026\./ }));
  const day = screen.getByRole('list', { name: 'US holidays events, Wed, Nov 11, 2026' });
  expect(screen.getByRole('heading', { name: 'Wed, Nov 11, 2026' }).getAttribute('aria-level')).toBe('4');
  expect(within(day).getAllByRole('link').map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')])).toEqual([
    ['Veterans Day, Wed, Nov 11, 2026. Opens the day on the Calendar.', '/locations/l1/calendar?day=2026-11-11'],
  ]);
  expect(within(grid).getByRole('gridcell', { name: /^Wed, Nov 11, 2026\./ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('Wine delivery')).toBeNull();
  // It read the calendars and the month's events, never the data item route; and no page link holds the address.
  expect(fake.paths.some((path) => path.includes('/data/c_'))).toBe(false);
  expect(fake.paths).toContain('/api/org/locations/l1/owner-calendars/events?from=2026-11-01&to=2026-11-30');
  expect(document.body.innerHTML).not.toContain(SECRET);
  expect([...document.querySelectorAll('a[href]')].some((link) => (link.getAttribute('href') ?? '').includes('calendar.google.com'))).toBe(false);
});

test('Later moves the grid a month on; a month with none says so; Earlier comes back', async () => {
  setup(`/locations/l1/data/c_${ID}`);
  await screen.findByRole('gridcell', { name: 'Wed, Nov 11, 2026. 1 event: Veterans Day.' });
  // The month shown is named on the page, not only in the grid's label, so Earlier and Later say where they went.
  expect(screen.getByRole('heading', { name: 'November 2026' }).getAttribute('aria-level')).toBe('4');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Later: December 2026' })); await Promise.resolve(); });
  expect(await screen.findByText('No events in December 2026.')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'US holidays, December 2026' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'December 2026' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'November 2026' })).toBeNull();
  // With no events, December opens on its 1st and lists no day.
  expect(screen.getByRole('gridcell', { name: 'Tue, Dec 1, 2026. No events.' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText(/^No events on /)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Earlier: November 2026' }));
  expect(await screen.findByRole('grid', { name: 'US holidays, November 2026' })).toBeTruthy();
});

test('a phone keeps the month’s agenda, its events under the month linking to their days', async () => {
  width = 375;
  window.dispatchEvent(new Event('resize'));
  setup(`/locations/l1/data/c_${ID}`);
  const november = await screen.findByRole('list', { name: 'US holidays events, November 2026' });
  // The month heads its list under Events (UI review nit 6).
  expect(screen.getByRole('heading', { name: 'November 2026' }).getAttribute('aria-level')).toBe('4');
  expect(within(november).getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual([
    'Veterans Day, Wed, Nov 11, 2026. Opens the day on the Calendar.',
    'Thanksgiving Day, Thu, Nov 26, 2026. Opens the day on the Calendar.',
  ]);
  expect(screen.queryByRole('grid')).toBeNull();
});

test('an unknown calendar, or another organization’s, shows the not-found state, which stays on the page', async () => {
  const fake = setup('/locations/l1/data/c_aaaaaaaaaaaaaaaaaaaaaaaa');
  // A row in the page, not a toast that fades and leaves the page blank (UI review S3).
  const gone = await screen.findByText(ITEM.calendarGone);
  expect(screen.queryByTestId('toasts')?.contains(gone) ?? false).toBe(false);
  expect(screen.getByRole('link', { name: ITEM.back })).toBeTruthy();
  expect(fake.paths.some((path) => path.includes('/data/c_'))).toBe(false);
});

// UI review S6: a status that asks the owner to remove and add the link again leads to where that is done.
test('a calendar with a status links to the Calendar’s Your calendars; one without has no such link', async () => {
  setup(`/locations/l1/data/c_${ID}`);
  expect(await screen.findByRole('heading', { name: 'US holidays' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: ITEM.manageCalendars })).toBeNull();
  cleanup();
  const fake = dataFake({ inner: locationsFake() });
  fake.calendars = [{ ...HOLIDAYS, status: 'key_mismatch' }];
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/data/c_${ID}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  expect(await screen.findByText('Townwise can’t open this link any more. Remove it and add the link again.')).toBeTruthy();
  expect(screen.getByRole('link', { name: ITEM.manageCalendars }).getAttribute('href')).toBe('/locations/l1/calendar');
});

// D61: Your data lists a file imported as a calendar once, as the calendar, so the calendar's page leads to the file.
test('a calendar imported from a file kept in Your data links to that file’s page; one without such a file has no link', async () => {
  setup('/locations/l1/data/c_0123456789abcdef01234567');
  expect(await screen.findByRole('heading', { name: 'Kitchen' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: ITEM.calendarFile })).toBeNull();
  cleanup();
  setup('/locations/l1/data/c_0123456789abcdef01234567', { fromFile: 'f_00000000000000000000000a' }, [
    itemOf('f_00000000000000000000000a', { name: 'Kitchen.ics', state: 'kept', outcome: 'reference', folder: 'calendars' }),
  ]);
  const link = await screen.findByRole('link', { name: ITEM.calendarFile });
  expect(link.getAttribute('href')).toBe('/locations/l1/data/f_00000000000000000000000a');
  fireEvent.click(link);
  expect(await screen.findByRole('heading', { level: 2, name: 'Kitchen.ics' })).toBeTruthy();
});
