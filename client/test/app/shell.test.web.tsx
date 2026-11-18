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
  ACCESS, deferred, EMAIL, fakePortalApi, meOf, openAsAdminMe, orgOf, refusal, STAFF_EMAIL, staffMe, VERIFIED_UNTIL, viewAsMe, writes,
  type FakePortalApi,
} from '../helpers/portal';
import { choicesOf, choose, groupsOf } from '../helpers/select';
import { moreButton, openMore } from '../helpers/topBar';

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
  expect(within(main).queryByRole('link', { name: 'Notes' })).toBeNull();
  expect(within(openMore()).getByRole('link', { name: 'Notes' }).getAttribute('aria-current')).toBe('page');
  expect(within(main).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Notes']);
  expect(screen.getByRole('link', { name: 'All locations' }).getAttribute('href')).toBe('/dashboard');
  // Location settings is under More for org admins, and nowhere else on the page.
  expect(screen.getAllByRole('link', { name: 'Location settings' })).toHaveLength(1);
  expect(within(openMore()).getByRole('link', { name: 'Location settings' }).getAttribute('href')).toBe('/locations/l1/settings');
  // The location switcher is a real select, labeled “Location”; the sections then open the other location.
  const switcher = screen.getByRole('combobox', { name: 'Location' });
  choose(switcher, 'River Grill');
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l2/notes'); });
  expect(await screen.findByText('River Grill, Norwich, VT')).toBeTruthy();
  // Another location closes More.
  expect(moreButton().getAttribute('aria-expanded')).toBe('false');
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
    expect(within(openMore()).getByRole('link', { name: 'Your data' }).getAttribute('href')).toBe('/locations/l2/data');
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
  // End names the grant the banner shows, so a tab left on an ended view-as never ends a newer grant of the session.
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: { grantId: 'g1' } }]);
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

test('open as admin: the banner is on every page; End opens the console with the notice', async () => {
  const api = fakePortalApi({ me: openAsAdminMe(), org: orgOf('org_admin') });
  api.answers['/api/admin/view-as/end'] = () => staffMe();
  renderAt('/dashboard', api);
  const banner = await screen.findByRole('region', { name: 'Townwise staff setup' });
  expect(within(banner).getByText('You’re setting up Test Group as Townwise staff. Its admins see each change you make in their Townwise staff activity.')).toBeTruthy();
  await waitFor(() => { expect(document.title).toBe('Setting up Test Group · Townwise'); });
  const nav = screen.getByRole('navigation', { name: 'Main' });
  expect(within(nav).queryByRole('link', { name: 'Team' })).toBeNull();
  fireEvent.click(within(nav).getByRole('link', { name: 'Settings' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/settings'); });
  expect(screen.getByRole('region', { name: 'Townwise staff setup' })).toBeTruthy();
  fireEvent.click(within(nav).getByRole('link', { name: 'Home' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1'); });
  expect(screen.getByRole('region', { name: 'Townwise staff setup' })).toBeTruthy();
  fireEvent.click(within(openMore()).getByRole('link', { name: 'Notes' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/notes'); });
  // Following one of its links closes More.
  expect(moreButton().getAttribute('aria-expanded')).toBe('false');
  const shown = screen.getByRole('region', { name: 'Townwise staff setup' });
  fireEvent.click(within(shown).getByRole('button', { name: 'End' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin'); });
  // D25: End names the grant this tab shows, so a tab left on an earlier grant never ends a newer one.
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: { grantId: 'g2' } }]);
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByText(/^Setting up Test Group as Townwise staff ended at \d{1,2}:\d{2} (AM|PM)\.$/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Townwise staff setup' })).toBeNull();
});

test('open as admin: Sign out stays enabled, and the top bar has no Team', async () => {
  renderAt('/dashboard', fakePortalApi({ me: openAsAdminMe(), org: orgOf('org_admin') }));
  await screen.findByRole('region', { name: 'Townwise staff setup' });
  expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('aria-disabled')).not.toBe('true');
  expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Team' })).toBeNull();
});

test('open as admin: Sign out sends End for the grant it shows first, so the end is recorded now; a failed End still signs out', async () => {
  for (const answer of [() => staffMe(), () => refusal(503, 'unavailable')]) {
    const api = fakePortalApi({ me: openAsAdminMe(), org: orgOf('org_admin') });
    api.answers['/api/admin/view-as/end'] = answer;
    let writesBefore: unknown = null;
    const signOut = jest.fn(() => { writesBefore = writes(api); return Promise.resolve(); });
    renderAt('/dashboard', api, { signOut });
    await screen.findByRole('region', { name: 'Townwise staff setup' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => { expect(signOut).toHaveBeenCalledTimes(1); });
    expect(writesBefore).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: { grantId: 'g2' } }]);
    cleanup();
  }
  // Outside the mode, Sign out sends nothing first.
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
  const signOut = jest.fn(() => Promise.resolve());
  renderAt('/dashboard', api, { signOut });
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  await waitFor(() => { expect(signOut).toHaveBeenCalledTimes(1); });
  expect(writes(api)).toEqual([]);
});

test('a GET /api/me read that finds open as admin over sends End once, and the console shows the notice', async () => {
  // The page read is refused, so the portal re-reads GET /api/me, which now shows the staff member's own access.
  const api = fakePortalApi({ me: openAsAdminMe(), org: refusal(403, 'no_access') });
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => {
    const answer = json(path, schema, opts);
    if (path === '/api/me') api.me = staffMe();
    return answer;
  };
  api.answers['/api/admin/view-as/end'] = () => staffMe();
  renderAt('/dashboard', api);
  await waitFor(() => { expect(window.location.pathname).toBe('/admin'); });
  expect(await screen.findByText(/^Setting up Test Group as Townwise staff ended at \d{1,2}:\d{2} (AM|PM)\.$/)).toBeTruthy();
  await waitFor(() => { expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: { grantId: 'g2' } }]); });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  expect(writes(api)).toHaveLength(1);
});

test('Waiting draws the town’s chart on web, with its summary and the numbers', async () => {
  renderAt('/waiting', fakePortalApi({ me: meOf(ACCESS.pending) }));
  expect(await screen.findByRole('heading', { name: 'While you wait: Stowe, VT' })).toBeTruthy();
  // The chart's SVG, found in the chart's own box (the one that ends with its scale line), not by page order: the top
  // bar draws icons too.
  const svg = screen.getByText('Scale fitted to this town. Index: 100 = an average month').parentElement?.querySelector('svg');
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect(svg?.querySelectorAll('path').length).toBeGreaterThan(4);
  expect(screen.getByText('Scale fitted to this town. Index: 100 = an average month')).toBeTruthy();
  expect(screen.queryByText('See the chart at townwise.tech.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Show the numbers/ }));
  expect(screen.getByRole('button', { name: /Show the numbers/ }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('region', { name: 'Numbers: Lamoille County and the Northeast, 2025' })).toBeTruthy();
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
