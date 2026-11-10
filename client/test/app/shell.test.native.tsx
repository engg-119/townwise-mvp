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

const NAV = ['Home', 'Analytics', 'TownwiseAI', 'Notes', 'Town', 'Your data', 'Team', 'Settings'];

function navLabels(): string[] {
  return linkNames('Main', NAV);
}

function navLink(name: string) {
  return within(screen.getByLabelText('Main')).getByRole('link', { name });
}

describe('the client app top bar (spec 15.2, 15.3)', () => {
  test('members: the organization, the first location’s sections and Settings, the email and Sign out', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    const { router } = await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), { signOut });
    await screen.findByText('Main Street Bar');
    expect(navLabels()).toEqual(['Home', 'Analytics', 'TownwiseAI', 'Notes', 'Town', 'Your data', 'Settings']);
    // Off a location page no section is current.
    for (const name of navLabels()) expect(navLink(name).props.accessibilityState).toMatchObject({ selected: false });
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
    expect(navLabels()).toEqual(NAV);
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
      expect(navLabels()).toEqual(['Home', 'Analytics', 'TownwiseAI', 'Notes', 'Town', 'Your data', 'Settings']);
      expect(within(screen.getByLabelText('Sections')).getByLabelText('Main')).toBeTruthy();
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
    expect(screen.getByRole('heading', { name: /^Week of [A-Z][a-z]{2} \d{1,2}, \d{4}$/ })).toBeTruthy();
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole('link', { name: 'All locations' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
    await fireEvent.press(navLink('Notes'));
    expect(router.getPathname()).toBe('/locations/l1/notes');
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
    expect(navLink('Notes').props.accessibilityState).toMatchObject({ selected: true });
    expect(navLink('Home').props.accessibilityState).toMatchObject({ selected: false });
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

  test('org admins get Location settings in the header; the switcher opens the same page of another location', async () => {
    const { router } = await renderApp('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    await screen.findByText('Main Street Bar, Hanover, NH');
    await fireEvent.press(screen.getByRole('link', { name: 'Location settings' }));
    expect(router.getPathname()).toBe('/locations/l1/settings');
    expect(await screen.findByRole('heading', { name: 'Location settings' })).toBeTruthy();
    // On its own page the link is not repeated.
    expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
    await fireEvent.press(navLink('Notes'));
    await fireEvent.press(screen.getByRole('button', { name: 'Location' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'River Grill' }));
    expect(router.getPathname()).toBe('/locations/l2/notes');
    expect(await screen.findByText('River Grill, Norwich, VT')).toBeTruthy();
    expect(navLink('Notes').props.accessibilityState).toMatchObject({ selected: true });
  });

  test('one location has no switcher and no All locations', async () => {
    await renderApp('/locations/l1', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', orgOf('member').locations.slice(0, 1)) }));
    await screen.findByText('Main Street Bar, Hanover, NH');
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
    await waitFor(() => { expect(router.getPathname()).toBe('/admin'); });
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
    await waitFor(() => { expect(router.getPathname()).toBe('/admin'); });
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
