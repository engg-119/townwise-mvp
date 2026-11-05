import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { Note, NoteInput } from '../../../src/portal/locations/api';
import { addDays, localToday } from '../../../src/portal/locations/dates';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeChatApi } from '../../helpers/chat';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
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
  // The page's one SVG; its frame holds the y scale.
  const svg = document.querySelector('svg');
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

test('Forecast on web: the empty status’s primary is the upload link; under view-as it is disabled in place', async () => {
  renderAt('/locations/l2', portal(meOf(ACCESS.admin)));
  await screen.findByText('Not started');
  const links = screen.getAllByRole('link', { name: 'Upload sales history' });
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['/locations/l2/sales/upload', '/locations/l2/sales/upload']);
  cleanup();
  renderAt('/locations/l2', portal(viewAsMe(ACCESS.admin)));
  await screen.findByText('Not started');
  const buttons = screen.getAllByRole('button', { name: 'Upload sales history' });
  expect(buttons).toHaveLength(2);
  for (const button of buttons) expectReadOnly(button, 'forecast-ro');
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
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: '/api/org/locations/l1/notes',
    body: { kind: 'opening', startDate: start, endDate: start, weekdays: [1], effect: 'unknown', expectedGuests: null, detail: 'The patio opens.' },
  }]);
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

test('view-as in the tuning chat: the message field is read-only and Send is aria-disabled, with the line', async () => {
  const chat = fakeChatApi();
  renderAt('/locations/l1/chat', fakePortalApi({ me: viewAsMe(ACCESS.member), org: orgOf('member'), fallback: chat }));
  const field = await screen.findByLabelText('Message');
  await waitFor(() => { expect(document.getElementById('chat-ro')).toBeTruthy(); });
  expect(field.getAttribute('aria-readonly')).toBe('true');
  expect(field.getAttribute('aria-describedby')).toBe('chat-ro');
  expectReadOnly(screen.getByRole('button', { name: 'Send' }), 'chat-ro');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(chat.turns).toHaveLength(0);
});
