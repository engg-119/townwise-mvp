jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions } from 'react-native';
import { act, cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { formatDate, formatTime } from '../../../src/portal/format';
import type { StaffActivity } from '../../../src/portal/settings/api';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, STAFF_EMAIL, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { ADD_EVENT, noContent, REFUSED_EVENT, VIEW_AS_EVENT, withRoutes, type Routes } from '../team/fixtures';

const WINDOW = Dimensions.get('window');

afterEach(async () => {
  await cleanup();
});

const EVENTS = [VIEW_AS_EVENT, ADD_EVENT, REFUSED_EVENT];

function adminApi(events: StaffActivity[] | (() => unknown) = EVENTS): { api: FakePortalApi; routes: Routes } {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
  const routes = withRoutes(api, {
    gets: { '/api/org/staff-activity': typeof events === 'function' ? events : () => ({ events }) },
  });
  return { api, routes };
}

function memberApi(): { api: FakePortalApi; routes: Routes } {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  return { api, routes: withRoutes(api) };
}

/** The page's own Sign out (the top bar has the other). */
function pageSignOut() {
  const buttons = screen.getAllByRole('button', { name: 'Sign out' });
  expect(buttons).toHaveLength(2);
  const last = buttons.at(-1);
  if (last === undefined) throw new Error('no Sign out');
  return last;
}

describe('P18 Settings: a member', () => {
  test('the account, two-step sign-in, Leave and Sign out; no name form and no staff activity', async () => {
    const { api } = memberApi();
    const { router } = await renderApp('/settings', api);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your account' })).toBeTruthy();
    for (const text of ['Email', 'Organization', 'Role', 'Member']) expect(screen.getByText(text)).toBeTruthy();
    // The account's email, and the top bar's.
    expect(screen.getAllByText(EMAIL)).toHaveLength(2);
    expect(screen.getByText('Recommended for admins.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Organization name' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Townwise staff activity' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave Test Group' })).toBeTruthy();
    expect(screen.getByText(`Sign out on every device ends every Townwise sign-in for ${EMAIL} right away, this one included.`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out on every device' })).toBeTruthy();
    // Members read no staff activity (spec 3).
    expect(api.calls.some((call) => call.path === '/api/org/staff-activity')).toBe(false);
    await fireEvent.press(screen.getByRole('link', { name: 'Two-step sign-in settings' }));
    expect(router.getPathname()).toBe('/settings/security');
  });

  test('Leave asks first, then routes through the new access to No access', async () => {
    const { api } = memberApi();
    api.answers['/api/org/leave'] = () => meOf({ ...ACCESS.removed, org: { name: 'Test Group' }, byYou: true });
    const { router } = await renderApp('/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave Test Group' }));
    expect(screen.getByRole('heading', { name: 'Leave Test Group?' })).toBeTruthy();
    expect(screen.getByText('You lose access right away. Your notes and uploads stay with Test Group.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(writes(api)).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Leave Test Group' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/no-access'); });
    expect(await screen.findByRole('heading', { name: 'You left Test Group' })).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/org/leave', body: {} }]);
  });

  test('a leave that can’t reach Townwise stays in the dialog with the shared copy', async () => {
    const { api } = memberApi();
    api.answers['/api/org/leave'] = () => offline();
    const { router } = await renderApp('/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave Test Group' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Leave Test Group?' })).toBeTruthy();
    expect(router.getPathname()).toBe('/settings');
  });

  test('Sign out signs this device out', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    await renderApp('/settings', memberApi().api, { signOut });
    await screen.findByRole('heading', { name: 'Your account' });
    await fireEvent.press(pageSignOut());
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test('Sign out on every device calls the kit’s logout-all, then signs this device out', async () => {
    const { api, routes } = memberApi();
    const order: string[] = [];
    routes.requests['POST /auth/logout-all'] = () => { order.push('logout-all'); return noContent(); };
    const signOut = jest.fn(() => { order.push('sign-out'); return Promise.resolve(); });
    await renderApp('/settings', api, { signOut });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out on every device' }));
    await waitFor(() => { expect(order).toEqual(['logout-all', 'sign-out']); });
    expect(writes(api)).toEqual([{ method: 'POST', path: '/auth/logout-all', body: undefined }]);
  });

  test('Sign out on every device that can’t reach Townwise says so and keeps this session', async () => {
    const { api, routes } = memberApi();
    routes.requests['POST /auth/logout-all'] = () => offline();
    const signOut = jest.fn(() => Promise.resolve());
    await renderApp('/settings', api, { signOut });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out on every device' }));
    expect(await screen.findByText('Couldn’t sign out. Check your connection and try again.')).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
    routes.requests['POST /auth/logout-all'] = () => refusal(503, null);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  test('after logout-all, a local sign-out that fails still shows signed out', async () => {
    const { api, routes } = memberApi();
    routes.requests['POST /auth/logout-all'] = noContent;
    const { auth, router } = await renderApp('/settings', api, { signOut: () => Promise.reject(offline()) });
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out on every device' }));
    await waitFor(() => { expect(auth.store.getState()).toEqual({ status: 'signedOut' }); });
    await waitFor(() => { expect(router.getPathname()).toBe('/sign-in'); });
  });
});

describe('P18 Settings: an org admin', () => {
  test('loading shows one line until the staff activity answers', async () => {
    const answer = deferred<unknown>();
    const { api } = adminApi(() => answer.promise);
    await renderApp('/settings', api);
    expect(await screen.findByText('Loading your settings')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your account' })).toBeNull();
    await act(async () => { answer.resolve({ events: [] }); await answer.promise; });
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeTruthy();
  });

  test('a staff activity read that fails shows the shared copy with Try again, which loads the page', async () => {
    let answer: unknown = offline();
    const { api } = adminApi(() => answer);
    await renderApp('/settings', api);
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    answer = { events: EVENTS };
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Townwise staff activity on Test Group')).toBeTruthy();
  });

  test('the account says Admin; the name form and the side help are there', async () => {
    const { api } = adminApi();
    const { router } = await renderApp('/settings', api);
    expect(await screen.findByRole('heading', { name: 'Organization name' })).toBeTruthy();
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.getByLabelText('Name').props.value).toBe('Test Group');
    expect(screen.getByText('Your team sees this name at the top of every page. Townwise staff see it in the staff console.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save name' })).toBeTruthy();
    expect(screen.getByText(/Rename one or change its town on that location’s Settings tab\./)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Locations' });
    expect(links).toHaveLength(2);
    await fireEvent.press(links[1] ?? links[0] ?? screen.getByText('Locations'));
    expect(router.getPathname()).toBe('/dashboard');
  });

  test('staff activity: when, the staff email, the server’s summary, and reason and until for view-as', async () => {
    const { api } = adminApi();
    await renderApp('/settings', api);
    const activity = within(await screen.findByLabelText('Townwise staff activity on Test Group'));
    expect(screen.getByText(/^Each time Townwise staff use View as to see your sales and notes, it’s recorded here with its reason\./)).toBeTruthy();
    expect(activity.getAllByText('Townwise staff (staff@example.com)')).toHaveLength(3);
    expect(activity.getByText(`${formatDate(VIEW_AS_EVENT.at)}, ${formatTime(VIEW_AS_EVENT.at)}`)).toBeTruthy();
    expect(activity.getByText('Started viewing as owner@example.com')).toBeTruthy();
    expect(activity.getByText('Checking an upload question.')).toBeTruthy();
    expect(activity.getByText(formatTime(VIEW_AS_EVENT.viewAs?.endsAt ?? ''))).toBeTruthy();
    expect(activity.getByText('Added manager@example.com as member')).toBeTruthy();
    // A staff change the server refused says so.
    expect(activity.getByText('Changed owner@example.com from admin to member')).toBeTruthy();
    expect(activity.getAllByText('Didn’t take effect.')).toHaveLength(1);
    expect(activity.getByText('The organization needs at least one admin.')).toBeTruthy();
    // Shown once: the refused action has no second row.
    expect(activity.getAllByText('Changed owner@example.com from admin to member')).toHaveLength(1);
    expect(api.calls.filter((call) => call.path === '/api/org/staff-activity')).toHaveLength(1);
  });

  test('no staff activity: one line in place of the table', async () => {
    const { api } = adminApi([]);
    await renderApp('/settings', api);
    expect(await screen.findByText('Townwise staff haven’t viewed or changed your organization.')).toBeTruthy();
    expect(screen.queryByLabelText('Townwise staff activity on Test Group')).toBeNull();
  });

  test('Save name checks the length, saves the trimmed name, says Saved. and reads the access again', async () => {
    const { api } = adminApi();
    const renamed = { id: 'o1', name: 'Harbor Group' };
    api.answers['/api/org'] = (body) => {
      api.me = meOf({ ...ACCESS.admin, org: renamed });
      return { org: { ...renamed, name: (body as { name: string }).name } };
    };
    await renderApp('/settings', api);
    const field = await screen.findByLabelText('Name');
    await fireEvent.changeText(field, ' S ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByText('Use 2 to 120 characters.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Name'), 'x'.repeat(121));
    await fireEvent.press(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByText('Use 2 to 120 characters.')).toBeTruthy();
    expect(writes(api)).toEqual([]);
    const reads = api.calls.filter((call) => call.path === '/api/me').length;
    await fireEvent.changeText(screen.getByLabelText('Name'), '  Harbor Group  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByText('Use 2 to 120 characters.')).toBeNull();
    expect(writes(api)).toEqual([{ method: 'PATCH', path: '/api/org', body: { name: 'Harbor Group' } }]);
    // The top bar, the eyebrow and the account read the new name from GET /api/me.
    await waitFor(() => { expect(screen.queryByText('Test Group')).toBeNull(); });
    expect(screen.getAllByText('Harbor Group').length).toBeGreaterThanOrEqual(3);
    expect(api.calls.filter((call) => call.path === '/api/me').length).toBe(reads + 1);
    // Editing again clears the notice.
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Harbor Group 2');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  test('a save Townwise refuses shows the shared copy, and Try again saves', async () => {
    const { api } = adminApi();
    api.answers['/api/org'] = () => refusal(503, 'unavailable');
    await renderApp('/settings', api);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Harbor Group');
    await fireEvent.press(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
    api.answers['/api/org'] = () => ({ org: { id: 'o1', name: 'Harbor Group' } });
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(writes(api)).toHaveLength(2);
  });

  test('the only admin can’t leave: 409 last_admin closes the dialog, says why, and links to Team', async () => {
    const { api } = adminApi();
    api.answers['/api/org/leave'] = () => refusal(409, 'last_admin');
    const { router } = await renderApp('/settings', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave Test Group' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Your organization needs at least one admin. Make someone else an admin first.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Leave Test Group?' })).toBeNull();
    expect(router.getPathname()).toBe('/settings');
    // Asking again clears the line.
    await fireEvent.press(screen.getByRole('button', { name: 'Leave Test Group' }));
    expect(screen.queryByText('Your organization needs at least one admin. Make someone else an admin first.')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Leave' }));
    await fireEvent.press(await screen.findByRole('link', { name: 'Go to Team' }));
    expect(router.getPathname()).toBe('/team');
  });

  test('at 320px the staff activity stacks into label and value pairs', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 320 });
    try {
      const { api } = adminApi();
      await renderApp('/settings', api);
      const activity = within(await screen.findByLabelText('Townwise staff activity on Test Group'));
      expect(activity.getAllByText('When')).toHaveLength(3);
      // Reason and Until show only on the view-as row.
      expect(activity.getAllByText('Reason')).toHaveLength(1);
      // The top bar hides the email at this width; the account keeps it.
      expect(screen.getAllByText(EMAIL)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('P18 Settings: view-as (spec 15.5)', () => {
  test('the target’s page, readable, with every write disabled and one read-only line', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
    withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: EVENTS }) } });
    const signOut = jest.fn(() => Promise.resolve());
    const { router } = await renderApp('/settings', api, { signOut });
    expect(await screen.findByLabelText('Townwise staff activity on Test Group')).toBeTruthy();
    expect(screen.getAllByText('Read-only while viewing as gm@example.org.')).toHaveLength(1);
    // The account is the target's; the top bar names the staff member.
    expect(screen.getByText('gm@example.org')).toBeTruthy();
    expect(screen.getByText(STAFF_EMAIL)).toBeTruthy();
    expect(screen.getByLabelText('Name').props.editable).toBe(false);
    const controls = [
      screen.getByRole('button', { name: 'Save name' }),
      screen.getByRole('button', { name: 'Two-step sign-in settings' }),
      screen.getByRole('button', { name: 'Leave Test Group' }),
      screen.getByRole('button', { name: 'Sign out on every device' }),
      ...screen.getAllByRole('button', { name: 'Sign out' }),
    ];
    for (const control of controls) {
      expect(control.props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(control);
    }
    expect(screen.queryByRole('heading', { name: 'Leave Test Group?' })).toBeNull();
    expect(writes(api)).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
    expect(router.getPathname()).toBe('/settings');
  });

  test('a member target: no name form and no staff activity, as for the member', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.member), org: orgOf('member') });
    withRoutes(api);
    await renderApp('/settings', api);
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeTruthy();
    expect(screen.getByText('Member')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Organization name' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Townwise staff activity' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave Test Group' }).props.accessibilityState).toMatchObject({ disabled: true });
  });
});
