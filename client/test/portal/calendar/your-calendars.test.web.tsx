import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { CALENDARS_COPY } from '../../../src/portal/calendar/calendars';
import { errorCopy } from '../../../src/portal/errors';
import { formatDate, formatTime } from '../../../src/portal/format';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, writes, type FakePortalApi } from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { CALENDARS_PATH, calendarFake, forecastDay, forecastOf, ownerCalendar, ownerEvent, type CalendarFake } from './fakes';

// "Your calendars" on web (P28; connect-owner-calendar design decision 11): the header row's last control, a disclosure
// button with the location's calendar count, and its panel, a full-width region under the row that stays mounted while
// closed. The panel lists the calendars, says when the list couldn't be read, and holds "Import a calendar file" and
// "How importing works". Today is Wed, Nov 11, 2026. Synthetic figures and made-up names only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; these tests cover the desktop layout.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1280 });

// Only Date is faked, so "today" is Wed, Nov 11, 2026 and every timer stays real.
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

const KITCHEN = ownerCalendar({ id: 'c1', label: 'Kitchen', kind: 'file', host: null, eventCount: 12 });
const BOOKINGS = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });
const DINNER = ownerEvent({ calendarId: 'c1', calendar: 'Kitchen', uid: 'i1', title: 'Smith rehearsal dinner', startDate: '2026-11-21' });

function setup(init: Partial<Pick<CalendarFake, 'calendars' | 'ownerEvents'>> = {}): { api: FakePortalApi; fake: CalendarFake } {
  const days = Array.from({ length: 20 }, (_, at) => forecastDay({ date: `2026-11-${String(11 + at)}` }));
  const fake = calendarFake({
    events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' })],
    forecasts: { '2026-11': forecastOf(days) },
    ...init,
  });
  return { api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }), fake };
}

async function renderAt(path: string, api: FakePortalApi, month = 'November 2026'): Promise<HTMLElement> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return screen.findByRole('grid', { name: month });
}

/**
 * The panel, shown or not, as the button's aria-controls names it (a hidden element's accessible name is empty, so
 * getByRole can't find a closed one by its name).
 */
function region(): HTMLElement {
  const id = screen.getByRole('button', { name: /^Your calendars/ }).getAttribute('aria-controls') ?? '';
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no panel #${id}`);
  return found;
}

function shown(element: Element): boolean {
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    if (window.getComputedStyle(at).display === 'none') return false;
  }
  return true;
}

test('with 2 calendars the button reads “Your calendars (2)”, closed, controlling the hidden full-width region, the header row’s last item', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const button = screen.getByRole('button', { name: 'Your calendars (2)' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  const panel = region();
  expect(panel.id).not.toBe('');
  expect([panel.getAttribute('role'), panel.getAttribute('aria-label')]).toEqual(['region', 'Your calendars']);
  expect(shown(panel)).toBe(false);
  expect(window.getComputedStyle(panel).flexBasis).toBe('100%');
  const row = screen.getByText('November 2026').parentElement?.parentElement;
  expect(panel.parentElement).toBe(row);
  expect(button.parentElement).toBe(row);
  expect(panel.nextElementSibling).toBeNull();
});

test('with none the button reads “Your calendars”', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.getByRole('button', { name: 'Your calendars' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: /^Your calendars \(/ })).toBeNull();
});

test('pressing the button shows the panel, listing the calendars, and pressing it again hides it', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const button = screen.getByRole('button', { name: 'Your calendars (2)' });
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  expect(shown(panel)).toBe(true);
  expect(within(panel).getByText('Kitchen')).toBeTruthy();
  expect(within(panel).getByText('Bookings')).toBeTruthy();
  expect(within(panel).queryByText(CALENDARS_COPY.none)).toBeNull();
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(shown(region())).toBe(false);
});

test('the panel’s text is at most 680px wide: the full-width region holds one column, and the list, the import and the help are in it', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars (2)' }));
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  expect(window.getComputedStyle(panel).flexBasis).toBe('100%');
  expect(panel.children).toHaveLength(1);
  const column = panel.children[0] as HTMLElement;
  expect(window.getComputedStyle(column).maxWidth).toBe('680px');
  for (const inside of [
    within(panel).getByText('Kitchen'), within(panel).getByRole('button', { name: 'Import a calendar file' }),
    within(panel).getByRole('button', { name: 'How importing works' }), within(panel).getByText(CALENDARS_COPY.help),
  ]) expect(column.contains(inside)).toBe(true);
});

test('with none the open panel says “No calendars yet.”', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars' }));
  expect(within(screen.getByRole('region', { name: 'Your calendars' })).getByText('No calendars yet.')).toBeTruthy();
});

test('a failed list read leaves the page showing: “Your calendars”, and the open panel’s Try again reads the list and the stored events again', async () => {
  const { api, fake } = setup({ calendars: refusal(503, null) });
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(grid).toBeTruthy();
  expect(document.querySelector('[role="grid"] [data-date="2026-11-21"]')?.textContent).toContain('Dartmouth home football');
  const button = screen.getByRole('button', { name: 'Your calendars' });
  fireEvent.click(button);
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  expect(within(panel).getByText('Couldn’t load your calendars.')).toBeTruthy();
  expect(within(panel).queryByText(CALENDARS_COPY.none)).toBeNull();
  const reads = fake.paths.length;
  fake.calendars = [KITCHEN];
  fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy(); });
  // The list and the grid's stored events, never the forecast or the notes.
  const again = fake.paths.slice(reads);
  expect(again).toContain(CALENDARS_PATH);
  expect(again).toContain(`${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`);
  expect(again.filter((path) => path.includes('/forecast?') || path.endsWith('/notes'))).toEqual([]);
  expect(within(panel).getByText('Kitchen')).toBeTruthy();
  expect(within(panel).queryByText('Couldn’t load your calendars.')).toBeNull();
});

test('with the list unread the grid shows no stored events and no “Your calendar”, though they were read; once Try again reads the list they show', async () => {
  const { api, fake } = setup({ calendars: refusal(503, null), ownerEvents: [DINNER] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const day = (): string => document.querySelector('[role="grid"] [data-date="2026-11-21"]')?.textContent ?? '';
  expect(day()).toContain('Dartmouth home football');
  expect(day()).not.toContain('Smith rehearsal dinner');
  expect(within(screen.getByRole('region', { name: 'Selected day' })).queryByText('From your calendar: Smith rehearsal dinner')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  // Only the list failed: the stored events' own notice does not show.
  expect(fake.paths).toContain(`${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`);
  expect(screen.queryByText('Couldn’t load the events from your calendars. Try again.')).toBeNull();
  fake.calendars = [KITCHEN];
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars' }));
  fireEvent.click(within(screen.getByRole('region', { name: 'Your calendars' })).getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(day()).toContain('Smith rehearsal dinner'); });
  expect(screen.getByRole('button', { name: 'Your calendar' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
});

/** A row's lines, in order, without its actions' labels. */
function lines(row: HTMLElement): string[] {
  return [...row.querySelectorAll('*')]
    .filter((element) => element.childElementCount === 0 && element.closest('[role="button"]') === null)
    .map((element) => element.textContent)
    .filter((text) => text !== '');
}

test('the rows are a list in the list’s order: a file’s name, kind, count and repeating events; a link’s host, count, status words and Updated time', async () => {
  const at = '2026-11-14T20:42:00.000Z';
  const updated = `Updated ${formatDate(at)}, ${formatTime(at)}`;
  const { api } = setup({
    calendars: [
      ownerCalendar({ id: 'c1', label: 'Kitchen', kind: 'file', eventCount: 12, skippedRepeating: 3 }),
      ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1, status: 'timeout', lastSuccessAt: at }),
      ownerCalendar({ id: 'c3', label: 'Bar', kind: 'link', host: 'calendar.google.com', eventCount: 4, status: 'key_mismatch', lastSuccessAt: at }),
      ownerCalendar({ id: 'c4', label: 'Patio', kind: 'link', host: 'example.org', eventCount: 2, status: 'ok', lastSuccessAt: at }),
    ],
  });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars (4)' }));
  const list = within(screen.getByRole('region', { name: 'Your calendars' })).getByRole('list');
  expect(within(list).getAllByRole('listitem').map(lines)).toEqual([
    ['Kitchen', 'File, 12 events', '3 repeating events weren’t imported. Add them as notes with weekdays.'],
    ['Bookings', 'Link, calendar.google.com, 1 event', 'Couldn’t refresh: the link took too long to answer.', updated],
    ['Bar', 'Link, calendar.google.com, 4 events', 'Townwise can’t open this link any more. Remove it and add the link again.', updated],
    // An ok link has no status line.
    ['Patio', 'Link, example.org, 2 events', updated],
  ]);
});

test('a failed list read shows the page notice “Couldn’t load your calendars. Try again.” with the panel closed, whose Try again reads the list and the stored events again', async () => {
  const { api, fake } = setup({ calendars: refusal(503, null) });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const notice = screen.getByText('Couldn’t load your calendars. Try again.');
  expect(region().contains(notice)).toBe(false);
  expect(screen.getByRole('button', { name: 'Your calendars' }).getAttribute('aria-expanded')).toBe('false');
  const reads = fake.paths.length;
  fake.calendars = [KITCHEN];
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy(); });
  const again = fake.paths.slice(reads);
  expect(again).toContain(CALENDARS_PATH);
  expect(again).toContain(`${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`);
  expect(again.filter((path) => path.includes('/forecast?') || path.endsWith('/notes'))).toEqual([]);
  expect(screen.queryByText('Couldn’t load your calendars. Try again.')).toBeNull();
});

test('one calendars notice at a time: the list’s wins over the stored events’, and a failed stored-events read says nothing while the list has no calendar', async () => {
  const EVENTS_NOTICE = 'Couldn’t load the events from your calendars. Try again.';
  const { api, fake } = setup({ calendars: refusal(503, null), ownerEvents: offline() });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.getByText('Couldn’t load your calendars. Try again.')).toBeTruthy();
  expect(screen.queryByText(EVENTS_NOTICE)).toBeNull();
  // Once the list answers with a calendar, the stored events' failure is the one to show.
  fake.calendars = [KITCHEN];
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText(EVENTS_NOTICE)).toBeTruthy();
  expect(screen.queryByText('Couldn’t load your calendars. Try again.')).toBeNull();
  cleanup();

  // The list answered with none: there are no stored events to miss.
  const empty = setup({ calendars: [], ownerEvents: offline() });
  await renderAt('/locations/l1/calendar?day=2026-11-21', empty.api);
  expect(empty.fake.paths).toContain(`${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`);
  expect(screen.queryByText(EVENTS_NOTICE)).toBeNull();
  expect(screen.queryByText('Couldn’t load your calendars. Try again.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

/** A made-up iCal address; the API never sends one back. */
const URL = 'https://calendar.google.com/calendar/ical/sample/private-0a1b2c/basic.ics';

/** Opens the panel and, in it, the add-a-link form; returns the panel. */
function openForm(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^Your calendars/ }));
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  fireEvent.click(within(panel).getByRole('button', { name: 'Add a link' }));
  return panel;
}

function fill(panel: HTMLElement, name: string, link: string): void {
  fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(within(panel).getByLabelText('Calendar link'), { target: { value: link } });
}

test('“Add a link” opens the form in its place: Name and Calendar link with their helpers, Add link and Cancel', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  expect(within(panel).queryByRole('button', { name: 'Add a link' })).toBeNull();
  const name = within(panel).getByLabelText('Name');
  const link = within(panel).getByLabelText('Calendar link');
  expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.textContent).toBe(CALENDARS_COPY.nameHelper);
  expect(document.getElementById(link.getAttribute('aria-describedby') ?? '')?.textContent).toBe(CALENDARS_COPY.linkHelper);
  expect(within(panel).getByRole('button', { name: 'Add link' })).toBeTruthy();
  expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  // The import stays beside it.
  expect(within(panel).getByRole('button', { name: 'Import a calendar file' })).toBeTruthy();
});

test('Add link checks the fields first: an empty or 61-character name, an empty or 2,049-character link, each with its words, and sends nothing', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  const add = within(panel).getByRole('button', { name: 'Add link' });
  fireEvent.click(add);
  expect(within(panel).getByText(CALENDARS_COPY.nameEmpty)).toBeTruthy();
  expect(within(panel).getByText(CALENDARS_COPY.linkEmpty)).toBeTruthy();
  expect(within(panel).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  fill(panel, 'x'.repeat(61), `https://example.org/${'a'.repeat(2049 - 20)}`);
  fireEvent.click(add);
  expect(within(panel).getByText(CALENDARS_COPY.nameLong)).toBeTruthy();
  expect(within(panel).getByText(CALENDARS_COPY.linkLong)).toBeTruthy();
  expect(within(panel).queryByText(CALENDARS_COPY.nameEmpty)).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('a valid link is posted with “Adding…” meanwhile; then the form closes and clears, the panel says what was added, and the list and the stored events are read again', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, '  Bookings ', ` ${URL} `);
  const answer = deferred<unknown>();
  api.answers[CALENDARS_PATH] = () => answer.promise;
  const reads = fake.paths.length;
  fireEvent.click(within(panel).getByRole('button', { name: 'Add link' }));
  const adding = await within(panel).findByRole('button', { name: 'Adding…' });
  expect(adding.getAttribute('aria-disabled')).toBe('true');
  expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'link', label: 'Bookings', url: URL } }]);
  const added = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 3 });
  fake.calendars = [added];
  await act(async () => { answer.resolve({ calendar: added }); await Promise.resolve(); });
  expect(await within(panel).findByText('Added Bookings: 3 events.')).toBeTruthy();
  expect(within(panel).getByText('Added Bookings: 3 events.').getAttribute('role')).toBe('status');
  expect(within(panel).queryByLabelText('Calendar link')).toBeNull();
  await waitFor(() => { expect(within(panel).getByText('Link, calendar.google.com, 3 events')).toBeTruthy(); });
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
  const again = fake.paths.slice(reads);
  expect(again).toContain(CALENDARS_PATH);
  expect(again).toContain(`${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`);
  expect(again.filter((path) => path.includes('/forecast?') || path.endsWith('/notes'))).toEqual([]);
  // The address is never shown or kept: the form starts empty again, and only the POST carried it.
  expect(document.body.innerHTML).not.toContain(URL);
  fireEvent.click(within(panel).getByRole('button', { name: 'Add a link' }));
  expect(within(panel).getByLabelText<HTMLInputElement>('Name').value).toBe('');
  expect(within(panel).getByLabelText<HTMLInputElement>('Calendar link').value).toBe('');
  expect(api.calls.filter((call) => JSON.stringify(call).includes(URL))).toEqual([writes(api)[0]]);
});

test.each([
  ['bad_link', 400, 'Paste a link that starts with https:// or webcal://.'],
  ['blocked_address', 400, 'Townwise doesn’t read calendars from that address. Use the link from your calendar’s settings.'],
  ['unreachable', 400, 'Couldn’t reach that link. Check it and try again.'],
  ['timeout', 400, 'That link took too long to answer. Try again in a few minutes.'],
  ['too_large', 400, 'That calendar is over 1 MB, more than Townwise reads.'],
  ['http_error', 400, 'That link answered with an error. Check it and try again.'],
  ['not_calendar', 400, 'That link doesn’t lead to a calendar. Use its iCal link, which often ends in .ics.'],
  ['calendar_limit', 409, 'This location has 5 calendars, the most it can hold. Remove one to add another.'],
  ['rate_limited', 429, 'Too many attempts. Try again in 2 minutes.'],
  ['calendar_links_unavailable', 503, 'Calendar links aren’t available right now. You can still import a calendar file.'],
])('a link refused with %s (%d) keeps the form open with what was typed, says why as an alert, and reads nothing again', async (code, status, words) => {
  const { api, fake } = setup({ calendars: [KITCHEN] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, 'Bookings', URL);
  api.answers[CALENDARS_PATH] = () => refusal(status, code, code === 'rate_limited' ? 120 : undefined);
  const reads = fake.paths.length;
  fireEvent.click(within(panel).getByRole('button', { name: 'Add link' }));
  expect(await within(panel).findByText(words)).toBeTruthy();
  expect(within(panel).getByText(words).getAttribute('role')).toBe('alert');
  expect(within(panel).getByLabelText<HTMLInputElement>('Name').value).toBe('Bookings');
  expect(within(panel).getByLabelText<HTMLInputElement>('Calendar link').value).toBe(URL);
  expect(within(panel).getByRole('button', { name: 'Add link' }).getAttribute('aria-disabled')).toBeNull();
  expect(fake.paths.slice(reads)).toEqual([]);
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
});

test('Cancel closes the form and clears it', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, 'Bookings', URL);
  fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
  expect(within(panel).queryByLabelText('Calendar link')).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'Add a link' }));
  expect(within(panel).getByLabelText<HTMLInputElement>('Name').value).toBe('');
  expect(within(panel).getByLabelText<HTMLInputElement>('Calendar link').value).toBe('');
  expect(writes(api)).toEqual([]);
});

const REFRESH_PATH = `${CALENDARS_PATH}/c2/refresh` as const;
const NOVEMBER_EVENTS = `${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`;

/** The panel, opened, with Kitchen (a file) and Bookings (a link) listed. */
async function openWithBoth(): Promise<{ api: FakePortalApi; fake: CalendarFake; panel: HTMLElement }> {
  const { api, fake } = setup({ calendars: [KITCHEN, BOOKINGS], ownerEvents: [DINNER] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars (2)' }));
  return { api, fake, panel: screen.getByRole('region', { name: 'Your calendars' }) };
}

function forecastReads(fake: CalendarFake): number {
  return fake.paths.filter((path) => path.includes('/forecast?')).length;
}

test('Refresh now on a link posts its refresh with no body, reads “Refreshing…” meanwhile, then says “Refreshed Bookings.” and reads the list and the stored events again', async () => {
  const { api, fake, panel } = await openWithBoth();
  // A file is never fetched, so its row has no Refresh now.
  const [kitchen] = within(within(panel).getByRole('list')).getAllByRole('listitem');
  if (kitchen === undefined) throw new Error('no row');
  expect(within(kitchen).queryByRole('button', { name: /^Refresh now/ })).toBeNull();
  const answer = deferred<unknown>();
  api.answers[REFRESH_PATH] = () => answer.promise;
  const reads = fake.paths.length;
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  const refreshing = await within(panel).findByRole('button', { name: 'Refreshing…: Bookings' });
  expect(refreshing.textContent).toBe('Refreshing…');
  expect(refreshing.getAttribute('aria-disabled')).toBe('true');
  expect(writes(api)).toEqual([{ method: 'POST', path: REFRESH_PATH, body: undefined }]);
  expect(writes(api)[0]).not.toHaveProperty('body', expect.anything());
  await act(async () => { answer.resolve({ calendar: BOOKINGS }); await Promise.resolve(); });
  expect(await within(panel).findByText('Refreshed Bookings.')).toBeTruthy();
  expect(within(panel).getByText('Refreshed Bookings.').getAttribute('role')).toBe('status');
  await waitFor(() => { expect(fake.paths.slice(reads)).toEqual(expect.arrayContaining([CALENDARS_PATH, NOVEMBER_EVENTS])); });
  // Enabled again once the list read again has answered.
  await waitFor(() => { expect(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }).getAttribute('aria-disabled')).toBeNull(); });
  expect(forecastReads(fake)).toBe(1);
});

test('a refresh that answers with a failed status shows its words on the row and as an alert', async () => {
  const { api, fake, panel } = await openWithBoth();
  const failed = { ...BOOKINGS, status: 'timeout' };
  api.answers[REFRESH_PATH] = () => { fake.calendars = [KITCHEN, failed]; return { calendar: failed }; };
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  const words = 'Couldn’t refresh: the link took too long to answer.';
  await waitFor(() => { expect(within(panel).getAllByText(words)).toHaveLength(2); });
  const [row, alert] = within(panel).getAllByText(words);
  expect(row?.closest('[role="listitem"]')).not.toBeNull();
  expect(alert?.getAttribute('role')).toBe('alert');
  expect(within(panel).queryByText('Refreshed Bookings.')).toBeNull();
});

test.each([
  [refusal(429, 'rate_limited', 240), 'This calendar was refreshed a few minutes ago. Try again in 4 minutes.'],
  [refusal(503, 'calendar_links_unavailable'), 'Calendar links aren’t available right now. This calendar’s events stay as they are.'],
])('a refused refresh says why and reads nothing again (%#)', async (error, words) => {
  const { api, fake, panel } = await openWithBoth();
  api.answers[REFRESH_PATH] = () => error;
  const reads = fake.paths.length;
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  expect(await within(panel).findByText(words)).toBeTruthy();
  expect(within(panel).getByText(words).getAttribute('role')).toBe('alert');
  expect(fake.paths.slice(reads)).toEqual([]);
});

test('Remove asks first; Remove calendar sends one DELETE, says “Removed Kitchen.”, reads the list and the stored events again, and its events leave the grid', async () => {
  const { api, fake, panel } = await openWithBoth();
  const day = (): string => document.querySelector('[role="grid"] [data-date="2026-11-21"]')?.textContent ?? '';
  expect(day()).toContain('Smith rehearsal dinner');
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  let dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  expect(within(dialog).getByText('Its events leave the Calendar. Notes you made from them stay.')).toBeTruthy();
  // Cancel sends nothing.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(writes(api)).toEqual([]);

  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  fake.calendars = [BOOKINGS];
  fake.ownerEvents = [];
  const reads = fake.paths.length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(writes(api)).toEqual([{ method: 'DELETE', path: `${CALENDARS_PATH}/c1`, body: undefined }]);
  expect(within(panel).getByText('Removed Kitchen.').getAttribute('role')).toBe('status');
  await waitFor(() => { expect(day()).not.toContain('Smith rehearsal dinner'); });
  expect(fake.paths.slice(reads)).toEqual(expect.arrayContaining([CALENDARS_PATH, NOVEMBER_EVENTS]));
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
  expect(within(panel).queryByText('Kitchen')).toBeNull();
  expect(forecastReads(fake)).toBe(1);
});

test('a calendar gone in the meantime: a 404 on Refresh now or Remove says “This calendar was already removed.” and reads the list again', async () => {
  const { api, fake, panel } = await openWithBoth();
  api.answers[REFRESH_PATH] = () => refusal(404, 'not_found');
  let reads = fake.paths.length;
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  expect(await within(panel).findByText('This calendar was already removed.')).toBeTruthy();
  await waitFor(() => { expect(fake.paths.slice(reads)).toEqual(expect.arrayContaining([CALENDARS_PATH, NOVEMBER_EVENTS])); });
  // The rows' actions wait until the list has answered.
  await waitFor(() => { expect(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }).getAttribute('aria-disabled')).toBeNull(); });

  // Another message first, so the Remove's own words are seen to arrive.
  api.answers[REFRESH_PATH] = () => refusal(503, 'calendar_links_unavailable');
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  expect(await within(panel).findByText('Calendar links aren’t available right now. This calendar’s events stay as they are.')).toBeTruthy();
  expect(within(panel).queryByText('This calendar was already removed.')).toBeNull();

  fake.deletes[`${CALENDARS_PATH}/c1`] = refusal(404, 'not_found');
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  fake.calendars = [BOOKINGS];
  reads = fake.paths.length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(within(panel).getByText('This calendar was already removed.')).toBeTruthy();
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy(); });
  expect(fake.paths.slice(reads)).toEqual(expect.arrayContaining([CALENDARS_PATH, NOVEMBER_EVENTS]));
  expect(forecastReads(fake)).toBe(1);
});

test('the panel holds “Import a calendar file” and “How importing works”, whose help is hidden but present and describes the import', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars' }));
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  const importButton = within(panel).getByRole('button', { name: 'Import a calendar file' });
  const toggle = within(panel).getByRole('button', { name: 'How importing works' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const help = within(panel).getByText(CALENDARS_COPY.help);
  expect(help.id).not.toBe('');
  expect(toggle.getAttribute('aria-controls')).toBe(help.id);
  expect(importButton.getAttribute('aria-describedby')).toBe(help.id);
  expect(shown(help)).toBe(false);
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(shown(help)).toBe(true);
  fireEvent.click(toggle);
  expect(shown(help)).toBe(false);
});

test('closing the panel keeps a half-typed link and the shown message, and opening it again shows both', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, 'Bookings', URL);
  api.answers[CALENDARS_PATH] = () => refusal(400, 'timeout');
  fireEvent.click(within(panel).getByRole('button', { name: 'Add link' }));
  const words = 'That link took too long to answer. Try again in a few minutes.';
  expect(await within(panel).findByText(words)).toBeTruthy();
  fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'Bookings 2' } });
  const button = screen.getByRole('button', { name: 'Your calendars' });
  fireEvent.click(button);
  expect(shown(region())).toBe(false);
  fireEvent.click(button);
  expect(shown(region())).toBe(true);
  expect(within(panel).getByLabelText<HTMLInputElement>('Name').value).toBe('Bookings 2');
  expect(within(panel).getByLabelText<HTMLInputElement>('Calendar link').value).toBe(URL);
  expect(within(panel).getByText(words).getAttribute('role')).toBe('alert');
  expect(writes(api)).toHaveLength(1);
});

test('a later Add link that fails the form’s own checks clears the last refusal, so the field and the alert never disagree', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, 'Bookings', URL);
  api.answers[CALENDARS_PATH] = () => refusal(400, 'unreachable');
  const add = within(panel).getByRole('button', { name: 'Add link' });
  fireEvent.click(add);
  const refused = 'Couldn’t reach that link. Check it and try again.';
  expect(await within(panel).findByText(refused)).toBeTruthy();
  fireEvent.change(within(panel).getByLabelText('Calendar link'), { target: { value: '' } });
  fireEvent.click(add);
  expect(within(panel).getByText(CALENDARS_COPY.linkEmpty)).toBeTruthy();
  expect(within(panel).queryByText(refused)).toBeNull();
  expect(writes(api)).toHaveLength(1);
});

test('while one link refreshes, every row’s Refresh now is disabled in place, and the others keep their own label and name', async () => {
  const PATIO = ownerCalendar({ id: 'c3', label: 'Patio', kind: 'link', host: 'example.org', eventCount: 2 });
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS, PATIO] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars (3)' }));
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  const answer = deferred<unknown>();
  api.answers[REFRESH_PATH] = () => answer.promise;
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  expect(await within(panel).findByRole('button', { name: 'Refreshing…: Bookings' })).toBeTruthy();
  const patio = within(panel).getByRole('button', { name: 'Refresh now: Patio' });
  expect(patio.textContent).toBe('Refresh now');
  expect(patio.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(patio);
  expect(writes(api)).toEqual([{ method: 'POST', path: REFRESH_PATH, body: undefined }]);
  await act(async () => { answer.resolve({ calendar: BOOKINGS }); await Promise.resolve(); });
  await waitFor(() => { expect(within(panel).getByRole('button', { name: 'Refresh now: Patio' }).getAttribute('aria-disabled')).toBeNull(); });
});

test('a Remove refused for any other reason shows the shared words in the dialog, which stays open, reads nothing again, and opens again without them', async () => {
  const { api, fake, panel } = await openWithBoth();
  const error = refusal(503, null);
  fake.deletes[`${CALENDARS_PATH}/c1`] = error;
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  const reads = fake.paths.length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  expect(await within(dialog).findByText(errorCopy(error))).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Remove this calendar?' })).toBe(dialog);
  expect(within(dialog).getByRole('button', { name: 'Remove calendar' }).getAttribute('aria-disabled')).toBeNull();
  expect(writes(api)).toEqual([{ method: 'DELETE', path: `${CALENDARS_PATH}/c1`, body: undefined }]);
  expect(fake.paths.slice(reads)).toEqual([]);
  expect(within(panel).getByText('Kitchen')).toBeTruthy();
  expect(within(panel).queryByText('Removed Kitchen.')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  const again = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  expect(within(again).queryByText(errorCopy(error))).toBeNull();
});

/** Holds the list's reads until the returned release: a change's read again is still running. */
function holdList(fake: CalendarFake): () => void {
  const held = deferred<undefined>();
  const json = fake.json.bind(fake);
  fake.json = ((...args: Parameters<typeof json>) => (args[0] === CALENDARS_PATH ? held.promise.then(() => json(...args)) : json(...args))) as typeof json;
  return () => { held.resolve(undefined); };
}

test('while the list reads again after a change, it is busy and every row’s Refresh now and Remove are disabled, so a removed row can’t be removed twice', async () => {
  const { api, fake, panel } = await openWithBoth();
  const release = holdList(fake);
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  fake.calendars = [BOOKINGS];
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(within(panel).getByText('Removed Kitchen.')).toBeTruthy();
  // The list hasn't answered: Kitchen is still listed, and nothing in the list can be pressed.
  const list = within(panel).getByRole('list');
  expect(list.getAttribute('aria-busy')).toBe('true');
  for (const name of ['Remove Kitchen', 'Refresh now: Bookings', 'Remove Bookings']) {
    const control = within(list).getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(control);
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(writes(api)).toEqual([{ method: 'DELETE', path: `${CALENDARS_PATH}/c1`, body: undefined }]);
  await act(async () => { release(); await Promise.resolve(); });
  await waitFor(() => { expect(within(panel).queryByText('Kitchen')).toBeNull(); });
  expect(within(panel).getByRole('list').getAttribute('aria-busy')).not.toBe('true');
  expect(within(panel).getByRole('button', { name: 'Remove Bookings' }).getAttribute('aria-disabled')).toBeNull();
  expect(within(panel).getByText('Removed Kitchen.')).toBeTruthy();
});

/** Puts keyboard focus on `element`, as Tab would (Pressable notes its focus in state, hence act). */
function focus(element: HTMLElement): void {
  act(() => { element.focus(); });
}

/** Whether focus is on the panel's messages line that says `text`, a line that takes focus from script (tabIndex -1). */
function focusOnLine(panel: HTMLElement, text: string): boolean {
  const line = within(panel).queryByText(text);
  const active = document.activeElement;
  return line !== null && active !== null && active !== document.body && active.getAttribute('tabindex') === '-1' && active.contains(line);
}

test('focus follows the form: Add a link puts it in Name, Cancel gives it back to Add a link, a refusal leaves it on Add link, and a link added moves it to the line that says so', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  // Nothing takes focus on load, and opening the panel leaves it on the button.
  expect(document.activeElement).toBe(document.body);
  const button = screen.getByRole('button', { name: 'Your calendars' });
  focus(button);
  fireEvent.click(button);
  expect(document.activeElement).toBe(button);
  const panel = screen.getByRole('region', { name: 'Your calendars' });
  const open = within(panel).getByRole('button', { name: 'Add a link' });
  focus(open);
  fireEvent.click(open);
  expect(document.activeElement).toBe(within(panel).getByLabelText('Name'));
  const cancel = within(panel).getByRole('button', { name: 'Cancel' });
  focus(cancel);
  fireEvent.click(cancel);
  expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Add a link' }));

  fireEvent.click(within(panel).getByRole('button', { name: 'Add a link' }));
  fill(panel, 'Bookings', URL);
  const add = within(panel).getByRole('button', { name: 'Add link' });
  focus(add);
  api.answers[CALENDARS_PATH] = () => refusal(400, 'unreachable');
  fireEvent.click(add);
  expect(await within(panel).findByText('Couldn’t reach that link. Check it and try again.')).toBeTruthy();
  expect(document.activeElement).toBe(add);

  const added = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 3 });
  api.answers[CALENDARS_PATH] = () => { fake.calendars = [added]; return { calendar: added }; };
  fireEvent.click(add);
  expect(await within(panel).findByText('Added Bookings: 3 events.')).toBeTruthy();
  await waitFor(() => { expect(focusOnLine(panel, 'Added Bookings: 3 events.')).toBe(true); });
  await waitFor(() => { expect(within(panel).getByText('Link, calendar.google.com, 3 events')).toBeTruthy(); });
  expect(focusOnLine(panel, 'Added Bookings: 3 events.')).toBe(true);
});

test('Remove takes its row away, so once the dialog has closed focus moves to the line that says how it ended, as after a 404; a refresh that worked leaves it on its button', async () => {
  const { api, fake, panel } = await openWithBoth();
  api.answers[REFRESH_PATH] = () => ({ calendar: BOOKINGS });
  const refresh = within(panel).getByRole('button', { name: 'Refresh now: Bookings' });
  focus(refresh);
  fireEvent.click(refresh);
  expect(await within(panel).findByText('Refreshed Bookings.')).toBeTruthy();
  await waitFor(() => { expect(refresh.getAttribute('aria-disabled')).toBeNull(); });
  expect(document.activeElement).toBe(refresh);

  const remove = within(panel).getByRole('button', { name: 'Remove Kitchen' });
  focus(remove);
  fireEvent.click(remove);
  let dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  fake.calendars = [BOOKINGS];
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  await waitFor(() => { expect(focusOnLine(panel, 'Removed Kitchen.')).toBe(true); });
  await waitFor(() => { expect(within(panel).queryByText('Kitchen')).toBeNull(); });
  expect(focusOnLine(panel, 'Removed Kitchen.')).toBe(true);

  // Bookings went in the meantime: a 404 says so, and the list read again takes its row away.
  fake.deletes[`${CALENDARS_PATH}/c2`] = refusal(404, 'not_found');
  const removeBookings = within(panel).getByRole('button', { name: 'Remove Bookings' });
  focus(removeBookings);
  fireEvent.click(removeBookings);
  dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  fake.calendars = [];
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  await waitFor(() => { expect(focusOnLine(panel, 'This calendar was already removed.')).toBe(true); });
  await waitFor(() => { expect(within(panel).getByText(CALENDARS_COPY.none)).toBeTruthy(); });
  expect(focusOnLine(panel, 'This calendar was already removed.')).toBe(true);
});

test('a 404 on Refresh now takes the row away as the list reads again, so focus moves to the line that says so', async () => {
  const { api, fake, panel } = await openWithBoth();
  api.answers[REFRESH_PATH] = () => refusal(404, 'not_found');
  fake.calendars = [KITCHEN];
  const refresh = within(panel).getByRole('button', { name: 'Refresh now: Bookings' });
  focus(refresh);
  fireEvent.click(refresh);
  await waitFor(() => { expect(focusOnLine(panel, 'This calendar was already removed.')).toBe(true); });
  await waitFor(() => { expect(within(panel).queryByText('Bookings')).toBeNull(); });
  expect(focusOnLine(panel, 'This calendar was already removed.')).toBe(true);
});

test('a row’s Remove waits while its own refresh runs, so the refresh can’t answer 404 for a calendar just removed; another row’s Remove still works', async () => {
  const { api, panel } = await openWithBoth();
  const answer = deferred<unknown>();
  api.answers[REFRESH_PATH] = () => answer.promise;
  fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
  expect(await within(panel).findByRole('button', { name: 'Refreshing…: Bookings' })).toBeTruthy();
  const removeBookings = within(panel).getByRole('button', { name: 'Remove Bookings' });
  expect(removeBookings.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(removeBookings);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(panel).getByRole('button', { name: 'Remove Kitchen' }).getAttribute('aria-disabled')).toBeNull();
  expect(writes(api)).toEqual([{ method: 'POST', path: REFRESH_PATH, body: undefined }]);
  await act(async () => { answer.resolve({ calendar: BOOKINGS }); await Promise.resolve(); });
  await waitFor(() => { expect(within(panel).getByRole('button', { name: 'Remove Bookings' }).getAttribute('aria-disabled')).toBeNull(); });
});

test('an answer that lands after focus has left the panel leaves focus where it went: a link added, and a 404 on Refresh now', async () => {
  const { api, fake, panel } = await openWithBoth();
  const cell = document.querySelector<HTMLElement>('[role="grid"] [tabindex="0"]');
  if (cell === null) throw new Error('no focusable cell');

  fireEvent.click(within(panel).getByRole('button', { name: 'Add a link' }));
  fill(panel, 'Patio', URL);
  const answer = deferred<unknown>();
  api.answers[CALENDARS_PATH] = () => answer.promise;
  fireEvent.click(within(panel).getByRole('button', { name: 'Add link' }));
  await within(panel).findByRole('button', { name: 'Adding…' });
  // While Townwise fetches the link, the person moves on to a day of the grid.
  focus(cell);
  const patio = ownerCalendar({ id: 'c3', label: 'Patio', kind: 'link', host: 'calendar.google.com', eventCount: 3 });
  fake.calendars = [KITCHEN, BOOKINGS, patio];
  await act(async () => { answer.resolve({ calendar: patio }); await Promise.resolve(); });
  expect(await within(panel).findByText('Added Patio: 3 events.')).toBeTruthy();
  await waitFor(() => { expect(within(panel).getByText('Patio')).toBeTruthy(); });
  expect(document.activeElement).toBe(cell);

  const gone = deferred<unknown>();
  api.answers[REFRESH_PATH] = () => gone.promise;
  const refresh = within(panel).getByRole('button', { name: 'Refresh now: Bookings' });
  focus(refresh);
  fireEvent.click(refresh);
  await within(panel).findByRole('button', { name: 'Refreshing…: Bookings' });
  focus(cell);
  fake.calendars = [KITCHEN, patio];
  await act(async () => { gone.reject(refusal(404, 'not_found')); await Promise.resolve(); });
  expect(await within(panel).findByText('This calendar was already removed.')).toBeTruthy();
  await waitFor(() => { expect(within(panel).queryByText('Bookings')).toBeNull(); });
  expect(document.activeElement).toBe(cell);
});
