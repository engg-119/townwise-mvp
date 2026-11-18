import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import { GIS_SRC, resetGis, type CodeClientConfig } from '../../../src/auth/gis.web';
import type { GoogleCalendars, GoogleChoice } from '../../../src/portal/calendar/api';
import { CALENDARS_COPY, GOOGLE_COPY, helpText, WEEKLY_TITLES_NOTICE } from '../../../src/portal/calendar/calendars';
import { errorCopy } from '../../../src/portal/errors';
import { formatDate, formatTime } from '../../../src/portal/format';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, meOf, offline, openAsAdminMe, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { CALENDARS_PATH, calendarFake, forecastDay, forecastOf, ownerCalendar, ownerEvent, type CalendarFake } from './fakes';

/** The words on adding a file or a link (calendar-event-suggestions design decision 11). [CONFIRM: the add screens' words] */
const WEEKLY_READING = 'Once a week TownwiseAI reads the titles, dates and hours of the next 3 months of events on a calendar you add here, with email addresses and phone numbers removed, to suggest notes for private events. They reach Anthropic, which doesn’t train on them. An admin of your organization can turn off the weekly reading on the TownwiseAI page.';

// "Your calendars" on web (P28; owner-calendar's "The Calendar page shows and manages stored calendars", refine-calendar-
// and-home design decision 1): the header row's last control, a button with the location's calendar count that opens a
// popover anchored to it, over the page, so nothing under the row moves. The popover lists the calendars, says when the
// list couldn't be read, and holds "Import a calendar file", "Add a link" and "How importing works"; it keeps what was
// typed and shown across closing, and waits while an add, an import or a refresh runs. With Google calendars on
// (google-calendar's "The Your calendars popover connects and picks Google calendars", connect-google-calendar design
// decision 15) it also holds "Add a Google calendar" and its section: the explainer, Google's window (a fake
// `window.google`), the picker and its adds. Today is Wed, Nov 11, 2026. Synthetic figures and made-up names, codes
// and Google ids only.

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

function setup(
  init: Partial<Pick<CalendarFake, 'calendars' | 'ownerEvents'>> = {}, me: MeResponse = meOf(ACCESS.member),
): { api: FakePortalApi; fake: CalendarFake } {
  const days = Array.from({ length: 20 }, (_, at) => forecastDay({ date: `2026-11-${String(11 + at)}` }));
  const fake = calendarFake({
    events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' })],
    forecasts: { '2026-11': forecastOf(days) },
    ...init,
  });
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
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

/** Puts keyboard focus on `element`, as Tab would (Pressable notes its focus in state, hence act). */
function focus(element: HTMLElement): void {
  act(() => { element.focus(); });
}

function calendarsButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Your calendars/ });
}

/** The open popover. */
function popover(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Your calendars' });
}

/** Opens the popover from its button, which a press or Tab has focused first; returns the popover. */
function openPopover(): HTMLElement {
  const button = calendarsButton();
  focus(button);
  fireEvent.click(button);
  return popover();
}

function escape(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); });
}

/** A press on the page around the popover, which lands on its transparent backdrop. */
function pressOutside(): void {
  const backdrop = popover().nextElementSibling;
  if (backdrop === null) throw new Error('no backdrop');
  fireEvent.mouseDown(backdrop);
  fireEvent.mouseUp(backdrop);
}

function shown(element: Element): boolean {
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    if (window.getComputedStyle(at).display === 'none') return false;
  }
  return true;
}

/** The header row: the row the month label's group sits in. */
function headerRow(): HTMLElement {
  const row = screen.getByText('November 2026').parentElement?.parentElement;
  if (row === null || row === undefined) throw new Error('no header row');
  return row;
}

test('with 2 calendars the button reads “Your calendars (2)”, closed with aria-haspopup="dialog", no popover in the document, and the grid directly under the header row', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] });
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const button = screen.getByRole('button', { name: 'Your calendars (2)' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.hasAttribute('aria-controls')).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  const row = headerRow();
  expect(button.parentElement).toBe(row);
  expect(row.lastElementChild).toBe(button);
  expect(row.nextElementSibling?.contains(grid)).toBe(true);
});

test('with none the button reads “Your calendars”', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.getByRole('button', { name: 'Your calendars' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: /^Your calendars \(/ })).toBeNull();
});

test('pressing the button opens the popover: aria-expanded and aria-controls name it, focus is on Close, and it lists the calendars then the import, Add a link and the help', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const button = screen.getByRole('button', { name: 'Your calendars (2)' });
  const dialog = openPopover();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(button.getAttribute('aria-controls')).toBe(dialog.id);
  expect(dialog.id).not.toBe('');
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
  expect(within(dialog).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Your calendars']);
  expect(within(dialog).getByText('File, 12 events')).toBeTruthy();
  expect(within(dialog).getByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  expect(within(dialog).queryByText(CALENDARS_COPY.none)).toBeNull();
  const order = [
    within(dialog).getByText('Kitchen'), within(dialog).getByText('Bookings'), within(dialog).getByRole('button', { name: 'Import a calendar file' }),
    within(dialog).getByRole('button', { name: 'Add a link' }), within(dialog).getByRole('button', { name: 'How importing works' }),
  ];
  order.slice(1).forEach((element, index) => {
    expect((order[index] as Element).compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

test('opening the popover adds nothing to the page: it floats in the Modal, the header row ends with the button, and the grid’s container still follows the row', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] });
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const row = headerRow();
  const children = [...row.children];
  const next = row.nextElementSibling;
  const dialog = openPopover();
  expect([...row.children]).toEqual(children);
  expect(row.nextElementSibling).toBe(next);
  expect(next?.contains(grid)).toBe(true);
  // The Modal renders outside the page, so nothing of the page holds the popover.
  expect(row.parentElement?.contains(dialog)).toBe(false);
});

test('Escape closes it and gives focus back to the button; opened again it shows the form as it was, with focus on Close', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const dialog = openPopover();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add a link' }));
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Bookings' } });
  escape();
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  const button = screen.getByRole('button', { name: 'Your calendars' });
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.hasAttribute('aria-controls')).toBe(false);
  const again = openPopover();
  expect(within(again).getByLabelText<HTMLInputElement>('Name').value).toBe('Bookings');
  expect(document.activeElement).toBe(within(again).getByRole('button', { name: 'Close' }));
  expect(writes(api)).toEqual([]);
});

test('a press outside closes it and selects no day; Close closes it too', async () => {
  const { api } = setup({ calendars: [KITCHEN] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const selected = (): string | null => document.querySelector('[role="grid"] [aria-selected="true"]')?.getAttribute('data-date') ?? null;
  expect(selected()).toBe('2026-11-21');
  openPopover();
  pressOutside();
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  expect(selected()).toBe('2026-11-21');
  expect(window.location.search).toBe('?day=2026-11-21');
  fireEvent.click(within(openPopover()).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  expect(document.activeElement).toBe(calendarsButton());
});

test('with none the open popover says “No calendars yet.”', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(within(openPopover()).getByText('No calendars yet.')).toBeTruthy();
});

test('a failed list read leaves the page showing: “Your calendars”, and the open popover’s Try again reads the list and the stored events again', async () => {
  const { api, fake } = setup({ calendars: refusal(503, null) });
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(grid).toBeTruthy();
  expect(document.querySelector('[role="grid"] [data-date="2026-11-21"]')?.textContent).toContain('Dartmouth home football');
  const panel = openPopover();
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
  fireEvent.click(within(openPopover()).getByRole('button', { name: 'Try again' }));
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
  const list = within(openPopover()).getByRole('list');
  expect(within(list).getAllByRole('listitem').map(lines)).toEqual([
    ['Kitchen', 'File, 12 events', '3 repeating events weren’t imported. Add them as notes with weekdays.'],
    ['Bookings', 'Link, calendar.google.com, 1 event', 'Couldn’t refresh: the link took too long to answer.', updated],
    ['Bar', 'Link, calendar.google.com, 4 events', 'Townwise can’t open this link any more. Remove it and add the link again.', updated],
    // An ok link has no status line.
    ['Patio', 'Link, example.org, 2 events', updated],
  ]);
});

test('a failed list read shows the page notice “Couldn’t load your calendars. Try again.” with the popover closed, whose Try again reads the list and the stored events again', async () => {
  const { api, fake } = setup({ calendars: refusal(503, null) });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.getByText('Couldn’t load your calendars. Try again.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
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

/** Opens the popover and, in it, the add-a-link form; returns the popover. */
function openForm(): HTMLElement {
  const panel = openPopover();
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

test('a valid link is posted with “Adding…” meanwhile; then the form closes and clears, the popover says what was added, and the list and the stored events are read again', async () => {
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
  // Posted from the popover that says titles are read weekly, so the add records that the person was told.
  expect(screen.getAllByText(WEEKLY_READING)).toHaveLength(1);
  expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'link', label: 'Bookings', url: URL, titlesNotice: WEEKLY_TITLES_NOTICE } }]);
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

test('while “Adding…” the popover waits: Escape, Close (disabled in place) and a press outside leave it open, no second post is sent, and a refused link then shows its words in the open form', async () => {
  const { api, fake } = setup({ calendars: [KITCHEN] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, 'Bookings', URL);
  const answer = deferred<unknown>();
  api.answers[CALENDARS_PATH] = () => answer.promise;
  fireEvent.click(within(panel).getByRole('button', { name: 'Add link' }));
  const adding = await within(panel).findByRole('button', { name: 'Adding…' });
  escape();
  const close = within(panel).getByRole('button', { name: 'Close' });
  expect(close.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(close);
  pressOutside();
  fireEvent.click(adding);
  expect(popover()).toBe(panel);
  expect(writes(api)).toHaveLength(1);
  const reads = fake.paths.length;
  await act(async () => { answer.reject(refusal(400, 'blocked_address')); await Promise.resolve(); });
  const words = 'Townwise doesn’t read calendars from that address. Use the link from your calendar’s settings.';
  expect(await within(panel).findByText(words)).toBeTruthy();
  expect(within(panel).getByLabelText<HTMLInputElement>('Name').value).toBe('Bookings');
  expect(within(panel).getByLabelText<HTMLInputElement>('Calendar link').value).toBe(URL);
  expect(within(panel).getByRole('button', { name: 'Close' }).getAttribute('aria-disabled')).toBeNull();
  expect(fake.paths.slice(reads)).toEqual([]);
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
  // Answered, it closes again.
  escape();
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
});

test('a file chosen in the popover is posted named after it, “Importing…” holds the popover open, and the popover says what was added', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openPopover();
  const input = panel.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
  const file = new File([ics], 'Kitchen bookings.ics', { type: 'text/calendar' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(ics) });
  const answer = deferred<unknown>();
  api.answers[CALENDARS_PATH] = () => answer.promise;
  fireEvent.change(input, { target: { files: [file] } });
  expect(await within(panel).findByRole('button', { name: 'Importing…' })).toBeTruthy();
  // Posted from the popover that says titles are read weekly, so the add records that the person was told.
  expect(within(panel).getAllByText(WEEKLY_READING)).toHaveLength(1);
  expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'file', label: 'Kitchen bookings', ics, titlesNotice: WEEKLY_TITLES_NOTICE } }]);
  escape();
  pressOutside();
  expect(popover()).toBe(panel);
  const added = ownerCalendar({ id: 'c3', label: 'Kitchen bookings', kind: 'file', eventCount: 4 });
  fake.calendars = [added];
  await act(async () => { answer.resolve({ calendar: added }); await Promise.resolve(); });
  expect(await within(panel).findByText('Added Kitchen bookings: 4 events.')).toBeTruthy();
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy(); });
  expect(screen.getByRole('button', { name: 'Your calendar' }).getAttribute('aria-pressed')).toBe('true');
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

/** The popover, opened, with Kitchen (a file) and Bookings (a link) listed. */
async function openWithBoth(): Promise<{ api: FakePortalApi; fake: CalendarFake; panel: HTMLElement }> {
  const { api, fake } = setup({ calendars: [KITCHEN, BOOKINGS], ownerEvents: [DINNER] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  return { api, fake, panel: openPopover() };
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
  // The popover waits for the answer.
  expect(within(panel).getByRole('button', { name: 'Close' }).getAttribute('aria-disabled')).toBe('true');
  escape();
  pressOutside();
  expect(popover()).toBe(panel);
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
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
  expect(writes(api)).toEqual([]);

  fireEvent.click(within(panel).getByRole('button', { name: 'Remove Kitchen' }));
  dialog = await screen.findByRole('dialog', { name: 'Remove this calendar?' });
  // While its Remove dialog is open, a press outside the popover leaves it open.
  pressOutside();
  expect(popover()).toBe(panel);
  fake.calendars = [BOOKINGS];
  fake.ownerEvents = [];
  const reads = fake.paths.length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove calendar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
  // The popover stayed open under the dialog, and says how it ended.
  expect(popover()).toBe(panel);
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
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
  expect(within(panel).getByText('This calendar was already removed.')).toBeTruthy();
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy(); });
  expect(fake.paths.slice(reads)).toEqual(expect.arrayContaining([CALENDARS_PATH, NOVEMBER_EVENTS]));
  expect(forecastReads(fake)).toBe(1);
});

test('the popover holds “Import a calendar file” and “How importing works”, whose help is hidden but present and describes the import', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openPopover();
  const importButton = within(panel).getByRole('button', { name: 'Import a calendar file' });
  const toggle = within(panel).getByRole('button', { name: 'How importing works' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const help = within(panel).getByText(helpText(false));
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

test('the popover says once, before “Import a calendar file” and “Add a link”, that TownwiseAI reads a calendar’s titles weekly', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openPopover();
  const [words, ...more] = within(panel).getAllByText(WEEKLY_READING);
  expect(more).toHaveLength(0);
  expect(CALENDARS_COPY.weeklyReading).toBe(WEEKLY_READING);
  for (const name of ['Import a calendar file', 'Add a link']) {
    expect((words as Element).compareDocumentPosition(within(panel).getByRole('button', { name })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  fireEvent.click(within(panel).getByRole('button', { name: 'Add a link' }));
  expect(within(panel).getAllByText(WEEKLY_READING)).toHaveLength(1);
});

test('closing the popover keeps a half-typed link, the shown message and the open help, and opening it again shows them all', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openForm();
  fill(panel, 'Bookings', URL);
  api.answers[CALENDARS_PATH] = () => refusal(400, 'timeout');
  fireEvent.click(within(panel).getByRole('button', { name: 'Add link' }));
  const words = 'That link took too long to answer. Try again in a few minutes.';
  expect(await within(panel).findByText(words)).toBeTruthy();
  fireEvent.change(within(panel).getByLabelText('Name'), { target: { value: 'Bookings 2' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'How importing works' }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
  // Nothing of it is in the page while it is closed.
  expect(screen.queryByLabelText('Calendar link')).toBeNull();
  expect(screen.queryByText(words)).toBeNull();
  const again = openPopover();
  expect(within(again).getByLabelText<HTMLInputElement>('Name').value).toBe('Bookings 2');
  expect(within(again).getByLabelText<HTMLInputElement>('Calendar link').value).toBe(URL);
  expect(within(again).getByText(words).getAttribute('role')).toBe('alert');
  expect(within(again).getByRole('button', { name: 'How importing works' }).getAttribute('aria-expanded')).toBe('true');
  expect(shown(within(again).getByText(helpText(false)))).toBe(true);
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
  const panel = openPopover();
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
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
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
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
  expect(within(panel).getByText('Removed Kitchen.')).toBeTruthy();
  // The list hasn't answered: Kitchen is still listed, and nothing in the list can be pressed.
  const list = within(panel).getByRole('list');
  expect(list.getAttribute('aria-busy')).toBe('true');
  for (const name of ['Remove Kitchen', 'Refresh now: Bookings', 'Remove Bookings']) {
    const control = within(list).getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(control);
  }
  expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull();
  expect(writes(api)).toEqual([{ method: 'DELETE', path: `${CALENDARS_PATH}/c1`, body: undefined }]);
  await act(async () => { release(); await Promise.resolve(); });
  await waitFor(() => { expect(within(panel).queryByText('Kitchen')).toBeNull(); });
  expect(within(panel).getByRole('list').getAttribute('aria-busy')).not.toBe('true');
  expect(within(panel).getByRole('button', { name: 'Remove Bookings' }).getAttribute('aria-disabled')).toBeNull();
  expect(within(panel).getByText('Removed Kitchen.')).toBeTruthy();
});

/** Whether focus is on the popover's messages line that says `text`, a line that takes focus from script (tabIndex -1). */
function focusOnLine(panel: HTMLElement, text: string): boolean {
  const line = within(panel).queryByText(text);
  const active = document.activeElement;
  return line !== null && active !== null && active !== document.body && active.getAttribute('tabindex') === '-1' && active.contains(line);
}

test('focus follows the form: Add a link puts it in Name, Cancel gives it back to Add a link, a refusal leaves it on Add link, and a link added moves it to the line that says so', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  // Nothing takes focus on load, and opening the popover moves it to Close.
  expect(document.activeElement).toBe(document.body);
  const panel = openPopover();
  expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Close' }));
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
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
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
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull(); });
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
  expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull();
  expect(within(panel).getByRole('button', { name: 'Remove Kitchen' }).getAttribute('aria-disabled')).toBeNull();
  expect(writes(api)).toEqual([{ method: 'POST', path: REFRESH_PATH, body: undefined }]);
  await act(async () => { answer.resolve({ calendar: BOOKINGS }); await Promise.resolve(); });
  await waitFor(() => { expect(within(panel).getByRole('button', { name: 'Remove Bookings' }).getAttribute('aria-disabled')).toBeNull(); });
});

test('view-as: the popover lists the calendars, and Import, Add a link, Refresh now and Remove stay disabled in place, described by its read-only line, and send nothing', async () => {
  const { api } = setup({ calendars: [KITCHEN, BOOKINGS] }, viewAsMe(ACCESS.admin));
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const panel = openPopover();
  expect(within(panel).getByText('File, 12 events')).toBeTruthy();
  expect(within(panel).getByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  const line = within(panel).getByText('Read-only while viewing as gm@example.org.');
  expect(line.id).not.toBe('');
  const input = panel.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const picked = jest.spyOn(input, 'click').mockImplementation(() => undefined);
  for (const name of ['Import a calendar file', 'Add a link', 'Refresh now: Bookings', 'Remove Kitchen', 'Remove Bookings']) {
    const control = within(panel).getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(line.id);
    fireEvent.click(control);
  }
  expect(picked).not.toHaveBeenCalled();
  expect(within(panel).queryByLabelText('Calendar link')).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull();
  // The help still works, and so does Close.
  expect(within(panel).getByRole('button', { name: 'How importing works' }).getAttribute('aria-disabled')).toBeNull();
  expect(within(panel).getByRole('button', { name: 'Close' }).getAttribute('aria-disabled')).toBeNull();
  expect(writes(api)).toEqual([]);
});

describe('Google calendars (connect-google-calendar design decision 15)', () => {
  const CLIENT_ID = '123-abc.apps.googleusercontent.com';
  const CODE = '4/0Afake-code';
  const GOOGLE_PATH = '/api/org/locations/l1/google-calendars';
  const PRIMARY: GoogleChoice = { id: 'primary-id', name: 'Owner', primary: true, added: false };
  const SHARED: GoogleChoice = { id: 'c_fake0123@group.calendar.google.com', name: 'Bookings', primary: false, added: false };
  const STAFF: GoogleChoice = { id: 'c_fake4567@group.calendar.google.com', name: 'Staff rota', primary: false, added: false };
  const PRIVATE: GoogleChoice = { id: 'c_fake89ab@group.calendar.google.com', name: 'Private dining', primary: false, added: false };
  const ON: GoogleCalendars = { available: true, connected: false, clientId: CLIENT_ID, canConnect: true };
  /** What the list answers staff under view-as (owner decision, 2026-11-17): on, but not theirs to connect. */
  const VIEW_AS: GoogleCalendars = { ...ON, canConnect: false };

  interface Served {
    google: GoogleCalendars;
    /** What GET .../google-calendars answers, or a promise of it that a test holds. */
    choices: GoogleChoice[] | ApiError | Promise<GoogleChoice[]>;
  }

  beforeEach(() => {
    resetGis();
    delete (window as { google?: unknown }).google;
  });

  /** The list answers `served.google`, and the choices `served.choices`; calendarFake answers neither. */
  function serveGoogle(fake: CalendarFake, served: Served): void {
    const json = fake.json.bind(fake);
    fake.json = ((...args: Parameters<typeof json>) => {
      const [path, schema, opts] = args;
      if ((opts?.method ?? 'GET') !== 'GET') return json(...args);
      if (path === CALENDARS_PATH && !(fake.calendars instanceof ApiError)) {
        fake.paths.push(path);
        return Promise.resolve(schema.parse({ calendars: fake.calendars, google: served.google }));
      }
      if (path === GOOGLE_PATH) {
        fake.paths.push(path);
        const { choices } = served;
        return choices instanceof ApiError ? Promise.reject(choices) : Promise.resolve(choices).then((found) => schema.parse({ calendars: found }));
      }
      return json(...args);
    }) as typeof json;
  }

  async function renderGoogle(
    init: Partial<Pick<CalendarFake, 'calendars'>> & Partial<Served> = {}, me: MeResponse = meOf(ACCESS.member),
  ): Promise<{ api: FakePortalApi; fake: CalendarFake; served: Served }> {
    const { api, fake } = setup(init.calendars === undefined ? {} : { calendars: init.calendars }, me);
    const served: Served = { google: init.google ?? ON, choices: init.choices ?? [PRIMARY, SHARED] };
    serveGoogle(fake, served);
    await renderAt('/locations/l1/calendar?day=2026-11-21', api);
    return { api, fake, served };
  }

  /** Google's script as a fake `window.google`, whose code clients record their configs. */
  function fakeGis(): CodeClientConfig[] {
    const configs: CodeClientConfig[] = [];
    const initCodeClient = (config: CodeClientConfig): { requestCode: () => void } => {
      configs.push(config);
      return { requestCode: () => undefined };
    };
    (window as { google?: unknown }).google = { accounts: { id: { initialize: jest.fn(), renderButton: jest.fn() }, oauth2: { initCodeClient } } };
    return configs;
  }

  /** "Add a Google calendar", the script's load, "Continue to Google", and Google's code for that press. */
  async function connectWith(panel: HTMLElement, api: FakePortalApi, answer: () => unknown): Promise<void> {
    const configs = fakeGis();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    act(() => { document.querySelector(`script[src="${GIS_SRC}"]`)?.dispatchEvent(new Event('load')); });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Continue to Google' }));
    const config = configs.at(-1);
    if (config === undefined) throw new Error('no code client');
    api.answers[`${GOOGLE_PATH}/connect`] = answer;
    act(() => { config.callback({ code: CODE, state: config.state }); });
  }

  function box(panel: HTMLElement, name: string): HTMLInputElement {
    return within(panel).getByRole<HTMLInputElement>('checkbox', { name });
  }

  function closeOf(panel: HTMLElement): HTMLElement {
    return within(panel).getByRole('button', { name: 'Close' });
  }

  test('the actions in order with Google calendars on: Import, Add a link, Add a Google calendar, then the help; a Google row and an unknown kind’s row', async () => {
    const at = '2026-11-14T20:42:00.000Z';
    const google = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40, status: 'google_revoked', lastSuccessAt: at });
    const later = ownerCalendar({ id: 'c4', label: 'Later', kind: 'outlook', host: 'outlook.example.com', eventCount: 3, lastSuccessAt: at });
    await renderGoogle({ calendars: [KITCHEN, BOOKINGS, google, later] });
    const panel = openPopover();
    const order = [
      within(panel).getByRole('button', { name: 'Import a calendar file' }), within(panel).getByRole('button', { name: 'Add a link' }),
      within(panel).getByRole('button', { name: 'Add a Google calendar' }), within(panel).getByRole('button', { name: 'How importing works' }),
    ];
    order.slice(1).forEach((element, index) => {
      expect((order[index] as Element).compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    const [, , googleRow, laterRow] = within(within(panel).getByRole('list')).getAllByRole('listitem');
    if (googleRow === undefined || laterRow === undefined) throw new Error('rows missing');
    expect(lines(googleRow)).toEqual([
      'Google calendar', 'Google calendar, 40 events',
      // A teammate's (not `mine`): no Reconnect, and the words ask whoever added it.
      'Couldn’t refresh: Google no longer lets Townwise read this calendar. Ask whoever added it to reconnect, or remove it.',
      `Updated ${formatDate(at)}, ${formatTime(at)}`,
    ]);
    expect(within(googleRow).getAllByRole('button').map((button) => button.textContent)).toEqual(['Refresh now', 'Remove']);
    expect(lines(laterRow)).toEqual(['Later', 'Calendar, 3 events']);
    expect(within(laterRow).getAllByRole('button').map((button) => button.textContent)).toEqual(['Remove']);
    // The help names Google calendars while they are on.
    expect(within(panel).getByText(helpText(true))).toBeTruthy();
    // Google's script waits for the person.
    expect(document.querySelector(`script[src="${GIS_SRC}"]`)).toBeNull();
  });

  test('Google calendars not available: no “Add a Google calendar”, and a stored Google calendar still lists with Refresh now and Remove', async () => {
    const google = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40 });
    const { api } = await renderGoogle({ calendars: [google], google: { available: false, connected: false, clientId: null, canConnect: false } });
    const panel = openPopover();
    expect(within(panel).queryByRole('button', { name: 'Add a Google calendar' })).toBeNull();
    // The help says nothing of a Google option the popover doesn't offer.
    expect(within(panel).getByText(helpText(false))).toBeTruthy();
    expect(within(panel).queryByText(/Or add a Google calendar/)).toBeNull();
    expect(within(panel).getByText('Google calendar, 40 events')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Refresh now: Google calendar' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Remove Google calendar' })).toBeTruthy();
    api.answers[`${CALENDARS_PATH}/c3/refresh`] = () => ({ calendar: { ...google, status: 'google_unavailable' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Google calendar' }));
    expect((await within(panel).findAllByText('Couldn’t refresh: Townwise couldn’t reach Google.')).length).toBeGreaterThan(0);
  });

  test('connect and pick: the code is posted with the agreement, the picker opens, two adds post one after the other with a line each, the list and the stored events read once, and focus moves to the messages line', async () => {
    const { api, fake } = await renderGoogle();
    const panel = openPopover();
    await connectWith(panel, api, () => ({ calendars: [PRIMARY, SHARED] }));
    expect(await within(panel).findByText('Choose the calendars to add to Main Street Bar.')).toBeTruthy();
    // Posted from the explainer that says titles are read weekly, so the connect records that the person was told.
    expect(writes(api)).toEqual([{ method: 'POST', path: `${GOOGLE_PATH}/connect`, body: { code: CODE, agreed: true, titlesNotice: WEEKLY_TITLES_NOTICE } }]);
    // The picker took the place of Google's wait, so its first control has focus.
    expect(document.activeElement).toBe(box(panel, 'Owner'));
    fireEvent.click(box(panel, 'Owner'));
    fireEvent.click(box(panel, 'Bookings'));
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const answers = [first, second];
    api.answers[CALENDARS_PATH] = () => (answers.shift() ?? first).promise;
    const reads = fake.paths.length;
    fireEvent.click(within(panel).getByRole('button', { name: 'Add 2 calendars' }));
    expect(await within(panel).findByRole('button', { name: 'Adding…' })).toBeTruthy();
    // One at a time: the second waits for the first's answer.
    expect(writes(api).slice(1)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'google', googleCalendarId: PRIMARY.id } }]);
    expect(closeOf(panel).getAttribute('aria-disabled')).toBe('true');
    const owner = ownerCalendar({ id: 'c5', label: 'Google calendar', kind: 'google', eventCount: 40 });
    const bookings = ownerCalendar({ id: 'c6', label: 'Bookings', kind: 'google', eventCount: 3 });
    await act(async () => { first.resolve({ calendar: owner }); await Promise.resolve(); });
    await waitFor(() => { expect(writes(api)).toHaveLength(3); });
    expect(writes(api)[2]).toEqual({ method: 'POST', path: CALENDARS_PATH, body: { kind: 'google', googleCalendarId: SHARED.id } });
    expect(within(panel).getByText('Added Google calendar: 40 events.')).toBeTruthy();
    fake.calendars = [owner, bookings];
    await act(async () => { second.resolve({ calendar: bookings }); await Promise.resolve(); });
    expect(await within(panel).findByText('Added Bookings: 3 events.')).toBeTruthy();
    await waitFor(() => { expect(focusOnLine(panel, 'Added Bookings: 3 events.')).toBe(true); });
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (2)' })).toBeTruthy(); });
    const again = fake.paths.slice(reads);
    expect(again.filter((path) => path === CALENDARS_PATH)).toHaveLength(1);
    expect(again.filter((path) => path === NOVEMBER_EVENTS)).toHaveLength(1);
    expect(again.filter((path) => path.includes('/forecast?') || path.endsWith('/notes'))).toEqual([]);
    // The section closed, and "Add a Google calendar" is back.
    expect(within(panel).queryByText('Choose the calendars to add to Main Street Bar.')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Add a Google calendar' })).toBeTruthy();
    expect(closeOf(panel).getAttribute('aria-disabled')).toBeNull();
    // No code, token or Google id in any path.
    for (const call of api.calls) {
      expect(call.path).not.toContain(CODE);
      expect(call.path).not.toContain(SHARED.id);
    }
  });

  test('a refusal of the connect shows the explainer again with its words, between the explainer and Continue', async () => {
    const { api } = await renderGoogle();
    const panel = openPopover();
    await connectWith(panel, api, () => refusal(409, 'google_other_account'));
    const words = await within(panel).findByText(
      'Choose the Google account you sign in to Townwise with. To add another account’s calendar, share it with that account in Google Calendar first.',
    );
    const explainer = within(panel).getByText(GOOGLE_COPY.explainer);
    const go = within(panel).getByRole('button', { name: 'Continue to Google' });
    expect(document.activeElement).toBe(go);
    // In view next to the focused button, not in the messages line above the long explainer (UI check, 2026-11-16).
    expect(explainer.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(words.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(words.getAttribute('role')).toBe('alert');
    expect(closeOf(panel).getAttribute('aria-disabled')).toBeNull();
  });

  test('a window blocked inside the press shows its words above “Continue to Google” and scrolls Continue into view, each time', async () => {
    await renderGoogle();
    const panel = openPopover();
    // A blocked window answers inside requestCode, in the press itself, so Continue never remounts.
    const initCodeClient = (config: CodeClientConfig): { requestCode: () => void } => ({
      requestCode: () => { config.error_callback({ type: 'popup_failed_to_open' }); },
    });
    (window as { google?: unknown }).google = { accounts: { id: { initialize: jest.fn(), renderButton: jest.fn() }, oauth2: { initCodeClient } } };
    const scrolled: Element[] = [];
    const scrollIntoView = jest.fn(function (this: Element) { scrolled.push(this); });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
    try {
      fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
      act(() => { document.querySelector(`script[src="${GIS_SRC}"]`)?.dispatchEvent(new Event('load')); });
      const go = await within(panel).findByRole('button', { name: 'Continue to Google' });
      fireEvent.click(go);
      const words = await within(panel).findByText(GOOGLE_COPY.popupBlocked);
      expect(words.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.activeElement).toBe(go);
      expect(scrolled).toEqual([go]);
      fireEvent.click(go);
      await waitFor(() => { expect(scrolled).toEqual([go, go]); });
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  test('while the code is posted the popover waits: Escape and a press outside do nothing and Close is disabled', async () => {
    const { api } = await renderGoogle();
    const panel = openPopover();
    const answer = deferred<unknown>();
    await connectWith(panel, api, () => answer.promise);
    expect(within(panel).getByText('Connecting your Google account…')).toBeTruthy();
    expect(within(panel).queryByText('Waiting for Google…')).toBeNull();
    // "Stop waiting" stays in place, disabled, so the focus it had stays in the section.
    const stop = within(panel).getByRole('button', { name: 'Stop waiting' });
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(stop);
    fireEvent.click(stop);
    expect(within(panel).getByText('Connecting your Google account…')).toBeTruthy();
    escape();
    pressOutside();
    expect(screen.getByRole('dialog', { name: 'Your calendars' })).toBe(panel);
    expect(closeOf(panel).getAttribute('aria-disabled')).toBe('true');
    await act(async () => { answer.resolve({ calendars: [PRIMARY] }); await Promise.resolve(); });
    expect(await within(panel).findByRole('checkbox', { name: 'Owner' })).toBeTruthy();
    await waitFor(() => { expect(document.activeElement).toBe(box(panel, 'Owner')); });
    expect(closeOf(panel).getAttribute('aria-disabled')).toBeNull();
  });

  test('while a connected person’s choices are read, “Add a Google calendar” stays in place as “Loading your Google calendars…”, disabled with focus, and the popover waits for them', async () => {
    const choices = deferred<GoogleChoice[]>();
    await renderGoogle({ google: { ...ON, connected: true }, choices: choices.promise });
    const panel = openPopover();
    const action = within(panel).getByRole('button', { name: 'Add a Google calendar' });
    focus(action);
    fireEvent.click(action);
    expect(within(panel).getByRole('button', { name: 'Loading your Google calendars…' })).toBe(action);
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(action);
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    escape();
    pressOutside();
    expect(screen.getByRole('dialog', { name: 'Your calendars' })).toBe(panel);
    expect(closeOf(panel).getAttribute('aria-disabled')).toBe('true');
    await act(async () => { choices.resolve([PRIMARY, SHARED]); await Promise.resolve(); });
    await waitFor(() => { expect(document.activeElement).toBe(box(panel, 'Owner')); });
    expect(closeOf(panel).getAttribute('aria-disabled')).toBeNull();
  });

  test('a connect reads the list again, so once it says the person is connected, “Add a Google calendar” after Cancel reads the choices instead of opening Google’s window again', async () => {
    const revoked = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40, status: 'google_revoked' });
    const { api, fake, served } = await renderGoogle({ calendars: [revoked] });
    // The connect heals that calendar, which the connection then backs, so Cancel's drop is refused.
    fake.deletes['/api/org/google-connection'] = refusal(409, 'google_connection_in_use');
    const panel = openPopover();
    const lists = (): number => fake.paths.filter((path) => path === CALENDARS_PATH).length;
    const before = lists();
    await connectWith(panel, api, () => {
      served.google = { ...ON, connected: true };
      return { calendars: [{ ...PRIMARY, added: true }, SHARED] };
    });
    await within(panel).findByText('Choose the calendars to add to Main Street Bar.');
    await waitFor(() => { expect(lists()).toBe(before + 1); });
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(writes(api).at(-1)?.method).toBe('DELETE'); });
    const scriptsBefore = document.querySelectorAll(`script[src="${GIS_SRC}"]`).length;
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    expect(within(panel).getByRole('button', { name: 'Loading your Google calendars…' })).toBeTruthy();
    expect(await within(panel).findByText('Choose the calendars to add to Main Street Bar.')).toBeTruthy();
    expect(fake.paths.filter((path) => path === GOOGLE_PATH)).toHaveLength(1);
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    expect(document.querySelectorAll(`script[src="${GIS_SRC}"]`)).toHaveLength(scriptsBefore);
    expect(writes(api).filter((call) => call.path.endsWith('/connect'))).toHaveLength(1);
  });

  test('connected: the choices are read first, the primary first with “Your main calendar”, and one already added is checked, disabled and “Added”', async () => {
    const { fake } = await renderGoogle({
      google: { ...ON, connected: true }, choices: [{ ...PRIMARY, added: true }, SHARED],
      calendars: [ownerCalendar({ id: 'c5', label: 'Google calendar', kind: 'google', eventCount: 40 })],
    });
    const panel = openPopover();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    expect(within(panel).getByText('Loading your Google calendars…')).toBeTruthy();
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    expect(await within(panel).findByText('Choose the calendars to add to Main Street Bar.')).toBeTruthy();
    expect(fake.paths).toContain(GOOGLE_PATH);
    expect(document.querySelector(`script[src="${GIS_SRC}"]`)).toBeNull();
    const boxes = within(panel).getAllByRole('checkbox');
    expect(boxes.map((each) => each.closest('label')?.textContent)).toEqual(['Owner', 'Bookings']);
    const owner = box(panel, 'Owner');
    expect(owner.checked).toBe(true);
    expect(owner.getAttribute('aria-disabled')).toBe('true');
    const described = (owner.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Your main calendar', 'Added']);
    expect(box(panel, 'Bookings').checked).toBe(false);
    expect(box(panel, 'Bookings').getAttribute('aria-disabled')).toBeNull();
    expect(within(panel).getByText('This location can add 4 more.')).toBeTruthy();
    expect(within(panel).getByText('To add another Google account’s calendar, share it with this account in Google Calendar first.')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Add calendars' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(box(panel, 'Bookings'));
    expect(within(panel).getByRole('button', { name: 'Add calendar' }).getAttribute('aria-disabled')).toBeNull();
  });

  test.each([
    ['google_reconnect', 'the reconnect words', 'Connect your Google account again to add calendars.'],
    ['google_not_connected', 'no message', null],
  ])('connected, but the choices answer 409 %s: the explainer, with %s', async (code, _shown, words) => {
    await renderGoogle({ google: { ...ON, connected: true }, choices: refusal(409, code) });
    const panel = openPopover();
    fakeGis();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    expect(await within(panel).findByText(GOOGLE_COPY.explainer)).toBeTruthy();
    if (words === null) expect(within(panel).queryByRole('alert')).toBeNull();
    else expect(within(panel).getByText(words)).toBeTruthy();
  });

  test('connected, but Google can’t be reached: the section closes with the words, and “Add a Google calendar” is back', async () => {
    await renderGoogle({ google: { ...ON, connected: true }, choices: refusal(503, 'google_unavailable') });
    const panel = openPopover();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    expect(await within(panel).findByText('Townwise couldn’t reach Google. Try again in a few minutes.')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Add a Google calendar' })).toBeTruthy();
  });

  test('room for two more: with 3 calendars and 4 choices it says “This location can add 2 more.”, and a third check is disabled until one is unchecked', async () => {
    const three = [KITCHEN, BOOKINGS, ownerCalendar({ id: 'c3', label: 'Bar', kind: 'link', host: 'example.org' })];
    await renderGoogle({ calendars: three, google: { ...ON, connected: true }, choices: [PRIMARY, SHARED, STAFF, PRIVATE] });
    const panel = openPopover();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    expect(await within(panel).findByText('This location can add 2 more.')).toBeTruthy();
    fireEvent.click(box(panel, 'Owner'));
    fireEvent.click(box(panel, 'Bookings'));
    expect(box(panel, 'Staff rota').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(box(panel, 'Staff rota'));
    expect(box(panel, 'Staff rota').checked).toBe(false);
    expect(within(panel).getByRole('button', { name: 'Add 2 calendars' })).toBeTruthy();
    fireEvent.click(box(panel, 'Owner'));
    expect(box(panel, 'Staff rota').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(box(panel, 'Staff rota'));
    expect(box(panel, 'Staff rota').checked).toBe(true);
  });

  test('Cancel after connecting, with nothing added, drops the connection and closes the section; Cancel after reading a connected person’s choices drops nothing', async () => {
    const { api } = await renderGoogle();
    const panel = openPopover();
    await connectWith(panel, api, () => ({ calendars: [PRIMARY, SHARED] }));
    await within(panel).findByText('Choose the calendars to add to Main Street Bar.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(within(panel).queryByText('Choose the calendars to add to Main Street Bar.')).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    await waitFor(() => { expect(writes(api).at(-1)).toEqual({ method: 'DELETE', path: '/api/org/google-connection', body: undefined }); });
    cleanup();

    const connected = await renderGoogle({ google: { ...ON, connected: true } });
    const again = openPopover();
    fireEvent.click(within(again).getByRole('button', { name: 'Add a Google calendar' }));
    await within(again).findByText('Choose the calendars to add to Main Street Bar.');
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    expect(writes(connected.api)).toEqual([]);
  });

  test('Cancel’s drop answered 409 or 404 changes nothing on the page', async () => {
    const { api, fake } = await renderGoogle();
    fake.deletes['/api/org/google-connection'] = refusal(409, 'google_connection_in_use');
    const panel = openPopover();
    await connectWith(panel, api, () => ({ calendars: [PRIMARY] }));
    await within(panel).findByText('Choose the calendars to add to Main Street Bar.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(writes(api).at(-1)?.method).toBe('DELETE'); });
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Add a Google calendar' })).toBeTruthy();
  });

  test('the section survives closing: the picker and its checks show again when the popover opens, with focus on Close', async () => {
    await renderGoogle({ google: { ...ON, connected: true } });
    let panel = openPopover();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    await within(panel).findByText('Choose the calendars to add to Main Street Bar.');
    fireEvent.click(box(panel, 'Bookings'));
    escape();
    expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
    panel = openPopover();
    expect(within(panel).getByText('Choose the calendars to add to Main Street Bar.')).toBeTruthy();
    expect(box(panel, 'Bookings').checked).toBe(true);
    expect(within(panel).getByRole('button', { name: 'Add calendar' })).toBeTruthy();
    await waitFor(() => { expect(document.activeElement).toBe(closeOf(panel)); });
  });

  test('a refused add with nothing added keeps the picker and its checks, with the refusal named by the calendar and focus on the add button', async () => {
    const { api } = await renderGoogle({ google: { ...ON, connected: true } });
    const panel = openPopover();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    await within(panel).findByText('Choose the calendars to add to Main Street Bar.');
    fireEvent.click(box(panel, 'Owner'));
    fireEvent.click(box(panel, 'Bookings'));
    const refusals = [refusal(409, 'calendar_already_added'), refusal(400, 'google_forbidden')];
    api.answers[CALENDARS_PATH] = () => refusals.shift();
    const add = within(panel).getByRole('button', { name: 'Add 2 calendars' });
    act(() => { add.focus(); });
    fireEvent.click(add);
    expect(await within(panel).findByText('Bookings: Google won’t share that calendar’s events with Townwise.')).toBeTruthy();
    expect(within(panel).getByText('Owner: This calendar is already on this location.')).toBeTruthy();
    expect(writes(api).filter((call) => call.path === CALENDARS_PATH)).toHaveLength(2);
    expect(box(panel, 'Bookings').checked).toBe(true);
    await waitFor(() => { expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Add 2 calendars' })); });
  });

  test('a refusal that isn’t about one calendar ends the batch; one that says the connection is gone shows the explainer', async () => {
    const { api } = await renderGoogle({ google: { ...ON, connected: true } });
    const panel = openPopover();
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
    await within(panel).findByText('Choose the calendars to add to Main Street Bar.');
    fireEvent.click(box(panel, 'Owner'));
    fireEvent.click(box(panel, 'Bookings'));
    fakeGis();
    api.answers[CALENDARS_PATH] = () => refusal(409, 'google_reconnect');
    fireEvent.click(within(panel).getByRole('button', { name: 'Add 2 calendars' }));
    expect(await within(panel).findByText('Owner: Connect your Google account again to add calendars.')).toBeTruthy();
    expect(within(panel).getByText(GOOGLE_COPY.explainer)).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'google', googleCalendarId: PRIMARY.id } }]);
    await waitFor(() => { expect(focusOnLine(panel, 'Owner: Connect your Google account again to add calendars.')).toBe(true); });
  });

  test('Refresh now on a Google calendar answered google_revoked shows its words above its Updated time', async () => {
    const at = '2026-11-14T20:42:00.000Z';
    const google = ownerCalendar({ id: 'c2', label: 'Google calendar', kind: 'google', eventCount: 40, lastSuccessAt: at });
    const { api, fake } = await renderGoogle({ calendars: [google] });
    const panel = openPopover();
    api.answers[REFRESH_PATH] = () => {
      fake.calendars = [{ ...google, status: 'google_revoked' }];
      return { calendar: { ...google, status: 'google_revoked' } };
    };
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Google calendar' }));
    const words = 'Couldn’t refresh: Google no longer lets Townwise read this calendar. Ask whoever added it to reconnect, or remove it.';
    await waitFor(() => {
      expect(lines(within(within(panel).getByRole('list')).getByRole('listitem'))).toEqual([
        'Google calendar', 'Google calendar, 40 events', words, `Updated ${formatDate(at)}, ${formatTime(at)}`,
      ]);
    });
  });

  const REVOKED = 'Couldn’t refresh: Google no longer lets Townwise read this calendar.';
  const MINE_REVOKED = ownerCalendar({ id: 'c3', label: 'Bookings', kind: 'google', eventCount: 40, status: 'google_revoked', mine: true });

  /** A row's Reconnect, the script's load, and the code client its "Continue to Google" will set up. */
  async function reconnectFrom(panel: HTMLElement, label: string): Promise<CodeClientConfig[]> {
    const configs = fakeGis();
    fireEvent.click(within(panel).getByRole('button', { name: `Reconnect ${label}` }));
    act(() => { document.querySelector(`script[src="${GIS_SRC}"]`)?.dispatchEvent(new Event('load')); });
    await within(panel).findByRole('button', { name: 'Continue to Google' });
    return configs;
  }

  test('Reconnect shows only on a revoked Google calendar the person added, between Refresh now and Remove, with its own words; a teammate’s asks whoever added it', async () => {
    const theirs = ownerCalendar({ id: 'c4', label: 'Staff rota', kind: 'google', eventCount: 2, status: 'google_revoked' });
    const working = ownerCalendar({ id: 'c5', label: 'Private dining', kind: 'google', eventCount: 1, mine: true });
    // A fresh token can't open calendar ids sealed under an old key: still remove and add again, with no Reconnect.
    const sealed = ownerCalendar({ id: 'c6', label: 'Old bookings', kind: 'google', eventCount: 1, status: 'key_mismatch', mine: true });
    await renderGoogle({ calendars: [MINE_REVOKED, theirs, working, sealed] });
    const panel = openPopover();
    const rows = within(within(panel).getByRole('list')).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getAllByRole('button').map((button) => button.textContent))).toEqual([
      ['Refresh now', 'Reconnect', 'Remove'], ['Refresh now', 'Remove'], ['Refresh now', 'Remove'], ['Refresh now', 'Remove'],
    ]);
    expect(within(panel).getByRole('button', { name: 'Reconnect Bookings' })).toBeTruthy();
    const [mineRow, theirRow, , sealedRow] = rows;
    if (mineRow === undefined || theirRow === undefined || sealedRow === undefined) throw new Error('rows missing');
    expect(within(mineRow).getByText(`${REVOKED} Reconnect, or remove it.`)).toBeTruthy();
    expect(within(theirRow).getByText(`${REVOKED} Ask whoever added it to reconnect, or remove it.`)).toBeTruthy();
    expect(within(sealedRow).getByText('Townwise can’t open this Google connection any more. Remove the calendar and add it again.')).toBeTruthy();
  });

  test('while a revoked Google calendar refreshes, its Reconnect waits disabled in place, as its Remove does', async () => {
    const { api } = await renderGoogle({ calendars: [MINE_REVOKED] });
    const panel = openPopover();
    const answer = deferred<unknown>();
    api.answers[`${CALENDARS_PATH}/c3/refresh`] = () => answer.promise;
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh now: Bookings' }));
    expect(await within(panel).findByRole('button', { name: 'Refreshing…: Bookings' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Reconnect Bookings' }).getAttribute('aria-disabled')).toBe('true');
    expect(within(panel).getByRole('button', { name: 'Remove Bookings' }).getAttribute('aria-disabled')).toBe('true');
  });

  test('with Google calendars off, a revoked Google calendar the person added offers no Reconnect and names none', async () => {
    await renderGoogle({ calendars: [MINE_REVOKED], google: { available: false, connected: false, clientId: null, canConnect: false } });
    const panel = openPopover();
    expect(within(panel).queryByRole('button', { name: 'Reconnect Bookings' })).toBeNull();
    expect(within(panel).getByText(`${REVOKED} You can remove it.`)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Remove Bookings' })).toBeTruthy();
  });

  /** Continue to Google from the section Reconnect opened, and Google's code for that press, with the connect answering. */
  function continueWith(panel: HTMLElement, api: FakePortalApi, configs: CodeClientConfig[]): void {
    fireEvent.click(within(panel).getByRole('button', { name: 'Continue to Google' }));
    const config = configs.at(-1);
    if (config === undefined) throw new Error('no code client');
    api.answers[`${GOOGLE_PATH}/connect`] = () => ({ calendars: [PRIMARY, SHARED] });
    act(() => { config.callback({ code: CODE, state: config.state }); });
  }

  test('Reconnect opens the explainer in place of every Reconnect and “Add a Google calendar”; a connect started there shows no picker: the calendar is refreshed now while the popover waits, then the section closes, the reconnected line takes focus, and the list and the stored events read again', async () => {
    const { api, fake } = await renderGoogle({ calendars: [MINE_REVOKED] });
    const panel = openPopover();
    const configs = await reconnectFrom(panel, 'Bookings');
    expect(within(panel).getByText(GOOGLE_COPY.explainer)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Reconnect Bookings' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Add a Google calendar' })).toBeNull();
    const go = within(panel).getByRole('button', { name: 'Continue to Google' });
    expect(document.activeElement).toBe(go);
    fireEvent.click(go);
    const config = configs.at(-1);
    if (config === undefined) throw new Error('no code client');
    const reads = fake.paths.length;
    const refreshed = deferred<unknown>();
    api.answers[`${CALENDARS_PATH}/c3/refresh`] = () => refreshed.promise;
    api.answers[`${GOOGLE_PATH}/connect`] = () => ({ calendars: [PRIMARY, SHARED] });
    act(() => { config.callback({ code: CODE, state: config.state }); });
    // Refresh now on the healed calendar, with no body, while the popover waits for it.
    await waitFor(() => { expect(writes(api)).toHaveLength(2); });
    expect(writes(api)).toEqual([
      { method: 'POST', path: `${GOOGLE_PATH}/connect`, body: { code: CODE, agreed: true, titlesNotice: WEEKLY_TITLES_NOTICE } },
      { method: 'POST', path: `${CALENDARS_PATH}/c3/refresh`, body: undefined },
    ]);
    expect(closeOf(panel).getAttribute('aria-disabled')).toBe('true');
    expect(fake.paths.slice(reads).filter((path) => path === CALENDARS_PATH)).toEqual([]);
    fake.calendars = [{ ...MINE_REVOKED, status: 'ok' }];
    await act(async () => { refreshed.resolve({ calendar: { ...MINE_REVOKED, status: 'ok' } }); await Promise.resolve(); });
    expect(await within(panel).findByText('Reconnected to Google. Your Google calendars are up to date.')).toBeTruthy();
    await waitFor(() => { expect(focusOnLine(panel, GOOGLE_COPY.reconnectedFresh)).toBe(true); });
    // The row shows its real status at once: no words, and no Reconnect.
    await waitFor(() => { expect(within(panel).queryByRole('button', { name: 'Reconnect Bookings' })).toBeNull(); });
    expect(within(panel).queryByText(/Couldn’t refresh/)).toBeNull();
    expect(within(panel).queryByText('Choose the calendars to add to Main Street Bar.')).toBeNull();
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    await waitFor(() => { expect(fake.paths.slice(reads).filter((path) => path === CALENDARS_PATH)).toHaveLength(1); });
    expect(fake.paths.slice(reads).filter((path) => path === NOVEMBER_EVENTS)).toHaveLength(1);
    expect(fake.paths.slice(reads).filter((path) => path === GOOGLE_PATH)).toEqual([]);
    // The section is closed: "Add a Google calendar" is back, and nothing holds the popover.
    expect(within(panel).getByRole('button', { name: 'Add a Google calendar' })).toBeTruthy();
    expect(closeOf(panel).getAttribute('aria-disabled')).toBeNull();
  });

  test('after a reconnect only the person’s own Google calendars are refreshed, one at a time; one still failing leaves “Reconnected to Google.” and its row’s words', async () => {
    const second = ownerCalendar({ id: 'c5', label: 'Private dining', kind: 'google', eventCount: 3, status: 'google_revoked', mine: true });
    const theirs = ownerCalendar({ id: 'c4', label: 'Staff rota', kind: 'google', eventCount: 2, status: 'google_revoked' });
    const { api, fake } = await renderGoogle({ calendars: [KITCHEN, MINE_REVOKED, theirs, second] });
    const panel = openPopover();
    const first = deferred<unknown>();
    api.answers[`${CALENDARS_PATH}/c3/refresh`] = () => first.promise;
    api.answers[`${CALENDARS_PATH}/c5/refresh`] = () => ({ calendar: { ...second, status: 'google_not_found' } });
    continueWith(panel, api, await reconnectFrom(panel, 'Bookings'));
    await waitFor(() => { expect(writes(api)).toHaveLength(2); });
    // One at a time: Private dining waits for Bookings' answer.
    expect(writes(api).map((call) => call.path)).toEqual([`${GOOGLE_PATH}/connect`, `${CALENDARS_PATH}/c3/refresh`]);
    fake.calendars = [KITCHEN, { ...MINE_REVOKED, status: 'ok' }, theirs, { ...second, status: 'google_not_found' }];
    await act(async () => { first.resolve({ calendar: { ...MINE_REVOKED, status: 'ok' } }); await Promise.resolve(); });
    expect(await within(panel).findByText(GOOGLE_COPY.reconnected)).toBeTruthy();
    expect(GOOGLE_COPY.reconnected).toBe('Reconnected to Google.');
    expect(writes(api).map((call) => call.path)).toEqual([`${GOOGLE_PATH}/connect`, `${CALENDARS_PATH}/c3/refresh`, `${CALENDARS_PATH}/c5/refresh`]);
    expect(await within(panel).findByText('Couldn’t refresh: this Google calendar was deleted or is no longer shared with the account that added it.')).toBeTruthy();
  });

  test('a refresh after a reconnect that is refused (refreshed minutes ago) says Townwise reads the calendars within 15 minutes', async () => {
    const { api } = await renderGoogle({ calendars: [MINE_REVOKED] });
    const panel = openPopover();
    api.answers[`${CALENDARS_PATH}/c3/refresh`] = () => refusal(429, 'rate_limited', 240);
    continueWith(panel, api, await reconnectFrom(panel, 'Bookings'));
    expect(await within(panel).findByText('Reconnected to Google. Townwise reads your Google calendars again within 15 minutes.')).toBeTruthy();
    expect(GOOGLE_COPY.reconnectedLater).toBe('Reconnected to Google. Townwise reads your Google calendars again within 15 minutes.');
    expect(closeOf(panel).getAttribute('aria-disabled')).toBeNull();
  });

  test('a refused reconnect shows the explainer again with its words, and Cancel gives focus back to that row’s Reconnect', async () => {
    const { api } = await renderGoogle({ calendars: [MINE_REVOKED] });
    const panel = openPopover();
    const configs = await reconnectFrom(panel, 'Bookings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Continue to Google' }));
    const config = configs.at(-1);
    if (config === undefined) throw new Error('no code client');
    api.answers[`${GOOGLE_PATH}/connect`] = () => refusal(409, 'google_other_account');
    act(() => { config.callback({ code: CODE, state: config.state }); });
    expect(await within(panel).findByText(
      'Choose the Google account you sign in to Townwise with. To add another account’s calendar, share it with that account in Google Calendar first.',
    )).toBeTruthy();
    expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Continue to Google' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Reconnect Bookings' })); });
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    // "Add a Google calendar" came back too, without focus, and opens the section in its own way.
    expect(within(panel).getByRole('button', { name: 'Add a Google calendar' })).toBeTruthy();
  });

  test('view-as: a revoked Google calendar shows the words for anyone else, and staff get no Reconnect, even on a row answered mine', async () => {
    const targets = ownerCalendar({ id: 'c4', label: 'Staff rota', kind: 'google', eventCount: 2, status: 'google_revoked' });
    const { api, fake } = await renderGoogle({ calendars: [targets, MINE_REVOKED], google: VIEW_AS }, viewAsMe(ACCESS.admin));
    const panel = openPopover();
    const [targetRow] = within(within(panel).getByRole('list')).getAllByRole('listitem');
    if (targetRow === undefined) throw new Error('row missing');
    expect(within(targetRow).getByText(`${REVOKED} Ask whoever added it to reconnect, or remove it.`)).toBeTruthy();
    // The API answers staff mine false; and Reconnect needs canConnect as the section does, so none shows either way.
    expect(within(panel).queryByRole('button', { name: /^Reconnect / })).toBeNull();
    expect(document.querySelector(`script[src="${GIS_SRC}"]`)).toBeNull();
    expect(fake.paths).not.toContain(GOOGLE_PATH);
    expect(writes(api)).toEqual([]);
  });

  test('open as admin: staff see “Add a Google calendar” in place, disabled, described by the staff line under the actions, and pressing it opens nothing', async () => {
    const revoked = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40, status: 'google_revoked' });
    const { api, fake } = await renderGoogle({ calendars: [revoked], google: { available: true, connected: false, clientId: null, canConnect: false } }, openAsAdminMe());
    const panel = openPopover();
    const action = within(panel).getByRole('button', { name: 'Add a Google calendar' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    const line = within(panel).getByText('Members of this organization connect their own Google calendars. Staff can’t connect one.');
    expect(GOOGLE_COPY.staffLine).toBe(line.textContent);
    expect(action.getAttribute('aria-describedby')).toBe(line.id);
    // The help names no Google option staff can't use.
    expect(within(panel).getByText(helpText(false))).toBeTruthy();
    expect(within(panel).queryByText(helpText(true))).toBeNull();
    // Under the actions: after the button, before the help.
    expect(action.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(within(panel).getByRole('button', { name: 'How importing works' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(action);
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Continue to Google' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /^Reconnect / })).toBeNull();
    expect(document.querySelector(`script[src="${GIS_SRC}"]`)).toBeNull();
    expect(fake.paths).not.toContain(GOOGLE_PATH);
    expect(writes(api)).toEqual([]);
  });

  test('a member who may connect sees no staff line', async () => {
    await renderGoogle();
    const panel = openPopover();
    expect(within(panel).getByRole('button', { name: 'Add a Google calendar' }).getAttribute('aria-disabled')).toBeNull();
    expect(within(panel).queryByText(GOOGLE_COPY.staffLine)).toBeNull();
    expect(within(panel).getByText(helpText(true))).toBeTruthy();
  });

  test('view-as: “Add a Google calendar” stays in place, disabled and described by the read-only line and the staff line; no choices are read and nothing is sent', async () => {
    const google = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40 });
    const { api, fake } = await renderGoogle({ calendars: [google], google: VIEW_AS }, viewAsMe(ACCESS.admin));
    const panel = openPopover();
    const line = within(panel).getByText('Read-only while viewing as gm@example.org.');
    const staffLine = within(panel).getByText(GOOGLE_COPY.staffLine);
    const action = within(panel).getByRole('button', { name: 'Add a Google calendar' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(action.getAttribute('aria-describedby')?.split(' ')).toEqual([line.id, staffLine.id]);
    fireEvent.click(action);
    expect(within(panel).queryByText(GOOGLE_COPY.explainer)).toBeNull();
    expect(fake.paths).not.toContain(GOOGLE_PATH);
    expect(document.querySelector(`script[src="${GIS_SRC}"]`)).toBeNull();
    for (const name of ['Refresh now: Google calendar', 'Remove Google calendar']) {
      expect(within(panel).getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true');
    }
    expect(writes(api)).toEqual([]);
  });
});
