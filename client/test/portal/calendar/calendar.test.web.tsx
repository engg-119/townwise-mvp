import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { MeResponse } from '../../../src/portal/schemas';
import { theme } from '../../../src/theme';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { holiday, townEvent } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';
import { ruleOf } from '../rules/fakes';
import { calendarFake, forecastDay, forecastOf, NOTES_PATH, PATH, savedNote, type CalendarFake } from './fakes';

// P27 Calendar on web (spec 16.3, D30): the month grid with each day's published forecast, the
// selected day's panel beside it, notes added, edited and deleted from the day with the forecast read again, the
// filters, view-as, the forecast read failing on its own, no published forecast, the hover tooltip and the keys, and
// the owner's calendar file (spec 17: read in the browser, kept in the page, a note made from an event without
// its title). Today is Wed, Nov 11, 2026. Synthetic figures and made-up titles only.

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

const NOVEMBER_FORECAST = `${PATH}/forecast?from=2026-11-01&to=2026-11-30`;
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

function setup(me: MeResponse = meOf(ACCESS.member), init: Partial<Pick<CalendarFake, 'notes' | 'rules' | 'forecasts'>> = {}): { api: FakePortalApi; fake: CalendarFake } {
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

const ICS_HELP = 'Export a calendar from Google Calendar, Outlook or Apple Calendar as an .ics file and choose it here. Townwise reads it in your browser and keeps it only while this page is open. Nothing from the file is sent to Townwise unless you make a note from an event.';

/** `size` stands in for the file's size on disk; a file given one throws if it is read. */
function icsFile(text: string, name = 'kitchen.ics', size?: number): File {
  const file = new File([text], name, { type: 'text/calendar' });
  // jsdom's Blob has no text(); the import reads files with File.text().
  const read = size === undefined ? () => Promise.resolve(text) : () => { throw new Error('read a file over 1 MB'); };
  Object.defineProperty(file, 'text', { value: read });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function chooseFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  expect(input.getAttribute('accept')).toBe('.ics,text/calendar');
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
  expect(cell('2026-11-21').getAttribute('aria-label')).toBe('Sat, Nov 21, 2026. Forecast about 212 guests, 180 to 240. Dartmouth home football.');
  expect(cell('2026-11-07').getAttribute('aria-label')).toBe('Sat, Nov 7, 2026. 138 guests.');
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
    'Dartmouth home football▲Usually about 20% more guests than the same weekday without it Source',
  ]);
  for (const mark of within(day).getAllByText('▲')) expect(mark.closest('[aria-hidden="true"]')).not.toBeNull();
  // The row ends with its source, a small inline link named for where it goes.
  const game = why[1];
  if (game === undefined) throw new Error('no second reason');
  const source = within(game).getByRole('link', { name: 'Source: dartmouthsports.com' });
  expect(source.getAttribute('href')).toBe('https://dartmouthsports.com/');
  expect(source.textContent).toBe('Source');
  // On the calendar no longer repeats the game Why shows.
  expect(within(day).queryByText('Dartmouth home football. Town event.')).toBeNull();
  expect(within(day).queryByRole('link', { name: 'Source: home.dartmouth.edu' })).toBeNull();
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
  expect(within(game).getByRole('link', { name: 'Source: dartmouthsports.com' })).toBeTruthy();
});

test('several sources: each link’s name starts with its visible words, “Source 1: …” (WCAG 2.5.3), and each is a 44px target on web', async () => {
  const sources = [...GAME_REASON.sources, { label: 'Sample events page', url: 'https://example.org/events' }];
  const days = (november() as { days: { date: string }[] }).days.map((day) => (day.date === '2026-11-21'
    ? forecastDay({ date: '2026-11-21', reasons: [{ ...GAME_REASON, sources }, SATURDAY_REASON] }) : day));
  const { api } = setup(meOf(ACCESS.member), { forecasts: { '2026-11': forecastOf(days as never) } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const game = within(panel()).getAllByRole('listitem')[1];
  if (game === undefined) throw new Error('no second reason');
  const links = within(game).getAllByRole('link');
  expect(links.map((link) => [link.textContent, link.getAttribute('aria-label')])).toEqual([
    ['Source 1', 'Source 1: dartmouthsports.com'], ['Source 2', 'Source 2: Sample events page'],
  ]);
  // The links sit in the sentence's 14px type; their padding takes no room in the line, so the line doesn't move.
  for (const link of links) {
    expect(parseFloat(window.getComputedStyle(link).paddingTop) * 2 + theme.type.small.fontSize).toBeGreaterThanOrEqual(44);
  }
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

test('the forecast read covers exactly the shown month (one request of at most 31 days)', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar', api);
  expect(cell('2026-11-11').getAttribute('aria-selected')).toBe('true');
  expect(within(panel()).getByRole('heading', { name: 'Today, Wed, Nov 11' })).toBeTruthy();
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST]);
  // Sales days only for the month's past part, and the 8 weeks before it that likely closed reads (spec D32).
  expect(fake.paths.filter((path) => path.includes('/sales/days?'))).toEqual([`${PATH}/sales/days?from=2026-09-06&to=2026-11-10`]);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST, `${PATH}/forecast?from=2026-12-01&to=2026-12-31`]);
  // A month after today has no past part to read.
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
  expect(within(panel()).getByRole('button', { name: 'Private event' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(panel()).getByRole('button', { name: 'More guests than usual' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(panel()).getByLabelText<HTMLInputElement>('Starts').value).toBe('2026-11-21');
  // Forecasts are daily, so the guests count toward the whole day, whatever the hours (spec 12).
  expect(within(panel()).getByText(GUESTS_HELP)).toBeTruthy();
  fireEvent.click(within(panel()).getByRole('button', { name: 'Opening' }));
  expect(within(panel()).queryByText(GUESTS_HELP)).toBeNull();
  fireEvent.click(within(panel()).getByRole('button', { name: 'Private event' }));
  fireEvent.change(within(panel()).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november({ guests: 70, id: 'n9' });
    return saved;
  };
  fireEvent.click(within(panel()).getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: NOTES_PATH,
    body: {
      kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
      startTime: null, endTime: null,
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
  fireEvent.click(within(panel()).getByRole('button', { name: 'Save note' }));
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
  expect(within(panel()).getByRole('heading', { name: 'Edit this note' })).toBeTruthy();
  fireEvent.change(within(panel()).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[`${NOTES_PATH}/n1`] = (body) => {
    const saved = savedNote('n1', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november({ guests: 70, id: 'n1' });
    return saved;
  };
  fireEvent.click(within(panel()).getByRole('button', { name: 'Save note' }));
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
  expect(cell('2026-11-21').getAttribute('aria-label')).toBe('Sat, Nov 21, 2026. Forecast about 212 guests, 180 to 240.');
  // The panel's calendar list follows the filter; the forecast's own reasons stay.
  expect(within(panel()).queryByText('Dartmouth home football. Town event.')).toBeNull();
  expect(within(panel()).getByText('Dartmouth home football')).toBeTruthy();
  // Holidays are their own filter.
  expect(cell('2026-11-11').getAttribute('aria-label')).toContain('Veterans Day.');
  fireEvent.click(screen.getByRole('button', { name: 'Holidays' }));
  expect(cell('2026-11-11').getAttribute('aria-label')).not.toContain('Veterans Day.');
});

test('importing an .ics file shows its events under Your calendar; Make a note opens the form with dates and hours and an empty detail', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  expect(screen.getByText(ICS_HELP)).toBeTruthy();
  const reads = fake.paths.length;
  chooseFile(icsFile(ICS, 'kitchen.ics'));
  expect(await screen.findByText('2 events from kitchen.ics.')).toBeTruthy();
  expect(screen.getByText('1 repeating event wasn’t imported. Add it as a note with weekdays.')).toBeTruthy();
  // Read in the browser: nothing was sent and nothing read again.
  expect(fake.paths).toHaveLength(reads);
  expect(writes(api)).toEqual([]);
  const chip = screen.getByRole('button', { name: 'Your calendar' });
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  expect(cell('2026-11-21').textContent).toContain('Smith rehearsal dinner');
  expect(cell('2026-11-25').textContent).toContain('Owner away');
  // Only notes change the forecast.
  expect(cell('2026-11-21').textContent).toContain('212');
  const day = panel();
  expect(within(day).getByText('From your calendar: Smith rehearsal dinner')).toBeTruthy();
  expect(within(day).getByText('Nov 21, 2026, 6 pm to 9 pm')).toBeTruthy();
  expect(within(day).getByText('Events from your calendar don’t change the forecast until you make a note from them.')).toBeTruthy();

  // Turning the filter off hides the file's events from the grid and the panel.
  fireEvent.click(chip);
  expect(cell('2026-11-21').textContent).not.toContain('Smith rehearsal dinner');
  expect(within(panel()).queryByText('From your calendar: Smith rehearsal dinner')).toBeNull();
  fireEvent.click(chip);

  fireEvent.click(within(panel()).getByRole('button', { name: 'Make a note from Smith rehearsal dinner' }));
  const form = panel();
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
  expect(writes(api)).toEqual([{
    method: 'POST', path: NOTES_PATH,
    body: {
      kind: 'private_event', startDate: '2026-11-21', endDate: '2026-11-21', weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
      startTime: '18:00', endTime: '21:00',
    },
  }]);
  expect(JSON.stringify(writes(api))).not.toContain('Smith');
  await waitFor(() => { expect(cell('2026-11-21').textContent).toContain('+70'); });
  // The file's events stay while the page is open.
  expect(within(panel()).getByText('From your calendar: Smith rehearsal dinner')).toBeTruthy();
});

test('a file over 1 MB is refused unread, and a file that isn’t a calendar says so', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  chooseFile(icsFile(ICS, 'everything.ics', 1024 * 1024 + 1));
  expect(await screen.findByText('This file is over 1 MB. Export a shorter range of your calendar.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  chooseFile(icsFile('date,guests\n2026-11-01,120\n', 'sales.csv'));
  expect(await screen.findByText('This doesn’t look like a calendar file (.ics).')).toBeTruthy();
  expect(screen.queryByText('This file is over 1 MB. Export a shorter range of your calendar.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  expect(writes(api)).toEqual([]);
  // Exactly 1 MB is read.
  const full = new File([ICS], 'kitchen.ics', { type: 'text/calendar' });
  Object.defineProperty(full, 'text', { value: () => Promise.resolve(ICS) });
  Object.defineProperty(full, 'size', { value: 1024 * 1024 });
  chooseFile(full);
  expect(await screen.findByText('2 events from kitchen.ics.')).toBeTruthy();
  expect(screen.queryByText('This doesn’t look like a calendar file (.ics).')).toBeNull();
});

test('view-as: Add, Edit, Delete and Make a note are disabled with the read-only line', async () => {
  const party = noteOf('n1', { kind: 'private_event', effect: 'more_guests', startDate: '2026-11-21', endDate: '2026-11-21', expectedGuests: 40 });
  const { api } = setup(viewAsMe(ACCESS.admin), { notes: [party] });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  // Importing reads a file in the staff member's own browser and sends nothing, so it is allowed.
  chooseFile(icsFile(ICS));
  expect(await screen.findByText('2 events from kitchen.ics.')).toBeTruthy();
  for (const name of ['Add an event', 'Edit Private event note, Nov 21, 2026', 'Delete Private event note, Nov 21, 2026', 'Make a note from Smith rehearsal dinner']) {
    const control = within(panel()).getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe('calendar-ro');
    fireEvent.click(control);
  }
  expect(document.getElementById('calendar-ro')?.textContent).toBe('Read-only while viewing as gm@example.org.');
  expect(within(panel()).queryByRole('button', { name: 'Save note' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
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
  expect(tip.textContent).toContain('About 212 guests (180 to 240)');
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
  // The import's own line is the toolbar's state: it would be gone if the page swapped to its loader and back.
  chooseFile(icsFile('date,guests\n2026-11-01,120\n', 'sales.csv'));
  expect(await screen.findByText('This doesn’t look like a calendar file (.ics).')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.queryByText('Loading the calendar')).toBeNull();
  expect(screen.getByRole('grid', { name: 'November 2026' }).getAttribute('aria-busy')).toBe('true');
  expect(await screen.findByText('Couldn’t load the forecast for November. Try again.')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'November 2026' }).getAttribute('aria-busy')).toBe('false');
  expect(screen.getByText('This doesn’t look like a calendar file (.ics).')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.queryByText('Loading the calendar')).toBeNull();
  expect(await screen.findByText('Couldn’t load the forecast for December. Try again.')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'December 2026' })).toBeTruthy();
  expect(screen.getByText('This doesn’t look like a calendar file (.ics).')).toBeTruthy();
});

test('a note gone in the meantime: Save and Delete answer 404, say so, close and read the notes and forecast again', async () => {
  const party = noteOf('n1', { kind: 'private_event', effect: 'more_guests', startDate: '2026-11-21', endDate: '2026-11-21', expectedGuests: 40 });
  const { api, fake } = setup(meOf(ACCESS.member), { notes: [party], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) } });
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const notesReads = (): number => fake.paths.filter((path) => path === NOTES_PATH).length;
  expect(notesReads()).toBe(1);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Edit Private event note, Nov 21, 2026' }));
  fireEvent.change(within(panel()).getByLabelText('Expected guests (optional)'), { target: { value: '70' } });
  api.answers[`${NOTES_PATH}/n1`] = () => refusal(404, 'not_found');
  fireEvent.click(within(panel()).getByRole('button', { name: 'Save note' }));
  expect(await within(panel()).findByText('This note isn’t available.')).toBeTruthy();
  expect(within(panel()).queryByRole('heading', { name: 'Edit this note' })).toBeNull();
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
