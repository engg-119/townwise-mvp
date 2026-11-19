import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { MeResponse, OrgResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, writes, type FakePortalApi } from '../../helpers/portal';
import { choose } from '../../helpers/select';
import { ownerCalendar, ownerEvent } from '../calendar/fakes';
import { locationsFake } from '../locations/fakes';
import { dataFake } from './fakes';

// A calendar's events as a month grid on its page in Your data, on web (D62): each day's events in its cell (a start
// time, a booking label's tag on a file calendar, the title cut to a line, "+n more"), today marked, one tab stop with
// arrow keys that move the selection, a click that chooses a day and lists its events under the grid with the label
// choice under each, and a hovered day's tooltip with its events in full. Today is Tue, Nov 17, 2026. Made-up titles
// only.

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

const ID = 'aaaabbbbccccdddd00001111';
const BASE = `/api/org/locations/l1/owner-calendars/${ID}`;
const SORTED = { state: 'sorted', sortedAt: '2026-11-16T15:00:00.000Z', confirmedAt: null, counts: { buyout: 1, party: 1, own_event: 0, other: 0, unlabeled: 1 } };
const MASTER = ownerCalendar({ id: ID, label: 'Master calendar', kind: 'file', eventCount: 3, format: 'csv', bookings: SORTED });
const EVENTS = [
  ownerEvent({
    calendarId: ID, calendar: 'Master calendar', uid: 'x/1', title: 'Retirement party', startDate: '2026-11-21', startTime: '18:00', endTime: '21:00',
    booking: 'party', bookingBy: 'ai',
  }),
  ownerEvent({ calendarId: ID, calendar: 'Master calendar', uid: 'x/2', title: 'Wine tasting', startDate: '2026-11-25' }),
  ownerEvent({ calendarId: ID, calendar: 'Master calendar', uid: 'x/3', title: 'Full house dinner', startDate: '2026-11-28', booking: 'buyout', bookingBy: 'person' }),
];

function setup(opts: { me?: MeResponse; org?: OrgResponse; events?: typeof EVENTS } = {}): FakePortalApi {
  const fake = dataFake({ inner: locationsFake() });
  fake.calendars = [MASTER];
  fake.bookingSort = { available: true };
  fake.calendarEvents = opts.events ?? EVENTS;
  const api = fakePortalApi({ me: opts.me ?? meOf(ACCESS.admin), org: opts.org ?? orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/data/c_${ID}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return api;
}

async function shownGrid(): Promise<HTMLElement> {
  const grid = await screen.findByRole('grid', { name: 'Master calendar, November 2026' });
  await within(grid).findByRole('gridcell', { name: /^Sat, Nov 28, 2026\. 1 event/ });
  return grid;
}

function cell(grid: HTMLElement, date: RegExp): HTMLElement {
  return within(grid).getByRole('gridcell', { name: date });
}

test('each day’s cell shows its events with a start time and its booking label’s tag, and says them in full', async () => {
  setup();
  const grid = await shownGrid();
  // Monday first, every weekday named.
  expect(within(grid).getAllByRole('columnheader').map((head) => head.getAttribute('aria-label'))).toEqual([
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ]);
  const party = within(grid).getByRole('gridcell', {
    name: 'Sat, Nov 21, 2026. 1 event: Retirement party, 6 pm to 9 pm, Party, suggested by TownwiseAI.',
  });
  expect(party.textContent).toBe('216 pm Party Retirement party');
  expect(cell(grid, /^Sat, Nov 28, 2026\./).textContent).toBe('28Buyout Full house dinner');
  // An event with no label shows no tag.
  expect(cell(grid, /^Wed, Nov 25, 2026\./).textContent).toBe('25Wine tasting');
  expect(cell(grid, /^Tue, Nov 17, 2026\. Today\./).getAttribute('aria-selected')).toBe('true');
});

test('choosing a day lists its events with the label choice under each; a label set shows on the grid', async () => {
  const api = setup();
  const grid = await shownGrid();
  fireEvent.click(cell(grid, /^Sat, Nov 28, 2026\./));
  const day = screen.getByRole('list', { name: 'Master calendar events, Sat, Nov 28, 2026' });
  expect(within(day).getByRole('link', { name: 'Full house dinner, Sat, Nov 28, 2026. Opens the day on the Calendar. Buyout.' })).toBeTruthy();
  const label = screen.getByRole('combobox', { name: 'Label for Full house dinner, Sat, Nov 28, 2026' });
  const relabeled = { ...MASTER, bookings: { ...SORTED, counts: { ...SORTED.counts, buyout: 0, other: 1 } } };
  api.answers[`${BASE}/bookings`] = () => ({ calendar: relabeled, noteMade: false, noteKept: false });
  choose(label, 'Not a booking');
  expect(await within(grid).findByRole('gridcell', { name: 'Sat, Nov 28, 2026. 1 event: Full house dinner, Not a booking.' })).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'PATCH', path: `${BASE}/bookings`, body: { uid: 'x/3', booking: 'other' } }]);
  expect(cell(grid, /^Sat, Nov 28, 2026\./).textContent).toBe('28Not booking Full house dinner');
});

test('the grid is one tab stop: arrow keys move the selection, and the day’s list follows', async () => {
  setup();
  const grid = await shownGrid();
  expect(within(grid).getAllByRole('gridcell').filter((each) => each.getAttribute('tabindex') === '0')).toHaveLength(1);
  const today = cell(grid, /^Tue, Nov 17, 2026\./);
  act(() => { today.focus(); });
  fireEvent.keyDown(today, { key: 'ArrowDown' });
  const next = cell(grid, /^Tue, Nov 24, 2026\./);
  expect(next.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(next);
  expect(screen.getByText('No events on Tue, Nov 24, 2026.')).toBeTruthy();
  fireEvent.keyDown(next, { key: 'ArrowRight' });
  expect(screen.getByRole('list', { name: 'Master calendar events, Wed, Nov 25, 2026' })).toBeTruthy();
  // Ctrl+End goes to the month's last day; a key past it keeps the day.
  fireEvent.keyDown(document.activeElement ?? next, { key: 'End', ctrlKey: true });
  expect(cell(grid, /^Mon, Nov 30, 2026\./).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(document.activeElement ?? next, { key: 'ArrowRight' });
  expect(cell(grid, /^Mon, Nov 30, 2026\./).getAttribute('aria-selected')).toBe('true');
});

// Review: a key past the month's edge keeps the day, so nothing renders; the grid must not keep that key's focus
// request and take focus back from a control under it on a later render.
test('a key past the month’s edge leaves no focus request behind for a later render', async () => {
  setup();
  const grid = await shownGrid();
  const today = cell(grid, /^Tue, Nov 17, 2026\./);
  act(() => { today.focus(); });
  fireEvent.keyDown(today, { key: 'End', ctrlKey: true });
  const last = cell(grid, /^Mon, Nov 30, 2026\./);
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'ArrowRight' });
  const earlier = screen.getByRole('button', { name: 'Earlier: October 2026' });
  act(() => { earlier.focus(); });
  // A hover re-renders the grid (its tooltip).
  fireEvent.pointerOver(cell(grid, /^Sat, Nov 21, 2026\./), { pointerType: 'mouse' });
  expect(screen.getByTestId('calendar-tooltip')).toBeTruthy();
  expect(document.activeElement).toBe(earlier);
});

// Review: a time and a long tag must not push the title out of a cell's line; the title keeps at least 40% of it,
// the tag giving way first (cut with an ellipsis), the time never.
test('each line keeps a share for the title: the tag gives way first, the time never', async () => {
  setup();
  const grid = await shownGrid();
  const party = cell(grid, /^Sat, Nov 21, 2026\./);
  const time = within(party).getByText('6 pm');
  const tag = within(party).getByText('Party');
  const title = within(party).getByText('Retirement party');
  expect(time.style.flexShrink).toBe('0');
  expect(tag.style.flexShrink).toBe('1');
  expect(tag.style.minWidth).toBe('0');
  expect(tag.style.textOverflow).toBe('ellipsis');
  expect(title.style.flexBasis).toBe('40%');
  expect(title.style.flexShrink).toBe('0');
  expect(title.style.flexGrow).toBe('1');
  expect(title.style.textOverflow).toBe('ellipsis');
});

test('a mouse over a day with events shows its tooltip with them in full; leaving the grid hides it', async () => {
  setup();
  const grid = await shownGrid();
  fireEvent.pointerOver(cell(grid, /^Sat, Nov 21, 2026\./), { pointerType: 'mouse' });
  const tip = screen.getByTestId('calendar-tooltip');
  expect(tip.textContent).toBe('Sat, Nov 21, 2026Retirement party, 6 pm to 9 pm, Party, suggested by TownwiseAI');
  // The day's list under the grid stays on the selected day: a hover only previews in the tooltip.
  expect(screen.getByText('No events on Tue, Nov 17, 2026.')).toBeTruthy();
  fireEvent.pointerLeave(grid, { pointerType: 'mouse' });
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  // A day with none has no tooltip.
  fireEvent.pointerOver(cell(grid, /^Mon, Nov 23, 2026\./), { pointerType: 'mouse' });
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
});

test('a busy day shows three lines and how many more; its label and list hold them all', async () => {
  const busy = Array.from({ length: 5 }, (_, at) => ownerEvent({
    calendarId: ID, calendar: 'Master calendar', uid: `b/${String(at)}`, title: `Tasting ${String(at + 1)}`, startDate: '2026-11-19',
    startTime: `${String(11 + at)}:00`, endTime: `${String(12 + at)}:00`,
  }));
  setup({ events: [...EVENTS, ...busy], me: meOf(ACCESS.member), org: orgOf('member') });
  const grid = await shownGrid();
  const day = cell(grid, /^Thu, Nov 19, 2026\. 5 events: /);
  expect(day.textContent).toBe('1911 am Tasting 1noon Tasting 21 pm Tasting 3+2 more');
  fireEvent.click(day);
  expect(within(screen.getByRole('list', { name: 'Master calendar events, Thu, Nov 19, 2026' })).getAllByRole('listitem')).toHaveLength(5);
});

test('the label filter applies to the grid', async () => {
  setup();
  const grid = await shownGrid();
  choose(screen.getByRole('combobox', { name: 'Show' }), 'Buyout (takes the whole restaurant)');
  expect(cell(grid, /^Sat, Nov 21, 2026\./).getAttribute('aria-label')).toBe('Sat, Nov 21, 2026. No events.');
  expect(cell(grid, /^Sat, Nov 28, 2026\./).getAttribute('aria-label')).toBe('Sat, Nov 28, 2026. 1 event: Full house dinner, Buyout.');
});
