jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions } from 'react-native';
import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { calendarRange } from '../../src/portal/analytics/api';
import { formatTime } from '../../src/portal/format';
import { localToday } from '../../src/portal/locations/dates';
import type { MeResponse } from '../../src/portal/schemas';
import {
  ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, STAFF_EMAIL, staffMe, viewAsMe, writes,
} from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { analyticsFake, calendarBody, day, historyBody } from '../portal/analytics/fakes';
import { ruleOf, rulesFake } from '../portal/rules/fakes';

const WINDOW = Dimensions.get('window');

afterEach(async () => {
  await cleanup();
});

/** The links of a navigation region, by accessible name, in order; every link must have one of `names`. */
function linkNames(region: string, names: readonly string[]): string[] {
  const nav = screen.getByLabelText(region);
  const found = names.filter((name) => within(nav).queryByRole('link', { name }) !== null);
  expect(within(nav).getAllByRole('link')).toHaveLength(found.length);
  return found;
}

const NAV = ['Home', 'TownwiseAI', 'Calendar', 'Orders', 'Analytics', 'Notes', 'Rules', 'Town', 'Your data', 'Location settings', 'Team', 'Settings'];
/** The sections under More (D38), which open in a row under the bar on native. */
const MORE = ['Notes', 'Rules', 'Town', 'Your data'];
/** More for org admins, who also get Location settings (P16). */
const ADMIN_MORE = [...MORE, 'Location settings'];

function navLabels(): string[] {
  return linkNames('Main', NAV);
}

function navLink(name: string) {
  return within(screen.getByLabelText('Main')).getByRole('link', { name });
}

/** A section under More, opening More first when its row is closed. */
async function moreLink(name: string) {
  if (screen.queryByLabelText('More') === null) await fireEvent.press(within(screen.getByLabelText('Main')).getByRole('button', { name: 'More' }));
  return within(screen.getByLabelText('More')).getByRole('link', { name });
}

describe('the client app top bar (spec 15.2, 15.3)', () => {
  test('members: the organization, the first location’s sections and Settings, the email and Sign out', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    const { router } = await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), { signOut });
    await screen.findByText('Main Street Bar');
    expect(navLabels()).toEqual(['Home', 'TownwiseAI', 'Calendar', 'Orders', 'Analytics', 'Settings']);
    // Notes, Rules, Town and Your data open in a row under the bar, and More says so.
    const more = within(screen.getByLabelText('Main')).getByRole('button', { name: 'More' });
    expect(more.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByLabelText('More')).toBeNull();
    await fireEvent.press(more);
    expect(more.props.accessibilityState).toMatchObject({ expanded: true });
    expect(linkNames('More', NAV)).toEqual(MORE);
    // Off a location page no section is current.
    for (const name of navLabels()) expect(navLink(name).props.accessibilityState).toMatchObject({ selected: false });
    for (const name of MORE) expect((await moreLink(name)).props.accessibilityState).toMatchObject({ selected: false });
    await fireEvent.press(more);
    expect(screen.queryByLabelText('More')).toBeNull();
    expect(screen.getAllByText('Test Group').length).toBeGreaterThan(0);
    expect(screen.getByText(EMAIL)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await fireEvent.press(navLink('Settings'));
    expect(router.getPathname()).toBe('/settings');
    expect(navLink('Settings').props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(navLink('Home'));
    expect(router.getPathname()).toBe('/locations/l1');
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: true });
  });

  test('org admins add Team', async () => {
    const { router } = await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    await screen.findByText('Main Street Bar');
    expect(navLabels()).toEqual(NAV.filter((name) => !ADMIN_MORE.includes(name)));
    await moreLink('Town');
    expect(linkNames('More', NAV)).toEqual(ADMIN_MORE);
    await fireEvent.press(navLink('Team'));
    expect(router.getPathname()).toBe('/team');
  });

  test('the sections keep opening the last location opened, from pages outside a location', async () => {
    const { router } = await renderApp('/locations/l2/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    await screen.findByText('River Grill, Norwich, VT');
    await fireEvent.press(navLink('Team'));
    expect(router.getPathname()).toBe('/team');
    await fireEvent.press(navLink('TownwiseAI'));
    expect(router.getPathname()).toBe('/locations/l2/agent');
  });

  test('with no location yet the bar has only Team and Settings', async () => {
    await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', []) }));
    expect(await screen.findByRole('heading', { name: 'Add your first location' })).toBeTruthy();
    expect(navLabels()).toEqual(['Team', 'Settings']);
  });

  test('a sign-out the server could not finish says so', async () => {
    await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), {
      signOut: () => Promise.reject(offline()),
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Couldn’t sign out. Check your connection and try again.')).toBeTruthy();
  });

  test('at 320px the email hides and the nav stays, in a region that scrolls sideways', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 320 });
    try {
      await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
      await screen.findAllByText('Main Street Bar');
      expect(screen.queryByText(EMAIL)).toBeNull();
      expect(navLabels()).toEqual(['Home', 'TownwiseAI', 'Calendar', 'Orders', 'Analytics', 'Settings']);
      expect(within(screen.getByLabelText('Sections')).getByLabelText('Main')).toBeTruthy();
      // More sits in the scrolling row; its row opens under it, outside the scroller.
      await moreLink('Notes');
      expect(linkNames('More', NAV)).toEqual(MORE);
      expect(within(screen.getByLabelText('Sections')).queryByLabelText('More')).toBeNull();
      // The table stacks into label and value pairs.
      const table = screen.getByLabelText('Locations');
      expect(within(table).getAllByText('Sales history')).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('location pages (spec 15.2)', () => {
  test('members: the eyebrow names the location, the h1 the page; Home is current; no Location settings link', async () => {
    const { router } = await renderApp('/locations/l1', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    expect(await screen.findByText('Main Street Bar, Hanover, NH')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Welcome back/ })).toBeTruthy();
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole('link', { name: 'All locations' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
    await fireEvent.press(await moreLink('Notes'));
    expect(router.getPathname()).toBe('/locations/l1/notes');
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
    // Another page closes More's row.
    expect(screen.queryByLabelText('More')).toBeNull();
    expect((await moreLink('Notes')).props.accessibilityState).toMatchObject({ selected: true });
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: false });
  });

  test('any move to another page closes More, also between pages that draw the same nav (Location settings and Locations)', async () => {
    const { router } = await renderApp('/locations/l1/settings', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    expect(await screen.findByRole('heading', { name: 'Location settings' })).toBeTruthy();
    await moreLink('Town');
    expect(screen.getByLabelText('More')).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'All locations' }));
    expect(router.getPathname()).toBe('/dashboard');
    await screen.findByText('Main Street Bar');
    expect(screen.queryByLabelText('More')).toBeNull();
    expect(within(screen.getByLabelText('Main')).getByRole('button', { name: 'More' }).props.accessibilityState).toMatchObject({ expanded: false });
  });

  test('Calendar opens under its own title, right after Home, and is marked', async () => {
    const { router } = await renderApp('/locations/l1', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    await screen.findByText('Main Street Bar, Hanover, NH');
    await fireEvent.press(navLink('Calendar'));
    expect(router.getPathname()).toBe('/locations/l1/calendar');
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeTruthy();
    expect(navLink('Calendar').props.accessibilityState).toMatchObject({ selected: true });
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: false });
  });

  test('a member opens Business rules from Rules, right after Notes, and Rules is marked (P29)', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: rulesFake([ruleOf('r1', 'Closed Mondays')]) });
    const { router } = await renderApp('/locations/l1', api);
    await screen.findByText('Main Street Bar, Hanover, NH');
    await fireEvent.press(await moreLink('Rules'));
    expect(router.getPathname()).toBe('/locations/l1/rules');
    expect(await screen.findByRole('heading', { name: 'Business rules' })).toBeTruthy();
    expect(await screen.findByText('Closed Mondays')).toBeTruthy();
    expect((await moreLink('Rules')).props.accessibilityState).toMatchObject({ selected: true });
    expect(navLink('TownwiseAI').props.accessibilityState).toMatchObject({ selected: false });
  });

  // U7: Analytics replaced U5's In progress stub (spec P24); its own suites are under test/portal/analytics/.
  test('Analytics opens under its own title and is marked, and leads to Sales data, which marks it too', async () => {
    const path = '/api/org/locations/l1';
    const fallback = analyticsFake({
      [`${path}/sales/history`]: historyBody([day('2026-02-04', 50)]),
      [`${path}/notes`]: { notes: [] },
      [`${path}/calendar?${new URLSearchParams(calendarRange('2026-02-04', localToday())).toString()}`]: calendarBody(),
    });
    const { router } = await renderApp('/locations/l1/analytics', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback }));
    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeTruthy();
    expect(await screen.findByText('1 day, Feb 4, 2026 to Feb 4, 2026.')).toBeTruthy();
    expect(screen.queryByText('In progress')).toBeNull();
    expect(navLink('Analytics').props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByRole('link', { name: 'Sales data' }));
    expect(router.getPathname()).toBe('/locations/l1/sales');
    expect(await screen.findByRole('heading', { name: 'Sales data' })).toBeTruthy();
    expect(navLink('Analytics').props.accessibilityState).toMatchObject({ selected: true });
  });

  test('org admins get Location settings under More, never in the header; the switcher opens the same page of another location', async () => {
    const { router } = await renderApp('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    await screen.findByText('Main Street Bar, Hanover, NH');
    // With More closed no page shows the link.
    expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
    await fireEvent.press(await moreLink('Location settings'));
    expect(router.getPathname()).toBe('/locations/l1/settings');
    expect(await screen.findByRole('heading', { name: 'Location settings' })).toBeTruthy();
    expect((await moreLink('Location settings')).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(await moreLink('Notes'));
    await fireEvent.press(screen.getByRole('button', { name: 'Location' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'River Grill' }));
    expect(router.getPathname()).toBe('/locations/l2/notes');
    expect(await screen.findByText('River Grill, Norwich, VT')).toBeTruthy();
    expect((await moreLink('Notes')).props.accessibilityState).toMatchObject({ selected: true });
  });

  test('one location has no switcher and no All locations', async () => {
    await renderApp('/locations/l1', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', orgOf('member').locations.slice(0, 1)) }));
    // With one location the eyebrow is its town alone (D29).
    await screen.findByText('Hanover, NH');
    expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'All locations' })).toBeNull();
  });

  test('a location not in the organization is not available, with a way back', async () => {
    const { router } = await renderApp('/locations/l404', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
    // The sections open a location the organization has.
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: false });
    await fireEvent.press(screen.getByRole('link', { name: 'Locations' }));
    expect(router.getPathname()).toBe('/dashboard');
  });
});

describe('the view-as banner (spec 15.5)', () => {
  test('names the target, the end time, and keeps Sign out disabled; End view-as returns to the console', async () => {
    const me: MeResponse = viewAsMe(ACCESS.admin, '2026-11-04T19:00:00.000Z');
    const api = fakePortalApi({ me, org: orgOf('org_admin') });
    api.answers['/api/admin/view-as/end'] = () => staffMe();
    const signOut = jest.fn(() => Promise.resolve());
    const { router } = await renderApp('/dashboard', api, { signOut });
    const banner = await screen.findByLabelText('View-as');
    expect(within(banner).getByText('Viewing as')).toBeTruthy();
    expect(within(banner).getByText('gm@example.org, Admin at Test Group.')).toBeTruthy();
    expect(within(banner).getByText(`Read-only until ${formatTime('2026-11-04T19:00:00.000Z')}.`)).toBeTruthy();
    // The top bar shows the signed-in staff member, with Sign out disabled.
    expect(screen.getByText(STAFF_EMAIL)).toBeTruthy();
    const signOutButton = screen.getByRole('button', { name: 'Sign out' });
    expect(signOutButton.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(within(banner).getByRole('button', { name: 'End view-as' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/admin/overview'); });
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: { grantId: 'g1' } }]);
    expect(screen.queryByLabelText('View-as')).toBeNull();
    expect(await screen.findByText(/^View-as ended at \d{1,2}:\d{2} (AM|PM)\.$/)).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  test('a target with no organization; the gate frame names the staff member', async () => {
    await renderApp('/waiting', fakePortalApi({ me: viewAsMe(ACCESS.pending) }));
    const banner = await screen.findByLabelText('View-as');
    expect(within(banner).getByText('gm@example.org, signed in, no organization.')).toBeTruthy();
    expect(screen.getByText(`Signed in as ${STAFF_EMAIL}`)).toBeTruthy();
  });

  test('when a re-read finds view-as over, staff land on the console with the end time', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.pending, '2026-11-04T17:00:00.000Z') });
    const { router } = await renderApp('/waiting', api);
    await screen.findByLabelText('View-as');
    api.me = staffMe();
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/admin/overview'); });
    // It ran out before the re-read, so the notice gives its end time.
    expect(await screen.findByText(`View-as ended at ${formatTime('2026-11-04T17:00:00.000Z')}.`)).toBeTruthy();
  });
});

describe('the staff console on native (spec 15.4)', () => {
  test('says the console is on the web, in place of its pages', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    await renderApp('/admin/people', fakePortalApi({ me: staffMe() }), { signOut });
    expect(await screen.findByText('The staff console is on the web. Open townwise.tech on a computer.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'People' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
  });
});
