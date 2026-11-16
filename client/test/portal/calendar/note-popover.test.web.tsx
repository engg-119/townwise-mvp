import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, router } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';
import { calendarFake, forecastDay, forecastOf, NOTES_PATH, ownerCalendar, ownerEvent, savedNote, type CalendarFake } from './fakes';

// The note form's popover on web (calendar-views' "The note form opens in a popover", refine-calendar-and-home design
// decision 2): the day panel's Add an event, a note's Edit and an event's Make a note open the note form in a dialog
// anchored to the pressed button and headed by it, so the panel keeps its shape; a press outside keeps the form, a save
// closes it with focus back on its opener, a 404 closes it with focus on the panel's notice, it waits while a save runs,
// and a change of `?day=` closes it. Today is Wed, Nov 11, 2026. Synthetic figures and made-up titles only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide and tall, which is a phone to react-native-web; these tests cover the desktop layout,
// 1280 by 900, so a card anchored to its opener has room under or over it.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 1280 });
Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => 900 });

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

const SATURDAY = '2026-11-21';
const PARTY = noteOf('n1', { kind: 'private_event', effect: 'more_guests', startDate: SATURDAY, endDate: SATURDAY, expectedGuests: 40 });
const EDIT = 'Edit Private event note, Nov 21, 2026';
const GONE = 'This note isn’t available.';
const KITCHEN = ownerCalendar({ id: 'c1', label: 'kitchen', kind: 'file', eventCount: 1 });
const DINNER = ownerEvent({
  calendarId: 'c1', calendar: 'kitchen', uid: 'i1', title: 'Smith rehearsal dinner', startDate: SATURDAY, startTime: '18:00', endTime: '21:00',
});

/** November from today on; `noted` adds a note's guests to Nov 21 as the API would. */
function november(noted?: { guests: number; id: string }): unknown {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    if (date !== SATURDAY || noted === undefined) { days.push(forecastDay({ date })); continue; }
    days.push(forecastDay({
      date, low: 180 + noted.guests, mid: 212 + noted.guests, high: 240 + noted.guests, model: { status: 'open', low: 180, mid: 212, high: 240 },
      noteGuests: noted.guests,
      reasons: [{ kind: 'note', label: `Your private event, ${String(noted.guests)} guests`, effectPct: null, sources: [], note: { id: noted.id, guests: noted.guests, outcome: 'added' } }],
    }));
  }
  return forecastOf(days);
}

function setup(
  init: Partial<Pick<CalendarFake, 'notes' | 'forecasts' | 'calendars' | 'ownerEvents'>> = {}, me: MeResponse = meOf(ACCESS.member),
): { api: FakePortalApi; fake: CalendarFake } {
  const fake = calendarFake({
    events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })],
    forecasts: { '2026-11': november() },
    ...init,
  });
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
}

async function renderAt(path: string, api: FakePortalApi): Promise<HTMLElement> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return screen.findByRole('grid', { name: 'November 2026' });
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Selected day' });
}

/** The open note form popover, by its heading. */
function dialog(name: string): HTMLElement {
  return screen.getByRole('dialog', { name });
}

/** Puts keyboard focus on `element`, as Tab would (Pressable notes its focus in state, hence act). */
function focus(element: HTMLElement): void {
  act(() => { element.focus(); });
}

/** Presses one of the day panel's buttons, which a press or Tab has focused first; returns it. */
function press(name: string): HTMLElement {
  const button = within(panel()).getByRole('button', { name });
  focus(button);
  fireEvent.click(button);
  return button;
}

function escape(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); });
}

/**
 * A press on the page around the popover, which lands on its transparent backdrop; true when its mousedown was
 * cancelled, which in a browser keeps focus where it was.
 */
function pressOutside(card: HTMLElement): boolean {
  const backdrop = card.nextElementSibling;
  if (backdrop === null) throw new Error('no backdrop');
  const kept = !fireEvent.mouseDown(backdrop);
  fireEvent.mouseUp(backdrop);
  return kept;
}

function guests(card: HTMLElement): HTMLInputElement {
  return within(card).getByLabelText<HTMLInputElement>('Expected guests (optional)');
}

/** Whether focus is on the panel's notice that says `text`, a line that takes focus from script (tabIndex -1). */
function focusOnNotice(text: string): boolean {
  const line = within(panel()).queryByText(text);
  const active = document.activeElement;
  return line !== null && active !== null && active !== document.body && active.getAttribute('tabindex') === '-1' && active.contains(line);
}

test('Add an event opens a dialog of that name, prefilled for the day, with focus on Kind and one heading, and the panel keeps its shape', async () => {
  const { api } = setup();
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const before = panel().innerHTML;
  const button = press('Add an event');
  const card = dialog('Add an event');
  expect(within(card).getByRole('group', { name: 'Kind' }).contains(document.activeElement)).toBe(true);
  expect(within(card).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Add an event']);
  expect(within(card).queryByRole('region')).toBeNull();
  expect(within(card).queryByText('Add a note')).toBeNull();
  expect(within(card).getByRole('button', { name: 'Private event' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(card).getByRole('button', { name: 'More guests than usual' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(card).getByLabelText<HTMLInputElement>('Starts').value).toBe(SATURDAY);
  // The form floats in the Modal: the panel holds none of it and still has its button.
  expect(panel().contains(card)).toBe(false);
  expect(within(panel()).queryByLabelText('Expected guests (optional)')).toBeNull();
  expect(within(panel()).getByRole('button', { name: 'Add an event' })).toBe(button);
  expect(panel().innerHTML).toBe(before);
  // Escape closes it and gives focus back to its opener.
  escape();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(writes(api)).toEqual([]);
});

test('a press outside keeps the popover open with what was typed and focus in it; Cancel closes it and focus goes back to the opener', async () => {
  const { api } = setup();
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const button = press('Add an event');
  const card = dialog('Add an event');
  focus(guests(card));
  fireEvent.change(guests(card), { target: { value: '70' } });
  expect(pressOutside(card)).toBe(true);
  expect(dialog('Add an event')).toBe(card);
  expect(guests(card).value).toBe('70');
  expect(document.activeElement).toBe(guests(card));
  // The press selected no day either.
  expect(window.location.search).toBe(`?day=${SATURDAY}`);
  fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(writes(api)).toEqual([]);
});

test('a save closes it with focus on Add an event, and the panel says “Saved.” until the forecast reads again, then what the note did', async () => {
  const { api, fake } = setup();
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const button = press('Add an event');
  const card = dialog('Add an event');
  fireEvent.change(guests(card), { target: { value: '70' } });
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november({ guests: 70, id: 'n9' });
    return saved;
  };
  const release = fake.hold('forecast', '2026-10-26');
  fireEvent.click(within(card).getByRole('button', { name: 'Save note' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(document.activeElement).toBe(button);
  expect(await within(panel()).findByText('Saved.')).toBeTruthy();
  await act(async () => { release(); await Promise.resolve(); });
  expect(await within(panel()).findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${NOTES_PATH}`]);
});

test('Edit opens a dialog “Edit note” anchored to that Edit, with the note’s fields', async () => {
  const { api } = setup({ notes: [PARTY], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) } });
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const edit = press(EDIT);
  const card = dialog('Edit note');
  expect(within(card).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Edit note']);
  expect(within(card).queryByText('Edit this note')).toBeNull();
  expect(within(card).getByRole('button', { name: 'Private event' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(card).getByLabelText<HTMLInputElement>('Starts').value).toBe(SATURDAY);
  expect(guests(card).value).toBe('40');
  escape();
  expect(document.activeElement).toBe(edit);
});

test('Make a note opens a dialog “Make a note” from the event, without its title', async () => {
  const { api } = setup({ calendars: [KITCHEN], ownerEvents: [DINNER] });
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const make = press('Make a note from Smith rehearsal dinner');
  const card = dialog('Make a note');
  expect(within(card).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Make a note']);
  expect(within(card).getByLabelText<HTMLInputElement>('Starts at').value).toBe('18:00');
  expect(within(card).getByLabelText<HTMLInputElement>('Details (optional)').value).toBe('');
  escape();
  expect(document.activeElement).toBe(make);
});

type Measured = HTMLElement & { measureInWindow: (callback: (...box: number[]) => void) => void };

/** Gives the panel's button `name` the box x, y, width, height in the window, which jsdom's layout leaves 0 by 0. */
function placeAt(name: string, box: [number, number, number, number]): void {
  within(panel()).getByRole<Measured>('button', { name }).measureInWindow = (callback) => { callback(...box); };
}

/** The card's top, bottom, left, width and maxHeight, from its own style. */
function placeOf(card: HTMLElement): string[] {
  const style = window.getComputedStyle(card);
  return [style.top, style.bottom, style.left, style.width, style.maxHeight];
}

test('each opener anchors the popover to itself: Edit, Make a note and Add an event each place it by their own box', async () => {
  const { api } = setup({ notes: [PARTY], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) }, calendars: [KITCHEN], ownerEvents: [DINNER] });
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  // Three boxes down the panel's column, each centered in the window's right half, so the 400px card's right edge
  // lines up with its opener's.
  placeAt(EDIT, [900, 300, 40, 20]);
  placeAt('Make a note from Smith rehearsal dinner', [920, 500, 100, 20]);
  placeAt('Add an event', [900, 640, 160, 44]);
  // 580px below Edit: under it, 8px down, at most 580 less 24px tall.
  press(EDIT);
  expect(placeOf(dialog('Edit note'))).toEqual(['328px', '', '540px', '400px', '556px']);
  escape();
  // 380px below Make a note: under it too.
  press('Make a note from Smith rehearsal dinner');
  expect(placeOf(dialog('Make a note'))).toEqual(['528px', '', '620px', '400px', '356px']);
  escape();
  // 216px below Add an event, less than 320 and than the 640 above: over it, its bottom edge 8px above the button.
  press('Add an event');
  expect(placeOf(dialog('Add an event'))).toEqual(['', '268px', '660px', '400px', '616px']);
  escape();
  expect(writes(api)).toEqual([]);
});

/** Edits the note, which the API then answers 404 for: the popover closes and the panel says so. */
async function editGone(api: FakePortalApi): Promise<void> {
  press(EDIT);
  const card = dialog('Edit note');
  fireEvent.change(guests(card), { target: { value: '70' } });
  api.answers[`${NOTES_PATH}/n1`] = () => refusal(404, 'not_found');
  fireEvent.click(within(card).getByRole('button', { name: 'Save note' }));
  expect(await within(panel()).findByText(GONE)).toBeTruthy();
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
}

test('a 404 on an edit closes the popover, the panel says so, and focus moves to that notice', async () => {
  const { api } = setup({ notes: [PARTY], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) } });
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await editGone(api);
  await waitFor(() => { expect(focusOnNotice(GONE)).toBe(true); });
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`PATCH ${NOTES_PATH}/n1`]);
});

test('a saved edit gives focus back to its Edit, or to the panel’s “Saved.” when the note no longer covers the day', async () => {
  const { api, fake } = setup({ notes: [PARTY], forecasts: { '2026-11': november({ guests: 40, id: 'n1' }) } });
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  api.answers[`${NOTES_PATH}/n1`] = (body) => {
    const saved = savedNote('n1', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november(saved.note.startDate === SATURDAY ? { guests: 70, id: 'n1' } : undefined);
    return saved;
  };
  // Still on Nov 21: its Edit stays, and has focus.
  const edit = press(EDIT);
  fireEvent.change(guests(dialog('Edit note')), { target: { value: '70' } });
  fireEvent.click(within(dialog('Edit note')).getByRole('button', { name: 'Save note' }));
  expect(await within(panel()).findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(panel()).getByRole('button', { name: EDIT })).toBe(edit);
  expect(document.activeElement).toBe(edit);
  // Moved to Nov 22: its Edit goes from this day once the notes read again, so focus moves to the notice instead.
  press(EDIT);
  fireEvent.change(within(dialog('Edit note')).getByLabelText('Starts'), { target: { value: '2026-11-22' } });
  fireEvent.click(within(dialog('Edit note')).getByRole('button', { name: 'Save note' }));
  await waitFor(() => { expect(within(panel()).queryByRole('button', { name: EDIT })).toBeNull(); });
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => { expect(focusOnNotice('Saved.')).toBe(true); });
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([`PATCH ${NOTES_PATH}/n1`, `PATCH ${NOTES_PATH}/n1`]);
});

test('after a 404 focus goes to the panel’s notice, not to a page notice above the grid', async () => {
  // No published forecast: its notice heads the page, before the panel.
  const { api } = setup({ notes: [PARTY], forecasts: {} });
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  expect(screen.getByText(/^Townwise hasn’t published a forecast for Main Street Bar yet\. Days show/)).toBeTruthy();
  await editGone(api);
  await waitFor(() => { expect(focusOnNotice(GONE)).toBe(true); });
});

test('while “Saving…” the popover waits: Escape, Cancel (disabled in place) and a press outside leave it open, and the answer shows in it', async () => {
  const { api } = setup();
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const button = press('Add an event');
  const card = dialog('Add an event');
  fireEvent.change(guests(card), { target: { value: '70' } });
  const answer = deferred<unknown>();
  api.answers[NOTES_PATH] = () => answer.promise;
  fireEvent.click(within(card).getByRole('button', { name: 'Save note' }));
  expect(await within(card).findByRole('button', { name: 'Saving…' })).toBeTruthy();
  escape();
  const cancel = within(card).getByRole('button', { name: 'Cancel' });
  expect(cancel.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(cancel);
  pressOutside(card);
  expect(dialog('Add an event')).toBe(card);
  await act(async () => { answer.reject(refusal(409, 'note_limit')); await Promise.resolve(); });
  expect(await within(card).findByText('This location has 1,000 notes. Delete old ones to add more.')).toBeTruthy();
  expect(guests(card).value).toBe('70');
  expect(within(card).getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled')).toBeNull();
  expect(writes(api)).toHaveLength(1);
  // Answered, it closes again.
  escape();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
});

test('a ?day= change that doesn’t come through a day click closes the form, and the next one opens for the new day', async () => {
  const { api } = setup();
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  press('Add an event');
  fireEvent.change(guests(dialog('Add an event')), { target: { value: '70' } });
  // As browser back or forward to another Calendar entry, or a link, would.
  act(() => { router.setParams({ day: '2026-11-20' }); });
  await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Fri, Nov 20, 2026' })).toBeTruthy(); });
  expect(screen.queryByRole('dialog')).toBeNull();
  press('Add an event');
  const card = dialog('Add an event');
  expect(within(card).getByLabelText<HTMLInputElement>('Starts').value).toBe('2026-11-20');
  expect(guests(card).value).toBe('');
  expect(writes(api)).toEqual([]);
});

test('view-as: Add an event, Edit and Make a note stay disabled in place and open nothing', async () => {
  const { api } = setup({ notes: [PARTY], calendars: [KITCHEN], ownerEvents: [DINNER] }, viewAsMe(ACCESS.admin));
  await renderAt(`/locations/l1/calendar?day=${SATURDAY}`, api);
  for (const name of ['Add an event', EDIT, 'Make a note from Smith rehearsal dinner']) {
    const control = within(panel()).getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(control);
    expect(screen.queryByRole('dialog')).toBeNull();
  }
  expect(writes(api)).toEqual([]);
});
