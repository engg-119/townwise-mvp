import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { Auth } from '../../src/auth/auth';
import { formatTime } from '../../src/portal/format';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, meOf, orgOf, refusal, STAFF_EMAIL, staffMe, VERIFIED_UNTIL, viewAsMe, writes,
  type FakePortalApi,
} from '../helpers/portal';
import { choicesOf, choose, groupsOf } from '../helpers/select';

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

function renderAt(path: string, api: FakePortalApi, overrides?: Partial<Auth>): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api, ...overrides });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

test('the staff console: panel bar, kind tag, Requests with its count, the verified time and the staff email', async () => {
  const api = fakePortalApi({ me: staffMe() });
  api.pendingCount = 4;
  renderAt('/admin', api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Requests' })).toBeTruthy();
  expect(screen.getByText('Staff console')).toBeTruthy();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  // The count is a number after the label, never a dot or badge.
  await waitFor(() => { expect(within(nav).getAllByRole('link')[0]?.textContent).toBe('Requests 4'); });
  const requests = within(nav).getByRole('link', { name: /^Requests/ });
  expect(requests.getAttribute('aria-current')).toBe('page');
  expect(requests.getAttribute('href')).toBe('/admin');
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Requests 4', 'Organizations', 'People', 'Audit log']);
  expect(screen.getByText(`Verified until ${formatTime(VERIFIED_UNTIL)}`)).toBeTruthy();
  expect(screen.getByText(STAFF_EMAIL)).toBeTruthy();
  fireEvent.click(within(nav).getByRole('link', { name: 'Organizations' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Organizations' })).toBeTruthy();
  await waitFor(() => { expect(window.location.pathname).toBe('/admin/orgs'); });
});

test('the client app marks where you are in the top bar; the header names the location and the page', async () => {
  renderAt('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
  expect(await screen.findByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  const main = screen.getByRole('navigation', { name: 'Main' });
  expect(within(main).getByRole('link', { name: 'Notes' }).getAttribute('aria-current')).toBe('page');
  expect(within(main).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Notes']);
  expect(screen.getByRole('link', { name: 'All locations' }).getAttribute('href')).toBe('/dashboard');
  expect(screen.getByRole('link', { name: 'Location settings' }).getAttribute('href')).toBe('/locations/l1/settings');
  // The location switcher is a real select, labelled “Location”; the sections then open the other location.
  const switcher = screen.getByRole('combobox', { name: 'Location' });
  choose(switcher, 'River Grill');
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l2/notes'); });
  expect(await screen.findByText('River Grill, Norwich, VT')).toBeTruthy();
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/locations/l2');
});

test('the last location opened is kept in memory only: the sections open it from Team, and nothing reaches browser storage', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  const cookie = document.cookie;
  try {
    renderAt('/locations/l2/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    expect(await screen.findByText('River Grill, Norwich, VT')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Team' }));
    await waitFor(() => { expect(window.location.pathname).toBe('/team'); });
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/locations/l2');
    expect(within(main).getByRole('link', { name: 'Upload' }).getAttribute('href')).toBe('/locations/l2/sales/upload');
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
  } finally {
    setItem.mockRestore();
  }
});

test('skip to content is the first focusable element, then the view-as banner', async () => {
  renderAt('/dashboard', fakePortalApi({ me: viewAsMe(ACCESS.member), org: orgOf('member') }));
  const banner = await screen.findByRole('region', { name: 'View-as' });
  const focusable = [...document.querySelectorAll<HTMLElement>('[tabindex="0"], a[href], button, select, input')]
    .filter((element) => element.getAttribute('tabindex') !== '-1');
  expect(focusable[0]?.textContent).toBe('Skip to content');
  expect(focusable[1]?.textContent).toBe('End view-as');
  expect(within(banner).getByText('gm@example.org, Member at Test Group.')).toBeTruthy();
});

test('view-as: the title names the target; disabled controls stay focusable; End view-as opens the console with the notice', async () => {
  const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
  api.answers['/api/admin/view-as/end'] = () => staffMe();
  renderAt('/dashboard', api);
  await screen.findByRole('region', { name: 'View-as' });
  await waitFor(() => { expect(document.title).toBe('Viewing as gm@example.org · Townwise'); });
  const add = screen.getByRole('button', { name: 'Add location' });
  expect(add.getAttribute('aria-disabled')).toBe('true');
  expect(add.hasAttribute('disabled')).toBe(false);
  // A <button> is in the tab order unless it is disabled.
  expect(add.tagName).toBe('BUTTON');
  expect(add.tabIndex).toBe(0);
  expect(add.getAttribute('aria-describedby')).toBe('locations-ro');
  expect(document.getElementById('locations-ro')?.textContent).toBe('Read-only while viewing as gm@example.org.');
  // Sign out is disabled too, and the banner's read-only line says why.
  const signOut = screen.getByRole('button', { name: 'Sign out' });
  expect(signOut.getAttribute('aria-disabled')).toBe('true');
  const why = signOut.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(why)?.textContent).toMatch(/^Read-only until \d{1,2}:\d{2} (AM|PM)\.$/);
  fireEvent.click(add);
  fireEvent.click(screen.getByRole('button', { name: 'End view-as' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin'); });
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: {} }]);
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByText(/^View-as ended at \d{1,2}:\d{2} (AM|PM)\.$/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'View-as' })).toBeNull();
});

test('a GET /api/me read that started before End view-as and answers after it doesn’t bring the banner back', async () => {
  // GET /api/org is refused, so the page re-reads GET /api/me; that read is still running when End view-as answers.
  const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: refusal(403, 'forbidden') });
  const stale = deferred<MeResponse>();
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => {
    const answer = json(path, schema, opts);
    if (path === '/api/me') api.me = stale.promise as unknown as MeResponse;
    return answer;
  };
  api.answers['/api/admin/view-as/end'] = () => staffMe();
  renderAt('/dashboard', api);
  await screen.findByRole('region', { name: 'View-as' });
  await waitFor(() => { expect(api.calls.filter((call) => call.path === '/api/me')).toHaveLength(2); });
  fireEvent.click(screen.getByRole('button', { name: 'End view-as' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin'); });
  await act(async () => { stale.resolve(viewAsMe(ACCESS.admin)); await stale.promise; });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(screen.queryByRole('region', { name: 'View-as' })).toBeNull();
  expect(window.location.pathname).toBe('/admin');
});

test('Waiting draws the town’s chart on web, with its summary and the numbers', async () => {
  renderAt('/waiting', fakePortalApi({ me: meOf(ACCESS.pending) }));
  expect(await screen.findByRole('heading', { name: 'While you wait: Stowe, VT' })).toBeTruthy();
  const svg = document.querySelector('svg');
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect(svg?.querySelectorAll('path').length).toBeGreaterThan(4);
  expect(screen.getByText('Scale fitted to this town. Index: 100 = an average month')).toBeTruthy();
  expect(screen.queryByText('See the chart at townwise.tech.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Show the numbers/ }));
  expect(screen.getByRole('button', { name: /Show the numbers/ }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('region', { name: 'Numbers: Lamoille County and the Northeast, 2024' })).toBeTruthy();
});

test('Request access on web: the Town field is a select grouped as the homepage lists the towns', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
  renderAt('/request-access', api);
  const town = await screen.findByRole('combobox', { name: 'Town' });
  expect(groupsOf(town)).toEqual(['College towns', 'Seasonal and event towns']);
  expect(choicesOf(town).at(-1)).toBe('Another town');
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  const orgName = screen.getByRole('textbox', { name: 'Organization name' });
  expect(orgName.getAttribute('aria-invalid')).toBe('true');
  expect(orgName.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2);
  expect(town.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(orgName, { target: { value: 'Sample Diner' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Your name' }), { target: { value: 'Pat' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Your role' }), { target: { value: 'Owner' } });
  choose(town, 'Ithaca, NY');
  fireEvent.change(screen.getByRole('textbox', { name: 'Number of locations' }), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/waiting'); });
  // The request, after the page's check whether the Google Places search is on (onboarding/places.ts).
  expect(writes(api).find((call) => call.path === '/api/access-requests')?.body)
    .toEqual({ orgName: 'Sample Diner', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'ithaca-ny' }, locationCount: 2 });
});
