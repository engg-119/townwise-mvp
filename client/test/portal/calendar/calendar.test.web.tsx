import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { COPY } from '../../../src/portal/errors';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { holiday, townEvent } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';
import { ruleOf } from '../rules/fakes';
import {
  CALENDARS_PATH, calendarFake, forecastDay, forecastOf, NOTES_PATH, ownerCalendar, ownerEvent, PATH, RULES_PATH, savedNote, type CalendarFake,
} from './fakes';

// P28 Calendar on web (spec 16.3, D30): the month grid with each day's published forecast, the
// selected day's panel beside it, notes added, edited and deleted from the day with the forecast read again, the
// filters, view-as, the forecast read failing on its own, no published forecast, the hover tooltip and the keys, and
// the location's own calendars (spec 17, D33: a file posted and kept, its stored events read once per grid, a note made
// from an event without its title). Today is Wed, Nov 11, 2026. Synthetic figures and made-up titles only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; these tests cover the desktop layout unless one
// narrows the page with setWidth.
let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

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
  if (width !== 1280) setWidth(1280);
});

const NOVEMBER_FORECAST = `${PATH}/forecast?from=2026-10-26&to=2026-12-06`;
const GUESTS_HELP = 'Townwise forecasts whole days, so these guests add to the whole day’s total, on each day the note covers.';
const GAME = townEvent({ start: '2026-11-21', title: 'Dartmouth home football' });
const VETERANS = holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day');
const GAME_REASON = { kind: 'event', label: 'Dartmouth home football', effectPct: null, effect: { direction: 'more', pct: 20, basis: 'history', days: 5 } as const,
  sources: [{ label: 'dartmouthsports.com', url: 'https://dartmouthsports.com/' }], note: null };
const SATURDAY_REASON = { kind: 'weekday', label: 'Saturday', effectPct: null, effect: { direction: 'more', pct: 35, basis: 'history', days: 52 } as const, sources: [], note: null };

/** November from today on, with the game on the 21st; `noted` adds the location's notes to that day as the API would. */
function november(noted?: { guests: number; id: string }): unknown {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    if (date !== '2026-11-21') { days.push(forecastDay({ date })); continue; }
    days.push(noted === undefined
      ? forecastDay({ date, reasons: [GAME_REASON, SATURDAY_REASON] })
      : forecastDay({
        date, low: 180 + noted.guests, mid: 212 + noted.guests, high: 240 + noted.guests, model: { status: 'open', low: 180, mid: 212, high: 240 },
        noteGuests: noted.guests,
        reasons: [
          { kind: 'note', label: `Your private event, ${String(noted.guests)} guests`, effectPct: null, sources: [], note: { id: noted.id, guests: noted.guests, outcome: 'added' } },
          GAME_REASON, SATURDAY_REASON,
        ],
      }));
  }
  return forecastOf(days);
}

function setup(
  me: MeResponse = meOf(ACCESS.member), init: Partial<Pick<CalendarFake, 'notes' | 'rules' | 'forecasts' | 'calendars' | 'ownerEvents'>> = {},
): { api: FakePortalApi; fake: CalendarFake } {
  const fake = calendarFake({
    events: [GAME, VETERANS],
    days: [{ date: '2026-11-07', guests: 138, netSalesCents: 276000 }],
    forecasts: { '2026-11': november() },
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

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
  if (found === null) throw new Error(`no cell for ${date}`);
  return found;
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Selected day' });
}

/** The note form's popover, which must be open: the dialog its heading names ("Add an event", "Edit note", "Make a note"). */
function noteForm(name: string): HTMLElement {
  return screen.getByRole('dialog', { name });
}

/** An element whose whole text is `text` (the day's figure nests its number in its own span). */
function whole(text: string): (content: string, element: Element | null) => boolean {
  return (_content, element) => element?.textContent === text && [...element.children].every((child) => child.textContent !== text);
}

/** jsdom has no PointerEvent, so `pointerType` is set on a plain one. */
function pointer(type: string, pointerType: 'mouse' | 'touch'): Event {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

function forecastReads(fake: CalendarFake): string[] {
  return fake.paths.filter((path) => path.includes('/forecast?'));
}

/** An exported calendar: a timed dinner on Sat, Nov 21, two all-day days, and a weekly meeting that isn't imported. */
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Calendar//EN',
  'BEGIN:VEVENT', 'UID:i1', 'SUMMARY:Smith rehearsal dinner', 'DTSTART:20261121T180000', 'DTEND:20261121T210000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:i2', 'SUMMARY:Owner away', 'DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261126', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:i3', 'SUMMARY:Weekly staff meeting', 'DTSTART:20261102T090000', 'DTEND:20261102T100000', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

// The list here answers without `google` (Google calendars off), so the help names none.
const HELP = 'Import a calendar exported from Google Calendar, Outlook or Apple Calendar as an .ics file, or a calendar CSV with event_id, title, start_at and end_at columns, or add its iCal link, which Townwise reads again about every 6 hours. Townwise keeps each event’s title, dates and hours until you remove the calendar, and nothing else from it. From a CSV, Townwise keeps each event’s title, dates and hours and never reads its other columns. TownwiseAI reads the titles, so they can reach Anthropic when you ask about your bookings. Events change the forecast only through notes you make from them. To update a file, remove it and import the new export.';
const TOO_LARGE = 'This file is over 1 MB. Export a shorter range of your calendar, or a CSV with fewer columns.';
const NOT_CALENDAR = 'That isn’t a calendar. Import an .ics file, or a CSV with event_id, title, start_at and end_at columns.';
const CALENDAR_LIMIT = 'This location has 5 calendars, the most it can hold. Remove one to add another.';
const NOVEMBER_EVENTS = `${CALENDARS_PATH}/events?from=2026-10-26&to=2026-12-06`;

/** kitchen.ics as the API keeps it: its two single events, and the weekly meeting counted, not imported. */
const KITCHEN = ownerCalendar({ id: 'c1', label: 'kitchen', kind: 'file', eventCount: 2, skippedRepeating: 1 });
const DINNER = ownerEvent({
  calendarId: 'c1', calendar: 'kitchen', uid: 'i1', title: 'Smith rehearsal dinner', startDate: '2026-11-21', startTime: '18:00', endTime: '21:00',
});
const AWAY = ownerEvent({ calendarId: 'c1', calendar: 'kitchen', uid: 'i2', title: 'Owner away', startDate: '2026-11-24', endDate: '2026-11-25' });

/** The "Your calendars" popover, which must be open. */
function calendarsPanel(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Your calendars' });
}

/** Closes the "Your calendars" popover, which floats over the page, before the page is used again. */
function closeCalendars(): void {
  fireEvent.click(within(calendarsPanel()).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
}

function storedReads(fake: CalendarFake): string[] {
  return fake.paths.filter((path) => path.startsWith(`${CALENDARS_PATH}/events?`));
}

/** `size` stands in for the file's size on disk; a file given one throws if it is read. */
function icsFile(text: string, name = 'kitchen.ics', size?: number): File {
  const file = new File([text], name, { type: 'text/calendar' });
  // jsdom's Blob has no text(); the import reads files with File.text().
  const read = size === undefined ? () => Promise.resolve(text) : () => { throw new Error('read a file over 1 MB'); };
  Object.defineProperty(file, 'text', { value: read });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** Opens the "Your calendars" popover when it is closed, then chooses the file in its import. */
function chooseFile(file: File): void {
  const calendars = screen.getByRole('button', { name: /^Your calendars/ });
  if (calendars.getAttribute('aria-expanded') !== 'true') fireEvent.click(calendars);
  expect(calendars.getAttribute('aria-expanded')).toBe('true');
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  expect(input.getAttribute('accept')).toBe('.ics,text/calendar,.csv,text/csv');
  fireEvent.change(input, { target: { files: [file] } });
}

test('opens at ?day= with that day selected and in the sidebar', async () => {
  const { api } = setup();
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.getByRole('link', { name: 'Calendar' }).getAttribute('aria-current')).toBe('page');
  expect(cell('2026-11-21').getAttribute('aria-selected')).toBe('true');
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(cell('2026-11-21').getAttribute('tabindex')).toBe('0');
  // Each cell's label says everything it shows; a past day shows its stored guests, never a forecast.
  expect(cell('2026-11-21').getAttribute('aria-label')).toBe('Sat, Nov 21, 2026. 212 guests, forecast, likely 180 to 240. Dartmouth home football.');
  expect(cell('2026-11-07').getAttribute('aria-label')).toBe('Sat, Nov 7, 2026. 138 guests, actual.');
  expect(cell('2026-11-07').textContent).toContain('138');
  const day = panel();
  expect(within(day).getByRole('heading', { name: 'Sat, Nov 21, 2026' })).toBeTruthy();
  expect(within(day).getByText(whole('About 212 guests'))).toBeTruthy();
  expect(within(day).getByText('Likely 180 to 240. About 8 in 10 days land in the range.')).toBeTruthy();
  // Why: one row per reason, biggest effect first, each saying in words which way it usually moves guests; the mark
  // before the words is hidden from screen readers, which hear the same words.
  const why = within(day).getAllByRole('listitem');
  expect(why.map((row) => row.textContent)).toEqual([
    'Saturday▲Usually about 35% more guests than your average day',
    'Dartmouth home football▲Usually about 20% more guests than the same weekday without itDartmouth Athletics',
  ]);
  for (const mark of within(day).getAllByText('▲')) expect(mark.closest('[aria-hidden="true"]')).not.toBeNull();
  // The row ends with its source as a chip under its words: the site's name, and a name that starts with it.
  const game = why[1];
  if (game === undefined) throw new Error('no second reason');
  const source = within(game).getByRole('link', { name: 'Dartmouth Athletics. Source: dartmouthsports.com' });
  expect(source.getAttribute('href')).toBe('https://dartmouthsports.com/');
  expect(source.textContent).toBe('Dartmouth Athletics');
  // On the calendar no longer repeats the game Why shows.
  expect(within(day).queryByText('Dartmouth home football. Town event.')).toBeNull();
  expect(within(day).queryByRole('link', { name: 'Dartmouth. Source: home.dartmouth.edu' })).toBeNull();
  expect(within(day).getByText('Nothing else on the calendar this day.')).toBeTruthy();
});

test('Why reads at phone width: the label, then the effect in words, then the source', async () => {
  setWidth(375);
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const game = within(panel()).getAllByRole('listitem')[1];
  if (game === undefined) throw new Error('no second reason');
  expect(within(game).getByText('Dartmouth home football')).toBeTruthy();
  expect(within(game).getByText(/^Usually about 20% more guests than the same weekday without it/)).toBeTruthy();
  expect(within(game).getByRole('link', { name: 'Dartmouth Athletics. Source: dartmouthsports.com' })).toBeTruthy();
});

test('several sources: each chip’s name starts with what it shows (WCAG 2.5.3), and each is a 44px target on web', async () => {
  const sources = [...GAME_REASON.sources, { label: 'Sample events page', url: 'https://example.org/events' }];
  const days = (november() as { days: { date: string }[] }).days.map((day) => (day.date === '2026-11-21'
    ? forecastDay({ date: '2026-11-21', reasons: [{ ...GAME_REASON, sources }, SATURDAY_REASON] }) : day));
  const { api } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': forecastOf(days as never) } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const game = within(panel()).getAllByRole('listitem')[1];
  if (game === undefined) throw new Error('no second reason');
  const links = within(game).getAllByRole('link');
  expect(links.map((link) => [link.textContent, link.getAttribute('aria-label')])).toEqual([
    ['Dartmouth Athletics', 'Dartmouth Athletics. Source: dartmouthsports.com'], ['example.org', 'example.org. Source: Sample events page'],
  ]);
  for (const link of links) expect(window.getComputedStyle(link).minHeight).toBe('44px');
});

test('a business rule with a schedule (D31): its reason shows under Why, and the rule under On the calendar with its summary and a link to Rules', async () => {
  const closedMondays = ruleOf('r1', 'Sentinel shut Mondays', {
    schedule: { kind: 'closure', startDate: '2026-11-01', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    scheduleSummary: 'Closed on Mondays from Nov 1, 2026',
  });
  const days = (november() as { days: unknown[] }).days.map((day) => ((day as { date: string }).date === '2026-11-16' ? forecastDay({
    date: '2026-11-16', status: 'closed', low: null, mid: null, high: null,
    reasons: [{ kind: 'rule', label: 'Your rule: closed on Mondays', effectPct: null, sources: [], note: null, rule: { id: 'r1', guests: null, outcome: 'closed' } }],
  }) : day));
  const { api } = setup(meOf(ACCESS.member), { rules: [closedMondays, ruleOf('r2', 'Patio opens in May')], forecasts: { '2026-11': forecastOf(days as never) } });
  await renderAt('/locations/l1/calendar?day=2026-11-16', api);
  const day = panel();
  expect(within(day).getByText('Closed.')).toBeTruthy();
  expect(within(day).getByText('From your business rule.')).toBeTruthy();
  expect(within(day).getByText('Your rule: closed on Mondays')).toBeTruthy();
  expect(within(day).getByText('Closes the day')).toBeTruthy();
  expect(within(day).getByText('Your rule: Sentinel shut Mondays')).toBeTruthy();
  expect(within(day).getByText('Closed on Mondays from Nov 1, 2026')).toBeTruthy();
  expect(within(day).queryByText('Your rule: Patio opens in May')).toBeNull();
  // No inline Edit: the rule is changed on the Rules page.
  const link = within(day).getByRole('link', { name: 'Open business rules' });
  expect(link.getAttribute('href')).toBe('/locations/l1/rules');
  expect(within(day).queryByRole('button', { name: /Sentinel/ })).toBeNull();
  // A day no rule covers lists none.
  fireEvent.click(cell('2026-11-17'));
  await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Tue, Nov 17, 2026' })).toBeTruthy(); });
  expect(within(panel()).queryByText(/^Your rule: /)).toBeNull();
});

test('the forecast read covers exactly the shown grid (one request of at most 42 days)', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar', api);
  expect(cell('2026-11-11').getAttribute('aria-selected')).toBe('true');
  expect(within(panel()).getByRole('heading', { name: 'Today, Wed, Nov 11' })).toBeTruthy();
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST]);
  // Sales days only for the grid's past part, and the 8 weeks before it that likely closed reads (spec D32).
  expect(fake.paths.filter((path) => path.includes('/sales/days?'))).toEqual([`${PATH}/sales/days?from=2026-08-31&to=2026-11-10`]);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST, `${PATH}/forecast?from=2026-11-30&to=2027-01-10`]);
  // A grid after today has no past part to read.
  expect(fake.paths.filter((path) => path.includes('/sales/days?'))).toHaveLength(1);
  expect(screen.getByText('December 2026')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  cleanup();

  // The last month the page shows: Next month is disabled in place.
  await renderAt('/locations/l1/calendar?day=2027-11-05', setup().api, 'November 2027');
  expect(screen.getByRole('button', { name: 'Next month' }).getAttribute('aria-disabled')).toBe('true');
});

test('adding a private event of 70 posts the note, reloads the forecast and the day shows +70 and the reason', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Add an event' }));
  const form = noteForm('Add an event');
  expect(within(form).getByRole('button', { name: 'Private event' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(form).getByRole('button', { name: 'More guests than usual' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(form).getByLabelText<HTMLInputElement>('Starts').value).toBe('2026-11-21');
  // Forecasts are daily, so the guests count toward the whole day, whatever the hours (spec 12).
  expect(within(form).getByText(GUESTS_HELP)).toBeTruthy();
  fireEvent.click(within(form).getByRole('button', { name: 'Opening' }));
  expect(within(form).queryByText(GUESTS_HELP)).toBeNull();
  fireEvent.click(within(form).getByRole('button', { name: 'Private event' }));
  fireEvent.change(within(form).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november({ guests: 70, id: 'n9' });
    return saved;
  };
  fireEvent.click(within(form).getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: NOTES_PATH,
    body: {
      kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
      title: null, startTime: null, endTime: null,
    },
  }]);
  await waitFor(() => { expect(cell('2026-11-21').getAttribute('aria-label')).toContain('Includes 70 guests from your notes.'); });
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST, NOVEMBER_FORECAST]);
  expect(cell('2026-11-21').textContent).toContain('+70');
  expect(cell('2026-11-21').textContent).toContain('282');
  const day = panel();
  expect(within(day).getByText(whole('About 282 guests'))).toBeTruthy();
  expect(within(day).getByText('Townwise’s model: 180 to 240. About 8 in 10 days land in that range. Your notes add 70 guests.')).toBeTruthy();
  expect(within(day).getByText('Your private event, 70 guests')).toBeTruthy();
  expect(within(day).getByText('Adds 70 guests')).toBeTruthy();
});

test('a saved note that changes nothing says so, from the day read again: no guest count', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Add an event' }));
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    const days = (november() as { days: { date: string; reasons: unknown[] }[] }).days.map((day) => (day.date !== '2026-11-21' ? day : {
      ...day,
      reasons: [...day.reasons, { kind: 'note', label: 'Your private event', effectPct: null, sources: [], note: { id: 'n9', guests: null, outcome: 'no_guest_count' } }],
    }));
    fake.forecasts['2026-11'] = forecastOf(days as Parameters<typeof forecastOf>[0]);
    return saved;
  };
  fireEvent.click(within(noteForm('Add an event')).getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved. Add a guest count to change the forecast.')).toBeTruthy();
  expect(screen.queryByText(/now includes/)).toBeNull();
  expect(within(panel()).getByText('No guest count, so the forecast is unchanged')).toBeTruthy();
});

test('editing and deleting a note reload the forecast', async () => {
  const party = noteOf('n1', { kind: 'private_event', effect: 'more_guests', startDate: '2026-11-21', endDate: '2026-11-21', expectedGuests: 40 });
  const { api, fake } = setup(meOf(ACCESS.member), { notes: [party], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(within(panel()).getByText('Adds 40 guests')).toBeTruthy();
  fireEvent.click(within(panel()).getByRole('button', { name: 'Edit Private event note, Nov 21, 2026' }));
  const form = noteForm('Edit note');
  expect(within(form).getByLabelText<HTMLInputElement>('Expected guests (optional)').value).toBe('40');
  fireEvent.change(within(form).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[`${NOTES_PATH}/n1`] = (body) => {
    const saved = savedNote('n1', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november({ guests: 70, id: 'n1' });
    return saved;
  };
  fireEvent.click(within(form).getByRole('button', { name: 'Save note' }));
  expect(await within(panel()).findByText('Adds 70 guests')).toBeTruthy();
  expect(forecastReads(fake)).toHaveLength(2);
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`PATCH ${NOTES_PATH}/n1`]);

  fireEvent.click(within(panel()).getByRole('button', { name: 'Delete Private event note, Nov 21, 2026' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this note?' });
  expect(within(dialog).getByText('The forecast for its days goes back to Townwise’s model.')).toBeTruthy();
  fake.notes = [];
  fake.forecasts['2026-11'] = november();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }));
  expect(await screen.findByText('Deleted the note.')).toBeTruthy();
  await waitFor(() => { expect(within(panel()).queryByText(/Adds \d+ guests/)).toBeNull(); });
  expect(forecastReads(fake)).toHaveLength(3);
  expect(within(panel()).getByText(whole('About 212 guests'))).toBeTruthy();
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`PATCH ${NOTES_PATH}/n1`, `DELETE ${NOTES_PATH}/n1`]);
});

test('turning off Town events hides their chips but not the figures', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(cell('2026-11-21').textContent).toContain('Dartmouth home football');
  const filter = screen.getByRole('button', { name: 'Town events' });
  expect(filter.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(filter);
  expect(filter.getAttribute('aria-pressed')).toBe('false');
  expect(cell('2026-11-21').textContent).not.toContain('Dartmouth home football');
  expect(cell('2026-11-21').textContent).toContain('212');
  expect(cell('2026-11-21').getAttribute('aria-label')).toBe('Sat, Nov 21, 2026. 212 guests, forecast, likely 180 to 240.');
  // The panel's calendar list follows the filter; the forecast's own reasons stay.
  expect(within(panel()).queryByText('Dartmouth home football. Town event.')).toBeNull();
  expect(within(panel()).getByText('Dartmouth home football')).toBeTruthy();
  // Holidays are their own filter.
  expect(cell('2026-11-11').getAttribute('aria-label')).toContain('Veterans Day.');
  fireEvent.click(screen.getByRole('button', { name: 'Holidays' }));
  expect(cell('2026-11-11').getAttribute('aria-label')).not.toContain('Veterans Day.');
});

test('a calendar file is posted and kept, its events show once read again, and Make a note opens the form with dates and hours and an empty detail', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  const answer = deferred<unknown>();
  api.answers[CALENDARS_PATH] = () => answer.promise;
  const reads = fake.paths.length;
  chooseFile(icsFile(ICS, 'kitchen.ics'));
  expect(within(calendarsPanel()).getByText(HELP)).toBeTruthy();
  expect(await within(calendarsPanel()).findByRole('button', { name: 'Importing…' })).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'file', label: 'kitchen', ics: ICS, titlesNotice: 1 } }]);
  // The API keeps the calendar and its two events.
  fake.calendars = [KITCHEN];
  fake.ownerEvents = [DINNER, AWAY];
  await act(async () => { answer.resolve({ calendar: KITCHEN }); await Promise.resolve(); });
  expect(await within(calendarsPanel()).findByText('Added kitchen: 2 events.')).toBeTruthy();
  // The messages line; the calendar's row says the same of its repeating event once the list is read again.
  expect(within(calendarsPanel()).getAllByRole('status').map((line) => line.textContent)).toEqual([
    'Added kitchen: 2 events.', '1 repeating event wasn’t imported. Add it as a note with weekdays.',
  ]);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy(); });
  await waitFor(() => { expect(cell('2026-11-21').textContent).toContain('Smith rehearsal dinner'); });
  // The list and the grid's stored events are read again; stored events never change the forecast, so neither it nor
  // the notes and rules are.
  const again = fake.paths.slice(reads);
  expect(again).toContain(CALENDARS_PATH);
  expect(again).toContain(NOVEMBER_EVENTS);
  expect(again.filter((path) => path.includes('/forecast?') || path === NOTES_PATH || path === RULES_PATH)).toEqual([]);
  expect(writes(api)).toHaveLength(1);
  closeCalendars();
  const chip = screen.getByRole('button', { name: 'Your calendar' });
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  expect(cell('2026-11-25').textContent).toContain('Owner away');
  // Only notes change the forecast.
  expect(cell('2026-11-21').textContent).toContain('212');
  const day = panel();
  expect(within(day).getByText('From your calendar: Smith rehearsal dinner')).toBeTruthy();
  expect(within(day).getByText('Nov 21, 2026, 6 pm to 9 pm')).toBeTruthy();
  expect(within(day).getByText('Events from your calendar don’t change the forecast until you make a note from them.')).toBeTruthy();

  // Turning the filter off hides the calendar's events from the grid and the panel.
  fireEvent.click(chip);
  expect(cell('2026-11-21').textContent).not.toContain('Smith rehearsal dinner');
  expect(within(panel()).queryByText('From your calendar: Smith rehearsal dinner')).toBeNull();
  fireEvent.click(chip);

  fireEvent.click(within(panel()).getByRole('button', { name: 'Make a note from Smith rehearsal dinner' }));
  const form = noteForm('Make a note');
  expect(within(form).getByRole('button', { name: 'Private event' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(form).getByRole('button', { name: 'More guests than usual' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(form).getByLabelText<HTMLInputElement>('Starts').value).toBe('2026-11-21');
  expect(within(form).getByLabelText<HTMLInputElement>('Ends (optional)').value).toBe('');
  expect(within(form).getByLabelText<HTMLInputElement>('Starts at').value).toBe('18:00');
  expect(within(form).getByLabelText<HTMLInputElement>('Ends at').value).toBe('21:00');
  // Calendar titles often name customers, so the detail starts empty.
  expect(within(form).getByLabelText<HTMLInputElement>('Details (optional)').value).toBe('');
  fireEvent.change(within(form).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november({ guests: 70, id: 'n9' });
    return saved;
  };
  fireEvent.click(within(form).getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  // The note names its event by calendar id and uid (calendar-event-suggestions), so a move or a cancellation at the
  // source can be followed; the API reads the event's dates itself.
  expect(writes(api).slice(1)).toEqual([{
    method: 'POST', path: NOTES_PATH,
    body: {
      kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
      // Make a note never copies the event's title (D33, D49): the Event name stays empty.
      title: null, startTime: '18:00', endTime: '21:00', fromEvent: { calendarId: 'c1', uid: 'i1' },
    },
  }]);
  // The file's own POST carries its text; no other write carries a title.
  expect(JSON.stringify(writes(api).slice(1))).not.toContain('Smith');
  await waitFor(() => { expect(cell('2026-11-21').textContent).toContain('+70'); });
  // The stored events stay: a note's save reads the notes and the forecast again, not the calendars.
  expect(within(panel()).getByText('From your calendar: Smith rehearsal dinner')).toBeTruthy();
  // The linked note says where it came from, with no title, in words of its own: not the stored event's "From your calendar".
  expect(within(panel()).getByText('Made from a calendar event')).toBeTruthy();
  expect(within(panel()).queryByText('From your calendar')).toBeNull();
});

test('a note linked to a calendar event says “Made from a calendar event” with no title; an unlinked one says nothing of it', async () => {
  const linked = noteOf('n1', {
    kind: 'private_event', effect: 'closed', startDate: '2026-11-21', endDate: '2026-11-21', expectedGuests: 40,
    fromEvent: { calendarId: 'c1', uid: 'i1', startDate: '2026-11-21', endDate: '2026-11-21', startTime: null, endTime: null, linkedAt: '2026-11-11T15:00:00.000Z' },
  });
  const plain = noteOf('n2', { kind: 'other', effect: 'more_guests', startDate: '2026-11-21', endDate: '2026-11-21', fromEvent: null });
  const { api } = setup(meOf(ACCESS.member), { notes: [linked, plain] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const day = panel();
  expect(within(day).getAllByText('Made from a calendar event')).toHaveLength(1);
  expect(within(day).getByText('Made from a calendar event').parentElement?.textContent).toContain('40 guests');
});

test('a file over 1 MB is refused unread, and a file that isn’t a calendar says so', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  chooseFile(icsFile(ICS, 'everything.ics', 1024 * 1024 + 1));
  expect(await within(calendarsPanel()).findByText(TOO_LARGE)).toBeTruthy();
  expect(writes(api)).toEqual([]);
  // A CSV is posted (named without its .csv, D58), and the API says it isn't a calendar: nothing is kept, so nothing is
  // read again.
  api.answers[CALENDARS_PATH] = () => refusal(400, 'not_calendar');
  const reads = fake.paths.length;
  const csv = 'date,guests\n2026-11-01,120\n';
  chooseFile(icsFile(csv, 'sales.csv'));
  expect(await within(calendarsPanel()).findByText(NOT_CALENDAR)).toBeTruthy();
  expect(screen.queryByText(TOO_LARGE)).toBeNull();
  expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'file', label: 'sales', ics: csv, titlesNotice: 1 } }]);
  expect(fake.paths.slice(reads)).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  api.answers[CALENDARS_PATH] = () => refusal(409, 'calendar_limit');
  chooseFile(icsFile(ICS, 'kitchen.ics'));
  expect(await within(calendarsPanel()).findByText(CALENDAR_LIMIT)).toBeTruthy();
  expect(screen.queryByText(NOT_CALENDAR)).toBeNull();
  // Exactly 1 MB is posted.
  api.answers[CALENDARS_PATH] = () => {
    fake.calendars = [KITCHEN];
    fake.ownerEvents = [DINNER, AWAY];
    return { calendar: KITCHEN };
  };
  const full = new File([ICS], 'kitchen.ics', { type: 'text/calendar' });
  Object.defineProperty(full, 'text', { value: () => Promise.resolve(ICS) });
  Object.defineProperty(full, 'size', { value: 1024 * 1024 });
  chooseFile(full);
  expect(await within(calendarsPanel()).findByText('Added kitchen: 2 events.')).toBeTruthy();
  expect(screen.queryByText(CALENDAR_LIMIT)).toBeNull();
  expect(writes(api)).toHaveLength(3);
});

test('stored events show on load: the cells, the tooltip, the day panel and the week view’s cards, with Your calendar on; the same uid in two calendars shows once in a cell and twice in the panel (D49)', async () => {
  const errors = jest.spyOn(console, 'error');
  try {
    // The same export imported twice is two calendars, each with the event's uid.
    const again = ownerEvent({ ...DINNER, calendarId: 'c2', calendar: 'kitchen copy' });
    const party = ownerEvent({ calendarId: 'c1', calendar: 'kitchen', uid: 'i4', title: 'Staff party', startDate: '2026-11-05' });
    const { api } = setup(meOf(ACCESS.member), {
      calendars: [KITCHEN, ownerCalendar({ id: 'c2', label: 'kitchen copy', eventCount: 1 })], ownerEvents: [party, DINNER, again, AWAY],
    });
    await renderAt('/locations/l1/calendar?day=2026-11-21', api);
    expect(writes(api)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Your calendar' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Your calendars (2)' })).toBeTruthy();
    expect(cell('2026-11-21').textContent.split('Smith rehearsal dinner')).toHaveLength(2);
    expect(cell('2026-11-24').textContent).toContain('Owner away');
    expect(cell('2026-11-25').textContent).toContain('Owner away');
    expect(cell('2026-11-21').textContent).toContain('212');
    // The tooltip lists a day's entries when it has no forecast reasons to show, as on a past day.
    expect(cell('2026-11-05').textContent).toContain('Staff party');
    fireEvent(cell('2026-11-05'), pointer('pointerover', 'mouse'));
    expect(screen.getByTestId('calendar-tooltip').textContent).toContain('Staff party');
    expect(within(panel()).getAllByText('From your calendar: Smith rehearsal dinner')).toHaveLength(2);
    expect(within(panel()).getAllByRole('button', { name: 'Make a note from Smith rehearsal dinner' })).toHaveLength(2);
    fireEvent.click(within(screen.getByRole('group', { name: 'Calendar view' })).getByRole('button', { name: 'Week' }));
    expect(await screen.findByRole('grid', { name: 'Nov 18 to 24, 2026' })).toBeTruthy();
    expect(cell('2026-11-21').textContent.split('Smith rehearsal dinner')).toHaveLength(2);
    // Each item keeps its own key: {calendarId}:{uid}.
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('same key'))).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});

test('one stored-events read per grid: none on selecting a day or switching to Week, the next grid’s on Next month, pending like the other reads', async () => {
  const { api, fake } = setup(meOf(ACCESS.member), { calendars: [KITCHEN], ownerEvents: [DINNER, AWAY] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(storedReads(fake)).toEqual([NOVEMBER_EVENTS]);
  // Dec 1's block, Nov 25 to Dec 1, lies inside November's grid.
  fireEvent.click(cell('2026-12-01'));
  await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Tue, Dec 1, 2026' })).toBeTruthy(); });
  const views = screen.getByRole('group', { name: 'Calendar view' });
  fireEvent.click(within(views).getByRole('button', { name: 'Week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 25 to Dec 1, 2026' })).toBeTruthy();
  fireEvent.click(within(views).getByRole('button', { name: 'Month' }));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(storedReads(fake)).toEqual([NOVEMBER_EVENTS]);
  const release = fake.hold('owner-calendars/events', '2026-11-30');
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  const december = await screen.findByRole('grid', { name: 'December 2026' });
  expect(storedReads(fake)).toEqual([NOVEMBER_EVENTS, `${CALENDARS_PATH}/events?from=2026-11-30&to=2027-01-10`]);
  // Held, the stored events keep December's grid pending, as the town calendar's read would.
  expect(december.getAttribute('aria-busy')).toBe('true');
  expect(cell('2026-12-12').getAttribute('aria-label')).toBe('Sat, Dec 12, 2026. Loading.');
  await act(async () => { release(); await Promise.resolve(); });
  await waitFor(() => { expect(screen.getByRole('grid', { name: 'December 2026' }).getAttribute('aria-busy')).toBe('false'); });
  expect(cell('2026-12-12').getAttribute('aria-label')).not.toContain('Loading');
});

test('a failed stored-events read leaves the grid showing with Try again for them; a failed town calendar read still fails the page', async () => {
  const { api, fake } = setup(meOf(ACCESS.member), { calendars: [KITCHEN], ownerEvents: offline() });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(await screen.findByText('Couldn’t load the events from your calendars. Try again.')).toBeTruthy();
  expect(cell('2026-11-21').textContent).toContain('Dartmouth home football');
  expect(cell('2026-11-21').textContent).toContain('212');
  expect(cell('2026-11-21').textContent).not.toContain('Smith rehearsal dinner');
  const reads = fake.paths.length;
  fake.ownerEvents = [DINNER, AWAY];
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(cell('2026-11-21').textContent).toContain('Smith rehearsal dinner'); });
  expect(fake.paths.slice(reads)).toContain(NOVEMBER_EVENTS);
  expect(screen.queryByText('Couldn’t load the events from your calendars. Try again.')).toBeNull();
  cleanup();

  const failing = setup();
  const json = failing.fake.json.bind(failing.fake);
  failing.fake.json = (path, schema, opts) => (path.includes('/calendar?') ? Promise.reject(offline()) : json(path, schema, opts));
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: failing.api });
  window.history.replaceState(null, '', '/locations/l1/calendar?day=2026-11-21');
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location="/locations/l1/calendar?day=2026-11-21" />
    </Head.Provider>,
  );
  expect(await screen.findByText(COPY.network)).toBeTruthy();
  expect(screen.queryByRole('grid')).toBeNull();
});

test('view-as: Add, Edit, Delete, Make a note and the calendars panel’s actions are disabled with the read-only line', async () => {
  const party = noteOf('n1', { kind: 'private_event', effect: 'more_guests', startDate: '2026-11-21', endDate: '2026-11-21', expectedGuests: 40 });
  const bookings = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });
  const { api } = setup(viewAsMe(ACCESS.admin), { notes: [party], calendars: [KITCHEN, bookings], ownerEvents: [DINNER, AWAY] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  for (const name of ['Add an event', 'Edit Private event note, Nov 21, 2026', 'Delete Private event note, Nov 21, 2026', 'Make a note from Smith rehearsal dinner']) {
    const control = within(panel()).getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe('calendar-ro');
    fireEvent.click(control);
  }
  expect(document.getElementById('calendar-ro')?.textContent).toBe('Read-only while viewing as gm@example.org.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();

  // The popover opens and lists the calendars; its writes stay in place, disabled, described by its own read-only line.
  fireEvent.click(screen.getByRole('button', { name: 'Your calendars (2)' }));
  const calendars = calendarsPanel();
  expect(within(calendars).getByText('kitchen')).toBeTruthy();
  expect(within(calendars).getByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const picked = jest.spyOn(input, 'click').mockImplementation(() => undefined);
  const controls = ['Import a calendar file', 'Add a link', 'Refresh now: Bookings', 'Remove kitchen', 'Remove Bookings']
    .map((name) => within(calendars).getByRole('button', { name }));
  const line = within(calendars).getByText('Read-only while viewing as gm@example.org.');
  expect(line.id).not.toBe('');
  expect(line.id).not.toBe('calendar-ro');
  for (const control of controls) {
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(line.id);
    fireEvent.click(control);
  }
  expect(picked).not.toHaveBeenCalled();
  expect(within(calendars).queryByLabelText('Calendar link')).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Remove this calendar?' })).toBeNull();
  // How importing works is no write: it still shows the help.
  const toggle = within(calendars).getByRole('button', { name: 'How importing works' });
  expect(toggle.getAttribute('aria-disabled')).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(writes(api)).toEqual([]);
});

test('a failed forecast read leaves the calendar showing with Try again for the forecast only', async () => {
  const { api, fake } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': offline() } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(await screen.findByText('Couldn’t load the forecast for November. Try again.')).toBeTruthy();
  expect(cell('2026-11-21').textContent).not.toContain('212');
  expect(cell('2026-11-07').textContent).toContain('138');
  expect(within(panel()).getByText('No forecast for this day.')).toBeTruthy();
  const reads = fake.paths.length;
  fake.forecasts['2026-11'] = november();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(cell('2026-11-21').textContent).toContain('212'); });
  expect(fake.paths.slice(reads)).toEqual([NOVEMBER_FORECAST]);
  expect(screen.queryByText('Couldn’t load the forecast for November. Try again.')).toBeNull();
});

test('no published forecast shows the banner', async () => {
  const { api } = setup(meOf(ACCESS.member), { forecasts: {} });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.getByText(
    'Townwise hasn’t published a forecast for Main Street Bar yet. Days show your history, your notes and Hanover’s calendar. Notes you add now count as soon as a forecast is published.',
  )).toBeTruthy();
  expect(cell('2026-11-21').textContent).not.toMatch(/\d{3}/);
  expect(within(panel()).getByText('Townwise hasn’t published a forecast for Main Street Bar yet.')).toBeTruthy();
});

test('hovering a day shows the tooltip with its range and top reasons; touch does not', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar', api);
  fireEvent(cell('2026-11-21'), pointer('pointerover', 'touch'));
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  fireEvent(cell('2026-11-21'), pointer('pointerover', 'mouse'));
  const tip = screen.getByTestId('calendar-tooltip');
  expect(tip.getAttribute('aria-hidden')).toBe('true');
  expect(tip.textContent).toContain('Sat, Nov 21, 2026');
  expect(tip.textContent).toContain('212 guests, forecast (likely 180 to 240)');
  expect(tip.textContent).toContain('Dartmouth home football');
  // Hovering never selects.
  expect(cell('2026-11-11').getAttribute('aria-selected')).toBe('true');
  const grid = cell('2026-11-21').closest('[role="grid"]');
  if (grid === null) throw new Error('no grid');
  fireEvent.pointerLeave(grid);
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
});

test('the grid is one tab stop and the arrow keys move the selection', async () => {
  const { api } = setup();
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  cell('2026-11-21').focus();
  fireEvent.keyDown(cell('2026-11-21'), { key: 'ArrowRight' });
  await waitFor(() => { expect(cell('2026-11-22').getAttribute('aria-selected')).toBe('true'); });
  expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-22');
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(within(panel()).getByRole('heading', { name: 'Sun, Nov 22, 2026' })).toBeTruthy();
  fireEvent.keyDown(cell('2026-11-22'), { key: 'ArrowUp' });
  await waitFor(() => { expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-15'); });
  expect(within(panel()).getByRole('heading', { name: 'Sun, Nov 15, 2026' })).toBeTruthy();
  fireEvent.click(cell('2026-11-07'));
  await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Sat, Nov 7, 2026' })).toBeTruthy(); });
  expect(within(panel()).getByText(whole('138 guests'))).toBeTruthy();
});

test('Try again and a month change while the forecast still fails keep the calendar showing, dimmed', async () => {
  const { api } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': offline(), '2026-12': offline() } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(await screen.findByText('Couldn’t load the forecast for November. Try again.')).toBeTruthy();
  // The popover's message is the header row's state: it would be gone if the page swapped to its loader and back.
  api.answers[CALENDARS_PATH] = () => refusal(400, 'not_calendar');
  chooseFile(icsFile('date,guests\n2026-11-01,120\n', 'sales.csv'));
  expect(await within(calendarsPanel()).findByText(NOT_CALENDAR)).toBeTruthy();
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${CALENDARS_PATH}`]);
  closeCalendars();

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.queryByText('Loading the calendar')).toBeNull();
  expect(screen.getByRole('grid', { name: 'November 2026' }).getAttribute('aria-busy')).toBe('true');
  expect(await screen.findByText('Couldn’t load the forecast for November. Try again.')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'November 2026' }).getAttribute('aria-busy')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: /^Your calendars/ }));
  expect(within(calendarsPanel()).getByText(NOT_CALENDAR)).toBeTruthy();
  closeCalendars();

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.queryByText('Loading the calendar')).toBeNull();
  expect(await screen.findByText('Couldn’t load the forecast for December. Try again.')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'December 2026' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Your calendars/ }));
  expect(within(calendarsPanel()).getByText(NOT_CALENDAR)).toBeTruthy();
});

test('a note gone in the meantime: Save and Delete answer 404, say so, close and read the notes and forecast again', async () => {
  const party = noteOf('n1', { kind: 'private_event', effect: 'more_guests', startDate: '2026-11-21', endDate: '2026-11-21', expectedGuests: 40 });
  const { api, fake } = setup(meOf(ACCESS.member), { notes: [party], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const notesReads = (): number => fake.paths.filter((path) => path === NOTES_PATH).length;
  expect(notesReads()).toBe(1);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Edit Private event note, Nov 21, 2026' }));
  const form = noteForm('Edit note');
  fireEvent.change(within(form).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[`${NOTES_PATH}/n1`] = () => refusal(404, 'not_found');
  fireEvent.click(within(form).getByRole('button', { name: 'Save note' }));
  expect(await within(panel()).findByText('This note isn’t available.')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Edit note' })).toBeNull();
  await waitFor(() => { expect(forecastReads(fake)).toHaveLength(2); });
  expect(notesReads()).toBe(2);

  fake.request = () => Promise.reject(refusal(404, 'not_found'));
  fireEvent.click(within(panel()).getByRole('button', { name: 'Delete Private event note, Nov 21, 2026' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this note?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  await waitFor(() => { expect(forecastReads(fake)).toHaveLength(3); });
  expect(notesReads()).toBe(3);
  expect(within(panel()).getByText('This note isn’t available.')).toBeTruthy();
  expect(screen.queryByText('Deleted the note.')).toBeNull();
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`PATCH ${NOTES_PATH}/n1`, `DELETE ${NOTES_PATH}/n1`]);
});

test('below 1024px a clicked day, or Enter on a day, scrolls the day panel into view; an arrow key or a month change does not', async () => {
  setWidth(800);
  const scrolls = jest.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrolls });
  try {
    const { api } = setup();
    await renderAt('/locations/l1/calendar?day=2026-11-21', api);
    expect(scrolls).not.toHaveBeenCalled();
    fireEvent.click(cell('2026-11-07'));
    await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Sat, Nov 7, 2026' })).toBeTruthy(); });
    expect(scrolls).toHaveBeenCalledTimes(1);
    expect(scrolls.mock.contexts[0]).toBe(panel());

    // An arrow key keeps the focused cell in view instead, and Enter on the day it moved to brings the panel up.
    cell('2026-11-07').focus();
    fireEvent.keyDown(cell('2026-11-07'), { key: 'ArrowRight' });
    await waitFor(() => { expect(cell('2026-11-08').getAttribute('aria-selected')).toBe('true'); });
    expect(scrolls).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(cell('2026-11-08'), { key: 'Enter' });
    await waitFor(() => { expect(scrolls).toHaveBeenCalledTimes(2); });
    fireEvent.keyDown(cell('2026-11-08'), { key: ' ' });
    await waitFor(() => { expect(scrolls).toHaveBeenCalledTimes(3); });

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
    expect(scrolls).toHaveBeenCalledTimes(3);
  } finally {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  }
});

test('from 1024px the panel is beside the grid, so a clicked day scrolls nothing', async () => {
  const scrolls = jest.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrolls });
  try {
    const { api } = setup();
    await renderAt('/locations/l1/calendar?day=2026-11-21', api);
    fireEvent.click(cell('2026-11-07'));
    await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Sat, Nov 7, 2026' })).toBeTruthy(); });
    fireEvent.keyDown(cell('2026-11-07'), { key: 'Enter' });
    expect(scrolls).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  }
});

// D49 (day-entries): a day's status shows beside its entries and never hides one, and a note shows its event name.
const WINTER_RULE = ruleOf('r1', 'Closed Tuesdays in winter', {
  schedule: { kind: 'closure', startDate: '2026-11-01', endDate: null, weekdays: [2], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
  scheduleSummary: 'Closed on Tuesdays from Nov 1, 2026',
});
const HOLIDAY_PARTY = noteOf('n1', { kind: 'private_event', startDate: '2026-11-24', endDate: '2026-11-24', effect: 'more_guests', expectedGuests: 40, title: 'Holiday party' });
const REHEARSAL = noteOf('n2', { kind: 'private_event', startDate: '2026-11-11', endDate: '2026-11-11', effect: 'closed', expectedGuests: 60, title: 'Rehearsal dinner' });

/** November from today on, with Nov 24 closed by the rule and today booked by the buyout note. */
function statusNovember(): unknown {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    if (date === '2026-11-24') days.push(forecastDay({ date, status: 'closed', low: null, mid: null, high: null, reasons: [] }));
    else if (date === '2026-11-11') {
      days.push(forecastDay({
        date, status: 'booked', low: null, mid: null, high: null, noteGuests: 60,
        reasons: [{ kind: 'note', label: 'Your private buyout, 60 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 60, outcome: 'booked' } }],
      }));
    } else days.push(forecastDay({ date }));
  }
  return forecastOf(days);
}

test('a closed day with a named event shows its status word and both entries; a booked day its party’s name before Veterans Day (D49)', async () => {
  const { api } = setup(meOf(ACCESS.member), { notes: [HOLIDAY_PARTY, REHEARSAL], rules: [WINTER_RULE], forecasts: { '2026-11': statusNovember() } });
  await renderAt('/locations/l1/calendar?day=2026-11-24', api);
  const closed = cell('2026-11-24');
  expect(closed.textContent).toBe('24ClosedHoliday partyClosed Tuesdays in winter');
  expect(closed.getAttribute('aria-label')).toBe('Tue, Nov 24, 2026. Closed. Holiday party. Closed Tuesdays in winter.');
  const booked = cell('2026-11-11');
  expect(booked.textContent).toBe('11Booked~60Rehearsal dinnerVeterans Day');
  // The tooltip: the status line, the buyout's reason with its note's name, then the holiday no reason names.
  fireEvent(booked, pointer('pointerover', 'mouse'));
  expect(within(screen.getByTestId('calendar-tooltip')).getAllByText(/./).map((line) => line.textContent)).toEqual(expect.arrayContaining([
    'Booked: a private buyout, 60 guests, forecast', 'Your private buyout, 60 guests: Rehearsal dinner', 'Veterans Day',
  ]));
});

test('at phone width a cell shows corner marks and no entry lines, and its label still names every entry (D49)', async () => {
  setWidth(375);
  const { api } = setup(meOf(ACCESS.member), { notes: [HOLIDAY_PARTY], rules: [WINTER_RULE], forecasts: { '2026-11': statusNovember() } });
  await renderAt('/locations/l1/calendar?day=2026-11-24', api);
  const closed = cell('2026-11-24');
  expect(closed.textContent).toBe('24Closed');
  expect(closed.getAttribute('aria-label')).toBe('Tue, Nov 24, 2026. Closed. Holiday party. Closed Tuesdays in winter.');
});

test('the key names an actual and a forecast, a past day says how its forecast did, and the month how many landed (D49)', async () => {
  // Nov 7: 138 stored guests against a run made Nov 2 that said 120 to 150.
  const past = forecastDay({ date: '2026-11-07', low: 120, mid: 135, high: 150, actual: 138, inRange: true, scored: true, madeAt: '2026-11-02' });
  const { api } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': forecastOf([past, ...(november() as { days: ForecastDay[] }).days]) } });
  await renderAt('/locations/l1/calendar?day=2026-11-07', api);
  const key = screen.getByTestId('figure-key');
  expect(key.textContent).toBe('94Actual guests~82Forecast');
  expect(await screen.findByText('So far this month: 1 of 1 day inside the forecast range.')).toBeTruthy();
  expect(cell('2026-11-07').getAttribute('aria-label')).toBe('Sat, Nov 7, 2026. 138 guests, actual.');
  expect(cell('2026-11-21').querySelector('[data-figure]')?.textContent).toBe('~212');
  const day = panel();
  // Its part is headed by what it is, once: never “Forecast” over an actual (UI review S2).
  expect(within(day).getAllByText('Actual guests')).toHaveLength(1);
  expect(within(day).queryByText('Forecast')).toBeNull();
  expect(within(day).getByText('Forecast was about 135 (likely 120 to 150); 138 guests came: inside the range.')).toBeTruthy();
  // The tooltip says it too.
  fireEvent.pointerOver(cell('2026-11-07'), { pointerType: 'mouse' });
  expect(screen.getByTestId('calendar-tooltip').textContent).toContain('138 guests, actualForecast was about 135 (likely 120 to 150); 138 guests came: inside the range');
});

test('a forecast day’s panel says “Forecast” once, over “About 82 guests” (UI review S2)', async () => {
  const { api } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': november() } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const day = panel();
  expect(await within(day).findAllByText('Forecast')).toHaveLength(1);
  expect(within(day).queryByText('Actual guests')).toBeNull();
});

/** November with a stale run: days from the 20th are its outlook (D52), the 20th with mid 212, low 150, high 290. */
function novemberWithOutlook(): unknown {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    days.push(day < 20 ? forecastDay({ date }) : forecastDay({ date, low: 150, mid: 212, high: 290, model: { status: 'open', low: 150, mid: 212, high: 290 }, outlook: true }));
  }
  return forecastOf(days);
}

const OUTLOOK_KEY = 'Days more than 3 months after Townwise’s forecast was made, or 6 months after the sales it learned from, show its outlook: a wider range that firms up as the weeks pass and your new sales come in.';

test('an outlook day (D52): its cell shows its figure marked Outlook, its tooltip and panel say outlook with no 8 in 10, and the key line shows', async () => {
  const { api } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': novemberWithOutlook() } });
  await renderAt('/locations/l1/calendar?day=2026-11-20', api);
  expect(cell('2026-11-20').getAttribute('aria-label')).toBe('Fri, Nov 20, 2026. Outlook: 212 guests, forecast, likely 150 to 290.');
  expect(cell('2026-11-20').textContent).toContain('Outlook');
  expect(cell('2026-11-20').textContent).toContain('212');
  // A forecast day is unchanged, with its 8 in 10.
  expect(cell('2026-11-19').getAttribute('aria-label')).toBe('Thu, Nov 19, 2026. 212 guests, forecast, likely 180 to 240.');
  expect(cell('2026-11-19').textContent).not.toContain('Outlook');
  const day = panel();
  expect(within(day).getByText('Outlook')).toBeTruthy();
  expect(within(day).getByText(whole('About 212 guests'))).toBeTruthy();
  expect(within(day).getByText('Likely 150 to 290. This day is more than 3 months after this forecast was made, or 6 months after the sales it learned from, so its range is wider.')).toBeTruthy();
  expect(day.textContent).not.toContain('8 in 10');
  expect(screen.getByText(OUTLOOK_KEY)).toBeTruthy();
  fireEvent(cell('2026-11-21'), pointer('pointerover', 'mouse'));
  expect(screen.getByTestId('calendar-tooltip').textContent).toContain('Outlook: 212 guests, forecast (likely 150 to 290)');
  // At phone width the cell keeps its figure.
  setWidth(375);
  expect(cell('2026-11-20').textContent).toContain('212');
});

test('no key line while no shown day is an outlook day', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar', api);
  expect(screen.queryByText(OUTLOOK_KEY)).toBeNull();
});
