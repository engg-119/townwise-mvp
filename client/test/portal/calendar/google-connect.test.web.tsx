import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import { GIS_SRC, resetGis, type CodeClientConfig, type CodeResponse } from '../../../src/auth/gis.web';
import type { GoogleCalendars, GoogleChoice } from '../../../src/portal/calendar/api';
import { GOOGLE_COPY, WEEKLY_TITLES_NOTICE } from '../../../src/portal/calendar/calendars';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, writes, type FakePortalApi } from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { CALENDARS_PATH, calendarFake, forecastDay, forecastOf, type CalendarFake } from './fakes';

// Google's window on web (connect-google-calendar design decisions 2, 3 and 15; google-calendar's "Connecting asks
// Google for read-only calendar access only" and "The Your calendars popover connects and picks Google calendars"),
// through the Calendar page with a fake `window.google`: Google's script loads only when "Add a Google calendar" opens
// the section, the code client is set up in the press with exactly the three scopes and a fresh `state`, and every
// answer for the current press ends the wait, while an answer for another press, after "Stop waiting" or after the
// page has gone is dropped. Today is Wed, Nov 11, 2026. A made-up client id, code and names only.

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

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 11, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
  resetGis();
  delete (window as { google?: unknown }).google;
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const CODE = '4/0Afake-code';
const GOOGLE_PATH = '/api/org/locations/l1/google-calendars';
const SCOPES = 'openid https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly';
const NOT_CONNECTED = 'Google didn’t connect Townwise. Try again.';
const CHOICES: GoogleChoice[] = [
  { id: 'primary-id', name: 'Owner', primary: true, added: false },
  { id: 'c_fake0123@group.calendar.google.com', name: 'Bookings', primary: false, added: false },
];

interface FakeGis {
  configs: CodeClientConfig[];
  initCodeClient: jest.Mock;
  requestCode: jest.Mock;
}

/** Google's script as a fake `window.google`: each code client records its config, and `requestCode` its calls. */
function fakeGis(): FakeGis {
  const configs: CodeClientConfig[] = [];
  const requestCode = jest.fn();
  const initCodeClient = jest.fn((config: CodeClientConfig) => {
    configs.push(config);
    return { requestCode };
  });
  (window as { google?: unknown }).google = { accounts: { id: { initialize: jest.fn(), renderButton: jest.fn() }, oauth2: { initCodeClient } } };
  return { configs, initCodeClient, requestCode };
}

function scripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)];
}

/** Google's script loads (or fails), as the browser reports it. */
function finishLoad(event: 'load' | 'error' = 'load'): void {
  act(() => { scripts()[0]?.dispatchEvent(new Event(event)); });
}

/** The list answers `google` as set, and GET .../google-calendars the choices; calendarFake answers neither. */
function serveGoogle(fake: CalendarFake, google: GoogleCalendars): void {
  const json = fake.json.bind(fake);
  fake.json = ((...args: Parameters<typeof json>) => {
    const [path, schema, opts] = args;
    if ((opts?.method ?? 'GET') !== 'GET' || fake.calendars instanceof ApiError) return json(...args);
    if (path === CALENDARS_PATH) {
      fake.paths.push(path);
      return Promise.resolve(schema.parse({ calendars: fake.calendars, google }));
    }
    if (path === GOOGLE_PATH) {
      fake.paths.push(path);
      return Promise.resolve(schema.parse({ calendars: CHOICES }));
    }
    return json(...args);
  }) as typeof json;
}

async function renderPage(google: GoogleCalendars = { available: true, connected: false, clientId: CLIENT_ID, canConnect: true }): Promise<{ api: FakePortalApi; fake: CalendarFake }> {
  const days = Array.from({ length: 20 }, (_, at) => forecastDay({ date: `2026-11-${String(11 + at)}` }));
  const fake = calendarFake({ events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' })], forecasts: { '2026-11': forecastOf(days) } });
  serveGoogle(fake, google);
  const me = meOf(ACCESS.member);
  const api = fakePortalApi({ me, org: orgOf('member'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = '/locations/l1/calendar?day=2026-11-21';
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  await screen.findByRole('grid', { name: 'November 2026' });
  return { api, fake };
}

function popover(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Your calendars' });
}

function openPopover(): HTMLElement {
  const button = screen.getByRole('button', { name: /^Your calendars/ });
  act(() => { button.focus(); });
  fireEvent.click(button);
  return popover();
}

function escape(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); });
}

function pressOutside(): void {
  const backdrop = popover().nextElementSibling;
  if (backdrop === null) throw new Error('no backdrop');
  fireEvent.mouseDown(backdrop);
  fireEvent.mouseUp(backdrop);
}

function closeButton(): HTMLElement {
  return within(popover()).getByRole('button', { name: 'Close' });
}

/** Opens the Google section and lets Google's script load; returns "Continue to Google", enabled. */
async function openSection(): Promise<HTMLElement> {
  fireEvent.click(within(openPopover()).getByRole('button', { name: 'Add a Google calendar' }));
  finishLoad();
  return within(popover()).findByRole('button', { name: 'Continue to Google' });
}

/** Presses "Continue to Google"; returns the press's code client config. */
function press(gis: FakeGis, button: HTMLElement): CodeClientConfig {
  fireEvent.click(button);
  const config = gis.configs.at(-1);
  if (config === undefined) throw new Error('no code client');
  return config;
}

function answer(config: CodeClientConfig, response: CodeResponse): void {
  act(() => { config.callback(response); });
}

function fail(config: CodeClientConfig, type: string): void {
  act(() => { config.error_callback({ type }); });
}

/** The section waits on Google: "Waiting for Google…" with "Stop waiting", and Close disabled. */
function waiting(): boolean {
  return within(popover()).queryByText('Waiting for Google…') !== null && closeButton().getAttribute('aria-disabled') === 'true';
}

test('no script from accounts.google.com is in the document until “Add a Google calendar” is pressed; until it loads, “Continue to Google” reads “Loading Google…”, disabled in place', async () => {
  fakeGis();
  await renderPage();
  const panel = openPopover();
  expect(scripts()).toEqual([]);
  expect(document.querySelectorAll('script[src*="accounts.google.com"]')).toHaveLength(0);
  fireEvent.click(within(panel).getByRole('button', { name: 'Add a Google calendar' }));
  expect(scripts()).toHaveLength(1);
  const loading = within(panel).getByRole('button', { name: 'Loading Google…' });
  expect(loading.getAttribute('aria-disabled')).toBe('true');
  // The explainer shows meanwhile, and focus moved to the button that took "Add a Google calendar"'s place, which the
  // explainer describes, since pressing it is the person's agreement.
  expect(within(panel).getByText(/^Sign in with Google to pick calendars from your Google account\./)).toBeTruthy();
  expect(document.activeElement).toBe(loading);
  const explainer = (button: HTMLElement): string | null | undefined => document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent;
  expect(explainer(loading)).toBe(GOOGLE_COPY.explainerShown);
  finishLoad();
  const go = await within(panel).findByRole('button', { name: 'Continue to Google' });
  expect(go).toBe(loading);
  expect(go.getAttribute('aria-disabled')).toBeNull();
  expect(document.activeElement).toBe(go);
  expect(explainer(go)).toBe(GOOGLE_COPY.explainerShown);
  // Agreeing covers the weekly suggestions' reading of titles too (calendar-event-suggestions), and who can turn it off.
  expect(explainer(go)).toContain('once a week it reads the titles, dates and hours of the next 3 months of events, with email addresses and phone numbers removed');
  expect(explainer(go)).toContain('An admin of your organization can turn off the weekly reading on the TownwiseAI page.');
  // The connect from this explainer carries the weekly notice (calendar-event-suggestions design decision 11).
  expect(WEEKLY_TITLES_NOTICE).toBe(1);
});

test('the press sets up the code client with exactly the three scopes, a popup, include_granted_scopes false, the person’s email and a fresh state, and calls requestCode inside the press', async () => {
  const gis = fakeGis();
  const { api } = await renderPage();
  const go = await openSection();
  expect(gis.initCodeClient).not.toHaveBeenCalled();
  const config = press(gis, go);
  expect(gis.initCodeClient).toHaveBeenCalledTimes(1);
  expect(gis.requestCode).toHaveBeenCalledTimes(1);
  // Exactly these keys: no prompt, redirect_uri, hd or select_account.
  expect(Object.keys(config).sort()).toEqual(
    ['callback', 'client_id', 'error_callback', 'include_granted_scopes', 'login_hint', 'scope', 'state', 'ux_mode'],
  );
  const { callback, error_callback: errorCallback, state, ...rest } = config;
  expect(rest).toEqual({ client_id: CLIENT_ID, scope: SCOPES, ux_mode: 'popup', include_granted_scopes: false, login_hint: EMAIL });
  expect(state).toMatch(/^[0-9a-f]{32}$/);
  expect(typeof callback).toBe('function');
  expect(typeof errorCallback).toBe('function');
  expect(config.scope.split(' ')).toHaveLength(3);
  expect(waiting()).toBe(true);
  expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Stop waiting' }));
  // A second press is a new client with a new state.
  fireEvent.click(within(popover()).getByRole('button', { name: 'Stop waiting' }));
  const again = press(gis, within(popover()).getByRole('button', { name: 'Continue to Google' }));
  expect(again.state).not.toBe(config.state);
  expect(gis.requestCode).toHaveBeenCalledTimes(2);
  expect(writes(api)).toEqual([]);
});

test('a code for the current press is posted with the agreement; one carrying another state, and a late one after “Stop waiting”, are dropped and nothing is posted', async () => {
  const gis = fakeGis();
  const { api } = await renderPage();
  const first = press(gis, await openSection());
  answer(first, { code: CODE, scope: SCOPES, state: 'not-this-press' });
  expect(waiting()).toBe(true);
  expect(writes(api)).toEqual([]);

  fireEvent.click(within(popover()).getByRole('button', { name: 'Stop waiting' }));
  expect(within(popover()).queryByText('Waiting for Google…')).toBeNull();
  expect(closeButton().getAttribute('aria-disabled')).toBeNull();
  answer(first, { code: CODE, scope: SCOPES, state: first.state });
  fail(first, 'popup_closed');
  expect(writes(api)).toEqual([]);
  expect(within(popover()).getByRole('button', { name: 'Continue to Google' })).toBeTruthy();

  const second = press(gis, within(popover()).getByRole('button', { name: 'Continue to Google' }));
  // The first press's answers stay dropped while the second waits.
  answer(first, { code: CODE, scope: SCOPES, state: first.state });
  expect(writes(api)).toEqual([]);
  api.answers[`${GOOGLE_PATH}/connect`] = () => ({ calendars: CHOICES });
  answer(second, { code: CODE, scope: SCOPES, state: second.state });
  expect(await within(popover()).findByText('Choose the calendars to add to Main Street Bar.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: `${GOOGLE_PATH}/connect`, body: { code: CODE, agreed: true, titlesNotice: WEEKLY_TITLES_NOTICE } }]);
  // A second answer for a press already answered is dropped too.
  answer(second, { code: CODE, scope: SCOPES, state: second.state });
  expect(writes(api)).toHaveLength(1);
});

test('a code that lands after the page has gone is dropped and nothing is posted', async () => {
  const gis = fakeGis();
  const { api } = await renderPage();
  const config = press(gis, await openSection());
  api.answers[`${GOOGLE_PATH}/connect`] = () => ({ calendars: CHOICES });
  cleanup();
  answer(config, { code: CODE, scope: SCOPES, state: config.state });
  await act(async () => { await Promise.resolve(); });
  expect(writes(api)).toEqual([]);
});

test('the popover waits for Google: Escape and a press outside leave it open with Close disabled, and “Stop waiting” ends the wait and enables Close', async () => {
  const gis = fakeGis();
  await renderPage();
  press(gis, await openSection());
  escape();
  expect(waiting()).toBe(true);
  pressOutside();
  expect(waiting()).toBe(true);
  fireEvent.click(closeButton());
  expect(waiting()).toBe(true);
  fireEvent.click(within(popover()).getByRole('button', { name: 'Stop waiting' }));
  expect(closeButton().getAttribute('aria-disabled')).toBeNull();
  expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Continue to Google' }));
  escape();
  expect(screen.queryByRole('dialog', { name: 'Your calendars' })).toBeNull();
});

test.each([
  ['the window closed (popup_closed)', (config: CodeClientConfig) => { fail(config, 'popup_closed'); }],
  ['the person said no (access_denied)', (config: CodeClientConfig) => { answer(config, { error: 'access_denied', state: config.state }); }],
])('%s: the explainer again with no message, and Close enabled', async (_name, end) => {
  const gis = fakeGis();
  const { api } = await renderPage();
  const config = press(gis, await openSection());
  end(config);
  const panel = popover();
  expect(within(panel).queryByText('Waiting for Google…')).toBeNull();
  expect(within(panel).getByText(/^Sign in with Google to pick calendars/)).toBeTruthy();
  expect(within(panel).queryByRole('alert')).toBeNull();
  expect(within(panel).queryByText(NOT_CONNECTED)).toBeNull();
  expect(closeButton().getAttribute('aria-disabled')).toBeNull();
  expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Continue to Google' }));
  expect(writes(api)).toEqual([]);
});

test('a blocked window (popup_failed_to_open) says to allow pop-ups', async () => {
  const gis = fakeGis();
  await renderPage();
  fail(press(gis, await openSection()), 'popup_failed_to_open');
  expect(within(popover()).getByText('Your browser blocked Google’s window. Allow pop-ups for townwise.tech and try again.')).toBeTruthy();
  expect(waiting()).toBe(false);
});

test.each([
  ['a callback error, admin_policy_enforced', (config: CodeClientConfig) => {
    answer(config, { error: 'admin_policy_enforced', error_description: 'Fake description from Google', state: config.state });
  }],
  ['an error callback of type unknown', (config: CodeClientConfig) => { fail(config, 'unknown'); }],
  ['a callback with neither a code nor an error', (config: CodeClientConfig) => { answer(config, { state: config.state }); }],
])('%s ends the wait with “Google didn’t connect Townwise. Try again.”, Close enabled and nothing posted', async (_name, end) => {
  const gis = fakeGis();
  const { api } = await renderPage();
  end(press(gis, await openSection()));
  const panel = popover();
  expect(within(panel).getByText(NOT_CONNECTED)).toBeTruthy();
  expect(within(panel).getByText(/^Sign in with Google to pick calendars/)).toBeTruthy();
  expect(closeButton().getAttribute('aria-disabled')).toBeNull();
  expect(document.body.textContent).not.toContain('Fake description from Google');
  expect(writes(api)).toEqual([]);
});

test('a script that fails to load says so with Try again, which loads a fresh tag; Cancel closes the section', async () => {
  const gis = fakeGis();
  await renderPage();
  fireEvent.click(within(openPopover()).getByRole('button', { name: 'Add a Google calendar' }));
  finishLoad('error');
  const retry = await within(popover()).findByRole('button', { name: 'Try again' });
  expect(within(popover()).getByText('Google’s sign-in didn’t load. Try again.').getAttribute('role')).toBe('alert');
  expect(scripts()).toEqual([]);
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  expect(scripts()).toHaveLength(1);
  finishLoad();
  const go = await within(popover()).findByRole('button', { name: 'Continue to Google' });
  press(gis, go);
  expect(gis.requestCode).toHaveBeenCalledTimes(1);
  fireEvent.click(within(popover()).getByRole('button', { name: 'Stop waiting' }));
  fireEvent.click(within(popover()).getByRole('button', { name: 'Cancel' }));
  expect(within(popover()).queryByText(/^Sign in with Google/)).toBeNull();
  expect(document.activeElement).toBe(within(popover()).getByRole('button', { name: 'Add a Google calendar' }));
});

test('a script that loads without Google’s OAuth part counts as not loaded', async () => {
  (window as { google?: unknown }).google = { accounts: { id: { initialize: jest.fn(), renderButton: jest.fn() } } };
  await renderPage();
  fireEvent.click(within(openPopover()).getByRole('button', { name: 'Add a Google calendar' }));
  finishLoad();
  expect(await within(popover()).findByText('Google’s sign-in didn’t load. Try again.')).toBeTruthy();
});

test('closed and opened again while the explainer shows, the script is not added twice and focus is on Close', async () => {
  fakeGis();
  await renderPage();
  await openSection();
  escape();
  const panel = openPopover();
  expect(await within(panel).findByRole('button', { name: 'Continue to Google' })).toBeTruthy();
  await waitFor(() => { expect(document.activeElement).toBe(within(panel).getByRole('button', { name: 'Close' })); });
  expect(scripts()).toHaveLength(1);
});
