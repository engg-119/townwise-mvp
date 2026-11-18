import { act, cleanup, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, type FakePortalApi } from '../../helpers/portal';
import { holiday } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';
import { calendarFake, forecastDay, forecastOf, ownerCalendar, ownerEvent } from './fakes';

// Where the day panel's entries came from (D49, calendar-sources and note-titles): a note's event name, then its kind
// words and detail; a TownwiseAI note's "Your file" chip to its item while its ref exists; each imported event's chip
// to its calendar's page in Your data, named by the calendar's label; a note reason's title after its label in Why.
// No rendered link holds anything but an app path or a town source's own page, and never a calendar's address.
// Today is Wed, Nov 11, 2026. Made-up names only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;

Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1280 });

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 11, 12, 0, 0),
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

const DAY = '2026-11-21';
const CALENDAR_ID = 'fedcba9876543210fedcba98';
const FILE_REF = 'f_0123456789abcdef01234567';
/** A Google secret iCal address: it must never reach a rendered link. */
const SECRET = 'https://calendar.google.com/calendar/ical/sample/private-0a1b2c/basic.ics';

const PARTY = noteOf('n1', {
  kind: 'private_event', startDate: DAY, endDate: DAY, effect: 'more_guests', expectedGuests: 70, title: 'Holiday party', detail: 'Upstairs room.',
});
const FROM_FILE = noteOf('n2', { kind: 'opening', startDate: DAY, endDate: DAY, effect: 'unknown', title: 'Late opening', source: { via: 'ai_file', fileId: 'x', ref: FILE_REF } });
const FILE_GONE = noteOf('n3', { kind: 'other', startDate: DAY, endDate: DAY, effect: 'unknown', title: 'Wine tasting', source: { via: 'ai_file', fileId: 'y', ref: null } });

function setup(): FakePortalApi {
  const fake = calendarFake({
    events: [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day')],
    notes: [PARTY, FROM_FILE, FILE_GONE],
    calendars: [ownerCalendar({ id: CALENDAR_ID, label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 1 })],
    ownerEvents: [
      ownerEvent({ calendarId: CALENDAR_ID, calendar: 'US holidays', uid: 'v1', title: 'Veterans Day', startDate: '2026-11-11' }),
      ownerEvent({ calendarId: CALENDAR_ID, calendar: 'US holidays', uid: 'd1', title: 'Rehearsal dinner', startDate: DAY }),
    ],
    forecasts: {
      '2026-11': forecastOf([forecastDay({
        date: DAY, noteGuests: 70,
        reasons: [{ kind: 'note', label: 'Your private event, 70 guests', effectPct: null, sources: [], note: { id: 'n1', guests: 70, outcome: 'added' } }],
      })]),
    },
  });
  return fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
}

async function renderAt(path: string): Promise<HTMLElement> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: setup() });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  await screen.findByRole('grid', { name: 'November 2026' });
  const panel = screen.getByRole('region', { name: 'Selected day' });
  await act(async () => { await Promise.resolve(); });
  return panel;
}

test('a note shows its event name, then its kind words and its detail; Why follows the note reason with its name', async () => {
  const panel = await renderAt(`/locations/l1/calendar?day=${DAY}`);
  expect(await within(panel).findByText('Your note: Holiday party')).toBeTruthy();
  expect(within(panel).getByText('Private event, more guests than usual')).toBeTruthy();
  expect(within(panel).getByText('Upstairs room.')).toBeTruthy();
  expect(within(panel).getByText('Your private event, 70 guests: Holiday party')).toBeTruthy();
});

test('a TownwiseAI note links to its file while its ref exists, and an imported event to its calendar’s page', async () => {
  const panel = await renderAt(`/locations/l1/calendar?day=${DAY}`);
  const file = await within(panel).findByRole('link', { name: 'Your file. Opens it in Your data' });
  expect(file.getAttribute('href')).toBe(`/locations/l1/data/${FILE_REF}`);
  // The note whose file is gone has no chip.
  expect(within(panel).getAllByRole('link', { name: /^Your file/ })).toHaveLength(1);
  const calendar = within(panel).getByRole('link', { name: 'US holidays. Opens this calendar in Your data' });
  expect(calendar.getAttribute('href')).toBe(`/locations/l1/data/c_${CALENDAR_ID}`);
  expect(calendar.textContent).toBe('US holidays');
});

test('no rendered link holds anything but an app path or a town source’s page, and never the calendar’s address', async () => {
  for (const day of [DAY, '2026-11-11']) {
    cleanup();
    const panel = await renderAt(`/locations/l1/calendar?day=${day}`);
    await within(panel).findByRole('link', { name: /^US holidays/ });
    const hrefs = [...document.querySelectorAll('a[href]')].map((link) => link.getAttribute('href') ?? '');
    for (const href of hrefs) expect(href.startsWith('/') || href.startsWith('https://www.opm.gov/')).toBe(true);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(hrefs.some((href) => href.includes('calendar.google.com'))).toBe(false);
  }
});

test('the day panel lists Veterans Day from both sources, the imported one with its chip; the cell shows it once', async () => {
  const panel = await renderAt('/locations/l1/calendar?day=2026-11-11');
  expect(await within(panel).findByText('From your calendar: Veterans Day')).toBeTruthy();
  expect(within(panel).getByText(/^Veterans Day/)).toBeTruthy();
  const cell = document.querySelector('[data-date="2026-11-11"]');
  expect(cell?.textContent.split('Veterans Day')).toHaveLength(2);
});
