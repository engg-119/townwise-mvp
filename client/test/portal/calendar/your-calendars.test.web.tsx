import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { CALENDARS_COPY } from '../../../src/portal/calendar/calendars';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, type FakePortalApi } from '../../helpers/portal';
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
