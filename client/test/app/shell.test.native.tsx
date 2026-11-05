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

import { formatTime } from '../../src/portal/format';
import type { MeResponse } from '../../src/portal/schemas';
import {
  ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, STAFF_EMAIL, staffMe, viewAsMe, writes,
} from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';

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

function navLabels(): string[] {
  return linkNames('Main', ['Locations', 'Team', 'Settings']);
}

describe('the client app top bar (spec 15.2, 15.3)', () => {
  test('members: the organization, Locations and Settings, the email and Sign out', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    const { router } = await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), { signOut });
    await screen.findByText('Main Street Bar');
    expect(navLabels()).toEqual(['Locations', 'Settings']);
    expect(screen.getByRole('link', { name: 'Locations' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getAllByText('Test Group').length).toBeGreaterThan(0);
    expect(screen.getByText(EMAIL)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('link', { name: 'Settings' }));
    expect(router.getPathname()).toBe('/settings');
    expect(screen.getByRole('link', { name: 'Settings' }).props.accessibilityState).toMatchObject({ selected: true });
  });

  test('org admins add Team', async () => {
    const { router } = await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    await screen.findByText('Main Street Bar');
    expect(navLabels()).toEqual(['Locations', 'Team', 'Settings']);
    await fireEvent.press(screen.getByRole('link', { name: 'Team' }));
    expect(router.getPathname()).toBe('/team');
  });

  test('a sign-out the server could not finish says so', async () => {
    await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }), {
      signOut: () => Promise.reject(offline()),
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Couldn’t sign out. Check your connection and try again.')).toBeTruthy();
  });

  test('at 320px the email hides and the nav stays', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 320 });
    try {
      await renderApp('/dashboard', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
      await screen.findAllByText('Main Street Bar');
      expect(screen.queryByText(EMAIL)).toBeNull();
      expect(navLabels()).toEqual(['Locations', 'Settings']);
      // The table stacks into label and value pairs.
      const table = screen.getByLabelText('Locations');
      expect(within(table).getAllByText('Sales history')).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('location pages (spec 15.2)', () => {
  test('members: the header, Forecast selected, and no Settings tab', async () => {
    const { router } = await renderApp('/locations/l1', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    expect(await screen.findByRole('heading', { name: 'Main Street Bar' })).toBeTruthy();
    expect(screen.getByText('Hanover, NH')).toBeTruthy();
    const tabs = screen.getByLabelText('Location sections');
    expect(linkNames('Location sections', ['Forecast', 'Sales data', 'Notes', 'Town', 'Chat', 'Settings'])).toEqual([
      'Forecast', 'Sales data', 'Notes', 'Town', 'Chat',
    ]);
    expect(screen.getByLabelText('Location sections')).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'Forecast' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByText('This page is being built.')).toBeTruthy();
    await fireEvent.press(within(tabs).getByRole('link', { name: 'Sales data' }));
    expect(router.getPathname()).toBe('/locations/l1/sales');
    expect(within(screen.getByLabelText('Location sections')).getByRole('link', { name: 'Sales data' }).props.accessibilityState)
      .toMatchObject({ selected: true });
  });

  test('org admins get the Settings tab; the switcher opens the same tab of another location', async () => {
    const { router } = await renderApp('/locations/l1/notes', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    const tabs = await screen.findByLabelText('Location sections');
    expect(within(tabs).getByRole('link', { name: 'Settings' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Location' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'River Grill' }));
    expect(router.getPathname()).toBe('/locations/l2/notes');
    expect(await screen.findByRole('heading', { name: 'River Grill' })).toBeTruthy();
    expect(screen.getByText('Norwich, VT')).toBeTruthy();
  });

  test('one location has no switcher', async () => {
    await renderApp('/locations/l1', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member', orgOf('member').locations.slice(0, 1)) }));
    await screen.findByRole('heading', { name: 'Main Street Bar' });
    expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
  });

  test('a location not in the organization is not available, with a way back', async () => {
    const { router } = await renderApp('/locations/l404', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
    expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
    // The nav and the way back both lead to Locations.
    const links = screen.getAllByRole('link', { name: 'Locations' });
    expect(links).toHaveLength(2);
    const back = links[1];
    if (back === undefined) throw new Error('no way back');
    await fireEvent.press(back);
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
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/admin/view-as/end', body: {} }]);
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

describe('placeholders (spec 16.1)', () => {
  test.each<[string, string, MeResponse]>([
    ['/locations/new', 'Add location', meOf(ACCESS.admin)],
    ['/team', 'Team', meOf(ACCESS.admin)],
    ['/settings', 'Settings', meOf(ACCESS.member)],
  ])('%s: its title and one line, in the client app frame', async (path, title, me) => {
    const { router } = await renderApp(path, fakePortalApi({ me, org: orgOf('org_admin') }));
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText('This page is being built.')).toBeTruthy();
    expect(screen.getByLabelText('Main')).toBeTruthy();
    expect(router.getPathname()).toBe(path);
  });

  test.each<[string, string]>([
    ['/locations/l1', 'Forecast'],
    ['/locations/l1/sales', 'Sales data'],
    ['/locations/l1/sales/upload', 'Upload sales history'],
    ['/locations/l1/notes', 'Notes'],
    ['/locations/l1/town', 'Town'],
    ['/locations/l1/settings', 'Location settings'],
  ])('%s: its title and one line, under the location header and tabs', async (path, title) => {
    const { router } = await renderApp(path, fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') }));
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Main Street Bar' })).toBeTruthy();
    expect(screen.getByText('This page is being built.')).toBeTruthy();
    expect(router.getPathname()).toBe(path);
  });
});
