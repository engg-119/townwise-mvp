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

import { formatDate } from '../../../src/portal/format';
import type { MemberView } from '../../../src/portal/team/api';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { CHEF, MANAGER, noContent, PARTNER, TEAM, withRoutes, YOU, type Routes } from './fixtures';

const WINDOW = Dimensions.get('window');

afterEach(async () => {
  await cleanup();
});

function adminApi(members: MemberView[] | (() => unknown) = TEAM): { api: FakePortalApi; routes: Routes } {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
  const routes = withRoutes(api, { gets: { '/api/org/members': typeof members === 'function' ? members : () => ({ members }) } });
  return { api, routes };
}

function table() {
  return screen.getByLabelText('Team members and invited addresses');
}

describe('P17 Team: the page and its states', () => {
  test('the header, the lead, the add form and how joining works', async () => {
    const { api } = adminApi();
    await renderApp('/team', api);
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeTruthy();
    expect(screen.getByText(
      'Each person signs in with “Continue with Google” using the exact address you add here. Townwise accepts Gmail addresses '
      + 'and Google Workspace accounts. We don’t send invitations yet, so let them know yourself.',
    )).toBeTruthy();
    expect(screen.getAllByText('Test Group').length).toBeGreaterThan(1);
    expect(screen.getByText(
      'An address you add works the first time that person continues with Google. They join Test Group with the role you pick, '
      + 'with nothing to accept and no approval step.',
    )).toBeTruthy();
    expect(screen.getByLabelText('Email addresses')).toBeTruthy();
    expect(screen.getByText('One per line or separated by commas, up to 20.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Role' }).props.accessibilityValue).toEqual({ text: 'Member' });
    expect(screen.getByRole('heading', { name: 'After you add someone' })).toBeTruthy();
    expect(screen.getByText('Townwise doesn’t email invitations. Send them townwise.tech and the address you added.')).toBeTruthy();
    // The page's one primary.
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });

  test('loading shows one line in place of the list, and the add form is already there', async () => {
    const answer = deferred<unknown>();
    const { api } = adminApi(() => answer.promise);
    await renderApp('/team', api);
    expect(await screen.findByText('Loading your team')).toBeTruthy();
    expect(screen.getByLabelText('Email addresses')).toBeTruthy();
    await act(async () => { answer.resolve({ members: TEAM }); await answer.promise; });
    expect(await screen.findByText('manager@example.com')).toBeTruthy();
    expect(screen.queryByText('Loading your team')).toBeNull();
  });

  test('the table: email with You or Added by Townwise staff, role, status, since, and the row actions', async () => {
    const { api } = adminApi();
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    const rows = within(table());
    for (const text of [EMAIL, 'You', 'manager@example.com', 'Added by Townwise staff', 'chef@example.com', 'partner@example.com']) {
      expect(rows.getByText(text)).toBeTruthy();
    }
    expect(rows.getAllByText('Admin')).toHaveLength(2);
    expect(rows.getAllByText('Member')).toHaveLength(2);
    expect(rows.getAllByText('Active')).toHaveLength(3);
    expect(rows.getAllByText('Invited')).toHaveLength(1);
    expect(rows.getByText(`Joined ${formatDate(YOU.joinedAt ?? '')}`)).toBeTruthy();
    expect(rows.getByText(`Invited ${formatDate(CHEF.invitedAt)}`)).toBeTruthy();
    // Members get Make admin, admins Make member; seats get Remove, invitations Remove invitation.
    expect(rows.getByRole('button', { name: 'Make admin, manager@example.com' })).toBeTruthy();
    expect(rows.getByRole('button', { name: 'Remove, manager@example.com' })).toBeTruthy();
    expect(rows.getByRole('button', { name: 'Make admin, chef@example.com' })).toBeTruthy();
    expect(rows.getByRole('button', { name: 'Remove invitation, chef@example.com' })).toBeTruthy();
    expect(rows.getByRole('button', { name: 'Make member, partner@example.com' })).toBeTruthy();
    // Your own row has no actions: you leave from Settings.
    expect(rows.queryByRole('button', { name: `Make member, ${EMAIL}` })).toBeNull();
    expect(rows.queryByRole('button', { name: `Remove, ${EMAIL}` })).toBeNull();
    expect(writes(api)).toEqual([]);
  });

  test('empty: only you so far, in place of the list', async () => {
    const { api } = adminApi([YOU]);
    await renderApp('/team', api);
    expect(await screen.findByText(
      'It’s just you so far. Add your teammates’ email addresses, and they can join the next time they continue with Google.',
    )).toBeTruthy();
    expect(screen.queryByLabelText('Team members and invited addresses')).toBeNull();
  });

  test('a list that can’t load shows the shared copy with Try again, which loads it', async () => {
    let answer: unknown = offline();
    const { api } = adminApi(() => answer);
    await renderApp('/team', api);
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    answer = { members: TEAM };
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('manager@example.com')).toBeTruthy();
    expect(api.calls.filter((call) => call.path === '/api/org/members')).toHaveLength(2);
  });

  test('at 320px the table stacks into label and value pairs, actions included', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 320 });
    try {
      const { api } = adminApi();
      await renderApp('/team', api);
      await screen.findByText('manager@example.com');
      const rows = within(table());
      expect(rows.getAllByText('Email')).toHaveLength(4);
      // Your row has no actions, so it has no Actions pair.
      expect(rows.getAllByText('Actions')).toHaveLength(3);
      expect(rows.getByRole('button', { name: 'Remove, manager@example.com' })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('P17 Team: adding addresses (F5)', () => {
  test('one line per address, the team updated in place, and the invalid ones left in the field', async () => {
    const { api } = adminApi([YOU, MANAGER, CHEF]);
    const server: MemberView = { ...CHEF, id: 'm5', email: 'server@example.com' };
    api.answers['/api/org/members'] = () => ({
      results: [
        { email: 'server@example.com', outcome: 'invited' },
        { email: 'chef@example.com', outcome: 'already_invited' },
        { email: 'manager@example.com', outcome: 'already_member' },
        { email: 'bartender.example.com', outcome: 'invalid' },
      ],
      members: [YOU, MANAGER, CHEF, server],
    });
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.changeText(
      screen.getByLabelText('Email addresses'),
      'server@example.com\nchef@example.com, Manager@example.com\n\nbartender.example.com\nserver@example.com',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    const results = await screen.findByLabelText('Results of adding addresses');
    for (const line of [
      'Added. They can join the next time they continue with Google.', 'Already invited.', 'Already on your team.',
      'That isn’t an email address.',
    ]) {
      expect(within(results).getByText(line)).toBeTruthy();
    }
    expect(within(results).getByText('bartender.example.com')).toBeTruthy();
    // Repeats are dropped before sending; the server normalizes the rest. Member is the default role.
    expect(writes(api)).toEqual([{
      method: 'POST', path: '/api/org/members',
      body: { emails: ['server@example.com', 'chef@example.com', 'Manager@example.com', 'bartender.example.com'], role: 'member' },
    }]);
    expect(within(table()).getByText('server@example.com')).toBeTruthy();
    expect(screen.getByLabelText('Email addresses').props.value).toBe('bartender.example.com');
  });

  test('the role picked applies to everyone added at once', async () => {
    const { api } = adminApi([YOU]);
    api.answers['/api/org/members'] = () => ({
      results: [{ email: 'partner@example.com', outcome: 'invited' }],
      members: [YOU, { ...PARTNER, status: 'invited', joinedAt: null }],
    });
    await renderApp('/team', api);
    await screen.findByText('It’s just you so far. Add your teammates’ email addresses, and they can join the next time they continue with Google.');
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), 'partner@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Role' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Admin' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByLabelText('Team members and invited addresses')).toBeTruthy();
    expect(writes(api)[0]?.body).toEqual({ emails: ['partner@example.com'], role: 'org_admin' });
    expect(screen.getByLabelText('Email addresses').props.value).toBe('');
  });

  test('nothing to add, or more than 20, stops in the form with nothing sent', async () => {
    const { api } = adminApi();
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter at least one email address.')).toBeTruthy();
    const many = Array.from({ length: 21 }, (_, index) => `cook${String(index)}@example.com`).join('\n');
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), many);
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Add up to 20 addresses at a time.')).toBeTruthy();
    expect(writes(api)).toEqual([]);
  });

  test('an entry over 320 characters stops in the form with nothing sent; one of exactly 320 goes', async () => {
    const { api } = adminApi();
    api.answers['/api/org/members'] = () => ({ results: [{ email: 'cook@example.com', outcome: 'invited' }], members: TEAM });
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), `cook@example.com\n${'x'.repeat(309)}@example.com`);
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Each address can be up to 320 characters.')).toBeTruthy();
    expect(writes(api)).toEqual([]);
    const edge = `${'x'.repeat(308)}@example.com`;
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), `cook@example.com\n${edge}`);
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByLabelText('Results of adding addresses')).toBeTruthy();
    expect(screen.queryByText('Each address can be up to 320 characters.')).toBeNull();
    expect(writes(api)[0]?.body).toEqual({ emails: ['cook@example.com', edge], role: 'member' });
  });

  // The role change and the removal are toasts, which leave by themselves (D55): an Add shows neither a second time.
  test('a successful Add shows the last role change or removal toast no second time', async () => {
    const { api, routes } = adminApi();
    api.answers['/api/org/members/m2'] = () => ({ member: { ...MANAGER, role: 'org_admin' } });
    routes.requests['DELETE /api/org/members/m3'] = noContent;
    api.answers['/api/org/members'] = () => ({ results: [{ email: 'cook@example.com', outcome: 'invited' }], members: TEAM });
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Make admin, manager@example.com' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), 'cook@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByLabelText('Results of adding addresses')).toBeTruthy();
    expect(screen.getAllByText('Saved.')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Remove invitation, chef@example.com' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove invitation' }));
    expect(await screen.findByText('Removed the invitation for chef@example.com.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), 'cook@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByLabelText('Results of adding addresses')).toBeTruthy();
    expect(screen.getAllByText('Removed the invitation for chef@example.com.')).toHaveLength(1);
    expect(screen.getAllByTestId('toast')).toHaveLength(2);
  });

  test('the member cap: 409 member_limit says the team is full', async () => {
    const { api } = adminApi();
    api.answers['/api/org/members'] = () => refusal(409, 'member_limit');
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), 'cook@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Your organization has reached 200 people.')).toBeTruthy();
    expect(screen.queryByLabelText('Results of adding addresses')).toBeNull();
    // The address stays to try later.
    expect(screen.getByLabelText('Email addresses').props.value).toBe('cook@example.com');
  });

  test('any other refusal gets the shared copy, and Try again sends it again', async () => {
    const { api } = adminApi();
    api.answers['/api/org/members'] = () => refusal(429, 'rate_limited', 120);
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.changeText(screen.getByLabelText('Email addresses'), 'cook@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
    api.answers['/api/org/members'] = () => ({ results: [{ email: 'cook@example.com', outcome: 'invited' }], members: TEAM });
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Added. They can join the next time they continue with Google.')).toBeTruthy();
    expect(writes(api)).toHaveLength(2);
  });
});

describe('P17 Team: roles and removal (F6)', () => {
  test('Make admin saves and the row turns into Make member', async () => {
    const { api } = adminApi();
    api.answers['/api/org/members/m2'] = (body) => ({ member: { ...MANAGER, role: (body as { role: string }).role } });
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Make admin, manager@example.com' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'PATCH', path: '/api/org/members/m2', body: { role: 'org_admin' } }]);
    expect(within(table()).getByRole('button', { name: 'Make member, manager@example.com' })).toBeTruthy();
    expect(within(table()).getAllByText('Admin')).toHaveLength(3);
  });

  test('the last admin: 409 last_admin keeps the role and says why', async () => {
    const { api } = adminApi();
    api.answers['/api/org/members/m4'] = () => refusal(409, 'last_admin');
    await renderApp('/team', api);
    await screen.findByText('partner@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Make member, partner@example.com' }));
    expect(await screen.findByText('Your organization needs at least one admin. Make someone else an admin first.')).toBeTruthy();
    expect(within(table()).getByRole('button', { name: 'Make member, partner@example.com' })).toBeTruthy();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  test('a row someone else removed (404) leaves the table and says it isn’t available', async () => {
    const { api } = adminApi();
    api.answers['/api/org/members/m3'] = () => refusal(404, 'not_found');
    await renderApp('/team', api);
    await screen.findByText('chef@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Make admin, chef@example.com' }));
    expect(await screen.findByText('This team member isn’t available.')).toBeTruthy();
    expect(within(table()).queryByText('chef@example.com')).toBeNull();
  });

  test('a role change that can’t reach Townwise offers Try again', async () => {
    const { api } = adminApi();
    let answer: unknown = offline();
    api.answers['/api/org/members/m2'] = () => answer;
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Make admin, manager@example.com' }));
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    answer = { member: { ...MANAGER, role: 'org_admin' } };
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(writes(api).map((call) => call.body)).toEqual([{ role: 'org_admin' }, { role: 'org_admin' }]);
  });

  test('Remove asks first; Cancel sends nothing; Remove removes the row and says so', async () => {
    const { api, routes } = adminApi();
    routes.requests['DELETE /api/org/members/m2'] = noContent;
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove, manager@example.com' }));
    expect(screen.getByRole('heading', { name: 'Remove manager@example.com?' })).toBeTruthy();
    expect(screen.getByText('They lose access on their next visit. Their notes and uploads stay.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Remove manager@example.com?' })).toBeNull();
    expect(writes(api)).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Remove, manager@example.com' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed manager@example.com. They lose access on their next visit.')).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'DELETE', path: '/api/org/members/m2', body: undefined }]);
    expect(within(table()).queryByText('manager@example.com')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Remove manager@example.com?' })).toBeNull();
  });

  test('Remove invitation has its own question and line', async () => {
    const { api, routes } = adminApi();
    routes.requests['DELETE /api/org/members/m3'] = noContent;
    await renderApp('/team', api);
    await screen.findByText('chef@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove invitation, chef@example.com' }));
    expect(screen.getByRole('heading', { name: 'Remove the invitation for chef@example.com?' })).toBeTruthy();
    expect(screen.getByText('That address no longer joins Test Group when it continues with Google. You can add it again later.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove invitation' }));
    expect(await screen.findByText('Removed the invitation for chef@example.com.')).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'DELETE', path: '/api/org/members/m3', body: undefined }]);
  });

  test('while a removal runs, another Remove does not open a second dialog', async () => {
    const { api, routes } = adminApi();
    const gate = deferred<Response>();
    routes.requests['DELETE /api/org/members/m2'] = () => gate.promise;
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove, manager@example.com' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('Removing…');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove invitation, chef@example.com' }));
    expect(screen.getByRole('heading', { name: 'Remove manager@example.com?' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Remove the invitation for chef@example.com?' })).toBeNull();
    await act(async () => { gate.resolve(noContent()); await gate.promise; });
    expect(await screen.findByText('Removed manager@example.com. They lose access on their next visit.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Remove the invitation for chef@example.com?' })).toBeNull();
    expect(writes(api)).toHaveLength(1);
  });

  test('removing the last admin: 409 last_admin closes the dialog, keeps the row and says why', async () => {
    const { api, routes } = adminApi();
    routes.requests['DELETE /api/org/members/m4'] = () => refusal(409, 'last_admin');
    await renderApp('/team', api);
    await screen.findByText('partner@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove, partner@example.com' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Your organization needs at least one admin. Make someone else an admin first.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Remove partner@example.com?' })).toBeNull();
    expect(within(table()).getByText('partner@example.com')).toBeTruthy();
  });

  test('a removal that can’t reach Townwise stays in the dialog with the shared copy', async () => {
    const { api, routes } = adminApi();
    routes.requests['DELETE /api/org/members/m2'] = () => offline();
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Remove, manager@example.com' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Remove manager@example.com?' })).toBeTruthy();
    routes.requests['DELETE /api/org/members/m2'] = noContent;
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed manager@example.com. They lose access on their next visit.')).toBeTruthy();
  });
});

describe('P17 Team: who sees it (spec 3, 15.5)', () => {
  test('members never see Team: /team opens Locations', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
    withRoutes(api, { gets: { '/api/org/members': () => refusal(403, 'forbidden') } });
    const { router } = await renderApp('/team', api);
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
    expect(api.calls.some((call) => call.path === '/api/org/members')).toBe(false);
  });

  test('view-as of an org admin: readable, with every write disabled and the read-only line', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
    withRoutes(api, { gets: { '/api/org/members': () => ({ members: TEAM }) } });
    await renderApp('/team', api);
    await screen.findByText('manager@example.com');
    expect(screen.getByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    expect(screen.getByLabelText('Email addresses').props.editable).toBe(false);
    for (const name of ['Add', 'Make admin, manager@example.com', 'Remove, manager@example.com', 'Remove invitation, chef@example.com']) {
      const control = screen.getByRole('button', { name });
      expect(control.props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(control);
    }
    expect(screen.queryByRole('heading', { name: 'Remove manager@example.com?' })).toBeNull();
    expect(writes(api)).toEqual([]);
  });

  test('view-as of a member: no Team, as for the member', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.member), org: orgOf('member') });
    const { router } = await renderApp('/team', api);
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
  });
});
