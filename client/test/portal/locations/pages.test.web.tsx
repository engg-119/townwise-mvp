import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { COMPOSER_LABEL } from '../../../src/chat/ui/Composer';
import { fmt1, fmtSigned, side } from '../../../src/marketing/format';
import type { Note, NoteInput } from '../../../src/portal/locations/api';
import { addDays, localToday } from '../../../src/portal/locations/dates';
import type { MeResponse } from '../../../src/portal/schemas';
import { MONTHS, northeastSeries, townProfile } from '../../../src/portal/towns';
import { theme } from '../../../src/theme';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeChatApi } from '../../helpers/chat';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, locationOf, meOf, orgOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { daysOf, locationsFake, noteOf, salesOf, uploadOf } from './fakes';

// The location pages on web: the daily sales chart drawn as aria-hidden SVG beside its text and numbers (D21),
// the browser's date inputs and the pressed buttons of the note form, and view-as controls that stay focusable
// with aria-disabled and the read-only line (spec 15.7), the tuning chat's included.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; these tests cover the desktop layout.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const DAYS = daysOf('2025-01-01', 400, (index) => (index >= 10 && index <= 12 ? null : { guests: 50 + (index % 30), netSalesCents: 150_000 }));

function renderAt(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

function portal(me: MeResponse, notes: Note[] = []): FakePortalApi {
  const fake = locationsFake({
    sales: { l1: salesOf(DAYS, [uploadOf('u1')]), l2: salesOf([]) }, days: { l1: DAYS }, notes: { l1: notes },
  });
  return fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake });
}

/** A control that stays focusable under view-as: a <button> with aria-disabled, described by the read-only line. */
function expectReadOnly(control: HTMLElement, lineId: string): void {
  expect(control.tagName).toBe('BUTTON');
  expect(control.getAttribute('aria-disabled')).toBe('true');
  expect(control.hasAttribute('disabled')).toBe(false);
  expect(control.getAttribute('aria-describedby')).toBe(lineId);
  expect(document.getElementById(lineId)?.textContent).toBe('Read-only while viewing as gm@example.org.');
}

test('Sales data draws the daily chart as aria-hidden SVG, with its scale, ticks, summary and numbers', async () => {
  renderAt('/locations/l1/sales', portal(meOf(ACCESS.member)));
  expect(await screen.findByRole('heading', { name: 'Daily guests' })).toBeTruthy();
  // The chart's SVG, found in the chart's own box (the one that ends with its scale line), not by page order: the top
  // bar draws icons too. The SVG's frame holds the y scale.
  const svg = screen.getByText('Scale fitted to this location.').parentElement?.querySelector('svg') ?? null;
  const chart = svg?.parentElement;
  if (svg === null || chart === null || chart === undefined) throw new Error('no chart');
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  const line = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '').find((d) => d.includes('L'));
  expect(line).toMatch(/^M[\d.]+ [\d.]+ L/);
  // The y scale is printed: the highest and lowest day in the range.
  expect(within(chart).getByText('79')).toBeTruthy();
  expect(within(chart).getByText('50')).toBeTruthy();
  // Month ticks with their year: the first, middle and last day.
  expect([...(chart.nextElementSibling?.children ?? [])].map((tick) => tick.textContent)).toEqual(['Feb 2025', 'Aug 2025', 'Feb 2026']);
  expect(screen.getByText('Scale fitted to this location.')).toBeTruthy();
  expect(screen.queryByText('See the chart at townwise.tech.')).toBeNull();
  expect(screen.getByText(/^Daily guests, Feb 5, 2025 to Feb 4, 2026\. Highest: 79 guests on/)).toBeTruthy();
  const toggle = screen.getByRole('button', { name: /Show the numbers/ });
  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: /Show the numbers/ }).getAttribute('aria-expanded')).toBe('true');
  const table = screen.getByRole('region', { name: 'Daily guests and net sales, last 365 days of data' });
  expect(within(table).getByText('Feb 5, 2025')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(screen.getByRole('link', { name: 'Add a closure note.' }).getAttribute('href')).toBe('/locations/l1/notes?new=closure');
});

// BLS withheld Nantucket County for April to June 2025: on web too, no chart, scrubber or numbers, only the reason.
test('Town on web for a town whose county BLS did not publish for the year: the reason, and no chart or numbers', async () => {
  const api = portal(meOf(ACCESS.member));
  api.org = orgOf('member', [locationOf('l1', 'Harbor Grill', { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' })]);
  renderAt('/locations/l1/town', api);
  expect(await screen.findByText('BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.')).toBeTruthy();
  expect(screen.queryByRole('radiogroup', { name: 'Month' })).toBeNull();
  expect(screen.queryByText('Scale fitted to this town. Index: 100 = an average month')).toBeNull();
  expect(screen.queryByRole('button', { name: /Show the numbers/ })).toBeNull();
  expect(document.body.textContent).not.toMatch(/Measured across|with the region|index points|Curve: /);
});

test('By month draws each year as its own line over January to December, with a Guests and Net sales switch, above the table', async () => {
  renderAt('/locations/l1/sales', portal(meOf(ACCESS.member)));
  const group = await screen.findByRole('radiogroup', { name: 'Show' });
  expect(within(group).getByRole('radio', { name: 'Guests' }).getAttribute('aria-checked')).toBe('true');
  const caption = screen.getByText('Average guests per day in each month, one line per year.');
  // The line that says what the chart shows comes before its scale, as Analytics' summary does.
  const scale = screen.getByText('Scale 0 to 100 guests. Scale fitted to this location.');
  expect(caption.compareDocumentPosition(scale) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The key names each year, oldest first; the newest is solid and the older dashed (charts.test.web.tsx).
  expect([...document.querySelectorAll('span[data-year]')].map((each) => each.textContent)).toEqual(['2025', '2026']);
  expect(document.querySelector('svg g[data-year="2025"] path')?.hasAttribute('stroke-dasharray')).toBe(true);
  expect(document.querySelector('svg g[data-year="2026"] path')?.hasAttribute('stroke-dasharray')).toBe(false);
  expect(screen.getByText('Scale 0 to 100 guests. Scale fitted to this location.')).toBeTruthy();
  fireEvent.click(within(group).getByRole('radio', { name: 'Net sales' }));
  expect(await screen.findByText('Average net sales per day in each month, one line per year.')).toBeTruthy();
  expect(screen.getByText('Scale 0 to $2,000. Scale fitted to this location.')).toBeTruthy();
  // The table stays below, with each month's link to its days.
  const months = screen.getByRole('region', { name: 'Sales by month' });
  expect(within(months).getByRole('button', { name: 'Jan 2025' })).toBeTruthy();
});

test('By month’s points are Analytics’ year over year: closed days are left out, and the basis line says so', async () => {
  // Made-up figures: 40 guests and $1,000 every day of 2025 and January 2026, but Jan 5, 2025, an all-zero (closed) day.
  const days = daysOf('2025-01-01', 396, (index) => (index === 4 ? { guests: 0, netSalesCents: 0 } : { guests: 40, netSalesCents: 100_000 }));
  const api = fakePortalApi({
    me: meOf(ACCESS.member), org: orgOf('member'),
    fallback: locationsFake({ sales: { l1: salesOf(days, [uploadOf('u1')]) }, days: { l1: days }, notes: { l1: [] } }),
  });
  renderAt('/locations/l1/sales', api);
  expect(await screen.findByText('Based on 395 days with a guest count. Leaves out 1 closed day.')).toBeTruthy();
  const svg = document.querySelector('svg g[data-year="2025"]')?.closest('svg');
  if (svg === null || svg === undefined) throw new Error('no chart');
  svg.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 160, right: 300, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: 6 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  act(() => { fireEvent(svg, event); });
  // January 2025 averages its 30 open days (40), not 31 days with the closed one (38.7).
  expect([...screen.getByTestId('chart-tooltip').children].map((each) => each.textContent)).toEqual(['January', '2026: 40 guests', '2025: 40 guests']);
});

test('Town on web: the month scrubber starts at this month and moves the chart’s cursor and readout, by click and key', async () => {
  // Only Date is faked, so "today" is Thu, Nov 5, 2026 and every timer stays real.
  jest.useFakeTimers({
    now: new Date(2026, 10, 5, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
  const series = townProfile('hanover-nh')?.series ?? null;
  if (series === null) throw new Error('no series');
  const { index, gap } = series;
  renderAt('/locations/l1/town', portal(meOf(ACCESS.member)));
  const group = await screen.findByRole('radiogroup', { name: 'Month' });
  const radios = within(group).getAllByRole('radio');
  const radio = (month: number): HTMLElement => {
    const found = radios[month];
    if (found === undefined) throw new Error(`no radio ${String(month)}`);
    return found;
  };
  expect(radios.map((item) => item.textContent)).toEqual([...MONTHS]);
  const checked = (): (string | null)[] => radios.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent);
  // The chart's SVG, found in the chart's own box (the one that ends with its scale line), not by page order: the top
  // bar draws icons too.
  const svg = screen.getByText('Scale fitted to this town. Index: 100 = an average month').parentElement?.querySelector('svg') ?? null;
  if (svg === null) throw new Error('no chart');
  const cursor = (): string | null | undefined => [...svg.querySelectorAll('path')]
    .find((path) => path.getAttribute('stroke') === theme.color.white)?.getAttribute('d');
  // The readout above the chart, a polite live region: the month's gap, its label, and both index values.
  const readout = (month: number): void => {
    const value = gap[month] ?? 0;
    const box = screen.getByText(`${side(value)} the Northeast, index points, ${MONTHS[month] ?? ''} 2025`).parentElement;
    expect(box?.getAttribute('aria-live')).toBe('polite');
    expect(box?.firstElementChild?.textContent).toBe(fmtSigned(value));
    expect(box?.lastElementChild?.textContent).toBe(`Grafton County ${fmt1(index[month] ?? 0)} · Northeast ${fmt1(northeastSeries.index[month] ?? 0)}`);
  };
  // It starts at this month (November), not the year's biggest gap (May), the one tab stop.
  const start = 10;
  expect(series.largestGap.monthIndex).not.toBe(start);
  expect(checked()).toEqual([MONTHS[start]]);
  expect(radios.filter((item) => item.tabIndex === 0)).toEqual([radio(start)]);
  readout(start);
  // A click picks a month: the white cursor moves to it on the chart, and the readout follows.
  fireEvent.click(radio(0));
  expect(checked()).toEqual(['Jan']);
  expect(cursor()).toBe('M12 0 V196');
  readout(0);
  // Arrows wrap, Home and End jump, and focus follows the choice.
  fireEvent.keyDown(radio(0), { key: 'ArrowLeft' });
  expect(checked()).toEqual(['Dec']);
  expect(document.activeElement).toBe(radio(11));
  expect(cursor()).toBe('M288 0 V196');
  fireEvent.keyDown(radio(11), { key: 'Home' });
  expect(checked()).toEqual(['Jan']);
  fireEvent.keyDown(radio(0), { key: 'ArrowRight' });
  expect(checked()).toEqual(['Feb']);
  expect(document.activeElement).toBe(radio(1));
  readout(1);
  fireEvent.keyDown(radio(1), { key: 'End' });
  expect(checked()).toEqual(['Dec']);
  expect(radios.filter((item) => item.tabIndex === 0)).toEqual([radio(11)]);
  // Up and Down match Left and Right, and other keys do nothing (as the homepage scrubber).
  fireEvent.keyDown(radio(11), { key: 'ArrowUp' });
  expect(checked()).toEqual(['Nov']);
  fireEvent.keyDown(radio(10), { key: 'ArrowDown' });
  expect(checked()).toEqual(['Dec']);
  fireEvent.keyDown(radio(11), { key: 'a' });
  expect(checked()).toEqual(['Dec']);
});

test('view-as on Sales data: Upload, the closure-note link and Delete stay focusable, aria-disabled, with the line', async () => {
  renderAt('/locations/l1/sales', portal(viewAsMe(ACCESS.admin)));
  await screen.findByRole('heading', { name: 'Delete sales data' });
  for (const name of ['Upload sales history', 'Add a closure note.', 'Delete all sales data']) {
    const control = screen.getByRole('button', { name });
    expectReadOnly(control, 'sales-ro');
    fireEvent.click(control);
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.pathname).toBe('/locations/l1/sales');
});

test('the note form on web: date inputs, pressed buttons, and the note it sends', async () => {
  const api = portal(meOf(ACCESS.member));
  api.answers['/api/org/locations/l1/notes'] = (body) => ({ note: noteOf('n9', { ...(body as NoteInput), createdByEmail: EMAIL }) });
  renderAt('/locations/l1/notes', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
  const starts = screen.getByLabelText('Starts');
  expect(starts.getAttribute('type')).toBe('date');
  expect(screen.getByRole('button', { name: 'Closure' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Opening' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
  expect(starts.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Enter the start date.')).toBeTruthy();
  const start = addDays(localToday(), 3);
  fireEvent.change(starts, { target: { value: start } });
  fireEvent.click(screen.getByRole('button', { name: 'Opening' }));
  expect(screen.getByRole('button', { name: 'Not sure' }).getAttribute('aria-pressed')).toBe('true');
  const monday = screen.getByRole('button', { name: 'Monday' });
  expect(monday.textContent).toBe('Mon');
  fireEvent.click(monday);
  expect(monday.getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByRole('textbox', { name: 'Details (optional)' }), { target: { value: 'The patio opens.' } });
  // The event name (D49): after Kind, optional, with its placeholder, helper and limit.
  const name = screen.getByRole('textbox', { name: 'Event name (optional)' });
  expect(name.getAttribute('placeholder')).toBe('Holiday party');
  // In UTF-16 units: room for 120 code points of emoji; checkNote refuses past 120 code points.
  expect(name.getAttribute('maxlength')).toBe('240');
  expect(screen.getByText('Name the event, not the guests.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Closure' }).compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(name.compareDocumentPosition(starts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(name, { target: { value: 'Patio season' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: '/api/org/locations/l1/notes',
    body: {
      kind: 'opening', startDate: start, endDate: start, weekdays: [1], effect: 'unknown', expectedGuests: null, detail: 'The patio opens.', title: 'Patio season',
      startTime: null, endTime: null,
    },
  }]);
  // Notes shows the name, then the kind words, then the detail.
  expect(screen.getByText('Patio season')).toBeTruthy();
});

test('Add a closure note opens the form; once the note is saved, the address drops ?new=closure', async () => {
  const api = portal(meOf(ACCESS.member));
  api.answers['/api/org/locations/l1/notes'] = (body) => ({ note: noteOf('n9', { ...(body as NoteInput), createdByEmail: EMAIL }) });
  renderAt('/locations/l1/notes?new=closure', api);
  expect(await screen.findByRole('heading', { name: 'Add a note' })).toBeTruthy();
  expect(window.location.search).toBe('?new=closure');
  fireEvent.change(screen.getByLabelText('Starts'), { target: { value: addDays(localToday(), 3) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  await waitFor(() => { expect(window.location.search).toBe(''); });
  expect(window.location.pathname).toBe('/locations/l1/notes');
  expect(screen.queryByRole('heading', { name: 'Add a note' })).toBeNull();
});

test('Notes on web: a note TownwiseAI made from a file says so under its author, with no link, and its edit form warns (D34)', async () => {
  const day = addDays(localToday(), 5);
  const own = noteOf('n1', { startDate: day, endDate: day });
  const fromFile = noteOf('n2', { kind: 'opening', startDate: day, endDate: day, effect: 'unknown', source: { via: 'ai_file', fileId: 'file-1' } });
  renderAt('/locations/l1/notes', portal(meOf(ACCESS.admin), [own, fromFile]));
  const coming = await screen.findByRole('region', { name: 'Notes coming up' });
  const rows = within(coming).getAllByRole('row').slice(1);
  const row = (kind: string): HTMLElement => {
    const found = rows.find((candidate) => within(candidate).queryByText(kind) !== null);
    if (found === undefined) throw new Error(`no ${kind} row`);
    return found;
  };
  expect(within(row('Opening')).getByText('From a file TownwiseAI read')).toBeTruthy();
  expect(within(row('Opening')).queryByRole('link')).toBeNull();
  expect(within(row('Closure')).queryByText('From a file TownwiseAI read')).toBeNull();
  fireEvent.click(within(row('Opening')).getByRole('button', { name: /^Edit Opening note/ }));
  expect(await screen.findByText('Undoing that file’s read removes this note, even after an edit.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(row('Closure')).getByRole('button', { name: /^Edit Closure note/ }));
  expect(await screen.findByRole('heading', { name: 'Edit this note' })).toBeTruthy();
  expect(screen.queryByText('Undoing that file’s read removes this note, even after an edit.')).toBeNull();
});

test('view-as on Notes and Location settings: every write is aria-disabled or read-only, with the line', async () => {
  const note = noteOf('n1', { startDate: addDays(localToday(), 5), endDate: addDays(localToday(), 5) });
  renderAt('/locations/l1/notes', portal(viewAsMe(ACCESS.admin), [note]));
  await screen.findByRole('region', { name: 'Notes coming up' });
  expectReadOnly(screen.getByRole('button', { name: 'Add a note' }), 'notes-ro');
  expectReadOnly(screen.getByRole('button', { name: /^Edit Closure note/ }), 'notes-ro');
  expectReadOnly(screen.getByRole('button', { name: /^Delete Closure note/ }), 'notes-ro');
  cleanup();
  renderAt('/locations/l2/settings', portal(viewAsMe(ACCESS.admin)));
  const name = await screen.findByRole('textbox', { name: 'Name' });
  expect(name.getAttribute('aria-readonly')).toBe('true');
  expect(name.getAttribute('aria-describedby')).toBe('location-settings-ro');
  expect(screen.getByRole('combobox', { name: 'Town' }).getAttribute('aria-disabled')).toBe('true');
  expectReadOnly(screen.getByRole('button', { name: 'Save changes' }), 'location-settings-ro');
  expectReadOnly(screen.getByRole('button', { name: 'Delete location' }), 'location-settings-ro');
});

test('view-as in TownwiseAI: the message field is read-only and Send is aria-disabled, with the line', async () => {
  const chat = fakeChatApi();
  renderAt('/locations/l1/chat', fakePortalApi({ me: viewAsMe(ACCESS.member), org: orgOf('member'), fallback: chat }));
  const field = await screen.findByLabelText(COMPOSER_LABEL);
  await waitFor(() => { expect(document.getElementById('chat-ro')).toBeTruthy(); });
  expect(field.getAttribute('aria-readonly')).toBe('true');
  // The read-only line, then the composer's privacy line (U10).
  expect(field.getAttribute('aria-describedby')).toBe('chat-ro composer-help');
  expectReadOnly(screen.getByRole('button', { name: 'Send' }), 'chat-ro');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(chat.turns).toHaveLength(0);
});
