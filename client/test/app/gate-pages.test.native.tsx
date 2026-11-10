jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { userEvent } from '@testing-library/react-native';
import { act, cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';
import { Dimensions, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import type { Access } from '../../src/portal/schemas';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, INVITE, LOCATIONS, meOf, offline, orgOf, REQUEST, refusal, SECOND_INVITE,
  STAFF_EMAIL, staffMe, viewAsMe, writes, type FakePortalApi,
} from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { theme } from '../../src/theme';

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

const ONE_LOCATION = orgOf('member', LOCATIONS.slice(0, 1));
const WINDOW = Dimensions.get('window');

type Element = ReturnType<typeof screen.getByText>;

function styleOf(element: Element): TextStyle & ViewStyle {
  return StyleSheet.flatten(element.props.style as TextStyle) as TextStyle & ViewStyle;
}

/** The nearest element around `element` that also holds what `find` finds. */
function around(element: Element, find: (scope: ReturnType<typeof within>) => Element | null): Element {
  let node = element.parent;
  while (node !== null && find(within(node)) === null) node = node.parent;
  if (node === null) throw new Error('nothing holds both');
  return node;
}

function atWidth(width: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width });
}

describe('P3 Request access', () => {
  /** What the page sent, without its one check whether the Google Places search is on (onboarding/places.ts). */
  function sent(api: FakePortalApi): ReturnType<typeof writes> {
    return writes(api).filter((call) => call.path !== '/api/places/autocomplete');
  }

  test('the form, its lead and side column, and a message for each field it can’t send', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    await renderApp('/request-access', api);
    expect(await screen.findByRole('heading', { name: 'Request access' })).toBeTruthy();
    expect(screen.getByText('Early access')).toBeTruthy();
    expect(screen.getByText('Townwise is in early access. Tell us about your restaurant or group, and someone on our team will review it by hand.')).toBeTruthy();
    expect(screen.getByText(`You don’t need to request access. Ask an admin on that team to add ${EMAIL}, then reload this page.`)).toBeTruthy();
    expect(screen.getByText('We’ll email you when you’re approved.')).toBeTruthy();
    expect(screen.getByText('Once you’re approved, you’ll upload your sales history and see your town.')).toBeTruthy();
    expect(screen.getByText(`Signed in as ${EMAIL}. Using the wrong Google account?`, { exact: false })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    for (const message of [
      'Enter your organization’s name.', 'Enter your name.', 'Enter your role.', 'Pick a town, or choose Another town.',
      'Enter a whole number from 1 to 50.',
    ]) {
      expect(screen.getByText(message)).toBeTruthy();
    }
    expect(sent(api)).toEqual([]);
  });

  test('Send request posts the answers and opens Waiting', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    const answer = deferred<unknown>();
    api.answers['/api/access-requests'] = () => answer.promise;
    const { router } = await renderApp('/request-access', api);
    await fireEvent.changeText(await screen.findByLabelText('Organization name'), '  Sample Mountain Tavern ');
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '3');
    await fireEvent.changeText(screen.getByLabelText('Anything we should know? (optional)'), 'Two bars and a cafe.');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    // Only Send changes while it sends.
    expect(screen.getByRole('button', { name: 'Sending…' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(sent(api)).toEqual([{
      method: 'POST', path: '/api/access-requests',
      body: { orgName: 'Sample Mountain Tavern', contactName: 'Pat', contactRole: 'Owner', town: { townId: 'stowe-vt' }, locationCount: 3, note: 'Two bars and a cafe.' },
    }]);
    await act(async () => { answer.resolve(meOf(ACCESS.pending)); await answer.promise; });
    await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
  });

  test('Another town reveals Town name and State, and checks the state', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    api.answers['/api/access-requests'] = () => meOf(ACCESS.pending);
    await renderApp('/request-access', api);
    expect(screen.queryByLabelText('Town name')).toBeNull();
    await fireEvent.press(await screen.findByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Another town' }));
    await fireEvent.changeText(screen.getByLabelText('Organization name'), 'Sample Diner');
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
    await fireEvent.changeText(screen.getByLabelText('Town name'), 'Norwich');
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    expect(screen.getByText('Choose a state.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('State'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Vermont' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(sent(api)).toHaveLength(1); });
    expect(sent(api)[0]?.body).toMatchObject({ town: { townId: null, name: 'Norwich', state: 'VT' } });
  });

  test('409 request_exists reads the access again and opens Waiting', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    api.answers['/api/access-requests'] = () => {
      api.me = meOf(ACCESS.pending);
      return refusal(409, 'request_exists');
    };
    const { router } = await renderApp('/request-access', api);
    await fillValid();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
  });

  test('429 and network errors use the shared copy, with Try again', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
    api.answers['/api/access-requests'] = () => refusal(429, 'rate_limited', 90);
    await renderApp('/request-access', api);
    await fillValid();
    await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
    api.answers['/api/access-requests'] = () => offline();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    expect(sent(api)).toHaveLength(2);
  });

  test('removed: the lead adds a line; rejected: the last answers are filled in', async () => {
    const removed = fakePortalApi({ me: meOf(ACCESS.removed) });
    await renderApp('/request-access', removed);
    expect(await screen.findByText(/Setting up a different organization\? Tell us about it below\.$/)).toBeTruthy();
    await cleanup();
    const rejected = fakePortalApi({ me: meOf(ACCESS.rejected) });
    await renderApp('/request-access', rejected);
    expect((await screen.findByLabelText('Organization name')).props.value).toBe(REQUEST.orgName);
    expect(screen.getByLabelText('Number of locations').props.value).toBe('3');
    expect(screen.getByLabelText('Town').props.accessibilityValue).toEqual({ text: 'Stowe, VT' });
  });

  test('view-as: the form is read-only, Send is disabled and nothing is sent', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.noOrg) });
    await renderApp('/request-access', api);
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    expect(screen.getByLabelText('Organization name').props.editable).toBe(false);
    const send = screen.getByRole('button', { name: 'Send request' });
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(send);
    expect(writes(api)).toEqual([]);
    // The page speaks to the target; the signed-in line names the staff member.
    expect(screen.getByText('You don’t need to request access. Ask an admin on that team to add gm@example.org, then reload this page.')).toBeTruthy();
    expect(screen.getByText(`Signed in as ${STAFF_EMAIL}. Using the wrong Google account?`, { exact: false })).toBeTruthy();
  });

  test('the join panel’s body is `small` in `text2` at every width', async () => {
    atWidth(375);
    await renderApp('/request-access', fakePortalApi({ me: meOf(ACCESS.noOrg) }));
    const body = await screen.findByText(`You don’t need to request access. Ask an admin on that team to add ${EMAIL}, then reload this page.`);
    expect(styleOf(body)).toMatchObject({ fontSize: 14, lineHeight: 20, fontWeight: 400, color: theme.color.text2 });
  });

  test.each([[375, 'column'], [768, 'row']] as const)('at %ipx, Town and Number of locations share a %s', async (width, direction) => {
    atWidth(width);
    await renderApp('/request-access', fakePortalApi({ me: meOf(ACCESS.noOrg) }));
    const count = await screen.findByLabelText('Number of locations');
    expect(styleOf(around(count, (scope) => scope.queryByLabelText('Town'))).flexDirection ?? 'column').toBe(direction);
  });

  test('field labels are `ui`, weight 500', async () => {
    await renderApp('/request-access', fakePortalApi({ me: meOf(ACCESS.noOrg) }));
    for (const label of ['Organization name', 'Your name', 'Number of locations']) {
      const text = (await screen.findAllByText(label)).find((node) => node.props.nativeID !== undefined) ?? screen.getAllByText(label)[0];
      if (text === undefined) throw new Error(label);
      expect(styleOf(text)).toMatchObject({ fontSize: 14, lineHeight: 20, fontWeight: 500, color: theme.color.white });
    }
  });

  async function fillValid(): Promise<void> {
    await fireEvent.changeText(await screen.findByLabelText('Organization name'), 'Sample Diner');
    await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
    await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
    await fireEvent.press(screen.getByLabelText('Town'));
    await fireEvent.press(screen.getByRole('radio', { name: 'Hanover, NH' }));
    await fireEvent.changeText(screen.getByLabelText('Number of locations'), '1');
  }
});

describe('P4 Waiting for approval', () => {
  test('what was sent, the hint, and the town’s public profile as text and a table', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.pending) });
    await renderApp('/waiting', api);
    expect(await screen.findByRole('heading', { name: 'Your request is in' })).toBeTruthy();
    expect(screen.getByText('Request sent Oct 2, 2026')).toBeTruthy();
    expect(screen.getByText('Someone on the Townwise team reviews every new organization by hand. We’ll email you when you’re approved.')).toBeTruthy();
    expect(screen.getByText('We’ll email you when you’re approved.')).toBeTruthy();
    for (const text of ['Sample Mountain Tavern', 'Pat', 'Owner', 'Stowe, VT', '3', 'Two bars and a cafe.']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(`Expecting to join a teammate’s organization instead? Ask their admin to add ${EMAIL}. The next time you open Townwise, you can join it with one press.`)).toBeTruthy();
    expect(screen.getByText('Once you’re approved, Townwise sets up Sample Mountain Tavern, with you as its admin and its first location in Stowe, VT. Then you upload your sales history and see your town.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'While you wait: Stowe, VT' })).toBeTruthy();
    expect(screen.getByText('Seasonal town')).toBeTruthy();
    expect(screen.getByText('Measured across Lamoille County, 2024.')).toBeTruthy();
    expect(screen.getByText('Busiest month: January. Quietest: May.')).toBeTruthy();
    // Native has no chart (D21): the summary, the table and where to see the chart.
    expect(screen.getByText('See the chart at townwise.tech.')).toBeTruthy();
    expect(screen.queryByLabelText('Numbers: Lamoille County and the Northeast, 2024')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /Show the numbers/ }));
    const table = screen.getByLabelText('Numbers: Lamoille County and the Northeast, 2024');
    expect(within(table).getByText('May')).toBeTruthy();
    expect(within(table).getByText('−15.9')).toBeTruthy();
  });

  test('the town’s biggest gap prints its index delta in mono', async () => {
    await renderApp('/waiting', fakePortalApi({ me: meOf(ACCESS.pending) }));
    expect(await screen.findByText(/biggest gap with the region in May, −15\.9 index points\.$/)).toBeTruthy();
    const delta = screen.getByText('−15.9');
    expect(styleOf(delta)).toMatchObject({ ...theme.type.mono, fontVariant: ['tabular-nums'] });
  });

  test('Check again: no change shows the still-waiting notice; an approval opens Locations', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.pending), org: orgOf('org_admin') });
    const { router } = await renderApp('/waiting', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Still waiting. Your organization will appear here once it’s approved.')).toBeTruthy();
    api.me = meOf(ACCESS.admin);
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
  });

  test('Check again offline: the shared copy with Try again, and the town profile stays', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.pending) });
    await renderApp('/waiting', api);
    api.me = offline();
    await fireEvent.press(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'While you wait: Stowe, VT' })).toBeTruthy();
  });

  test('a town outside the twelve gets the gap line and no chart', async () => {
    const access: Access = { state: 'pending', request: { ...REQUEST, town: { townId: null, name: 'Norwich', state: 'VT' } } };
    await renderApp('/waiting', fakePortalApi({ me: meOf(access) }));
    expect(await screen.findByText('Townwise hasn’t researched Norwich, VT yet. Profiles cover twelve Northeast towns today.')).toBeTruthy();
    expect(screen.queryByText('See the chart at townwise.tech.')).toBeNull();
  });

  test('view-as: Check again still reads; Sign out is disabled', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.pending) });
    await renderApp('/waiting', api);
    expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    const signOuts = screen.getAllByRole('button', { name: 'Sign out' });
    for (const button of signOuts) expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Still waiting. Your organization will appear here once it’s approved.')).toBeTruthy();
  });
});

describe('P5 No access', () => {
  test('rejected, with the team’s message and Send a new request', async () => {
    const { router } = await renderApp('/no-access', fakePortalApi({ me: meOf(ACCESS.rejected) }));
    expect(await screen.findByRole('heading', { name: 'We can’t give you access yet' })).toBeTruthy();
    expect(screen.getByText('We reviewed your request for Sample Mountain Tavern on Oct 5, 2026 and didn’t approve it.')).toBeTruthy();
    expect(screen.getByText('Message from the Townwise team: “We need a website first.”')).toBeTruthy();
    expect(screen.getByText('If something has changed, you can send a new request.')).toBeTruthy();
    expect(screen.getByText(`Signed in as ${EMAIL}. Using the wrong Google account?`, { exact: false })).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'Send a new request' }));
    expect(router.getPathname()).toBe('/request-access');
  });

  test('rejected: the lead is `text2` and Questions is `small` at every width', async () => {
    atWidth(375);
    await renderApp('/no-access', fakePortalApi({ me: meOf(ACCESS.rejected) }));
    const lead = await screen.findByText('We reviewed your request for Sample Mountain Tavern on Oct 5, 2026 and didn’t approve it.');
    expect(styleOf(lead).color).toBe(theme.color.text2);
    const questions = screen.getByText(/^Questions: /);
    expect(styleOf(questions)).toMatchObject({ fontSize: 14, lineHeight: 20, color: theme.color.text2 });
  });

  test('rejected with no message says nothing about one', async () => {
    const access: Access = { state: 'rejected', request: { ...REQUEST, status: 'rejected', decidedAt: '2026-10-05T15:00:00.000Z', decisionMessage: null } };
    await renderApp('/no-access', fakePortalApi({ me: meOf(access) }));
    expect(await screen.findByRole('heading', { name: 'We can’t give you access yet' })).toBeTruthy();
    expect(screen.queryByText(/Message from the Townwise team/)).toBeNull();
  });

  test('removed, and left', async () => {
    await renderApp('/no-access', fakePortalApi({ me: meOf(ACCESS.removed) }));
    expect(await screen.findByRole('heading', { name: 'You no longer have access to Sample Restaurant Group' })).toBeTruthy();
    expect(screen.getByText(`${EMAIL} isn’t on Sample Restaurant Group’s team anymore. If that’s a mistake, ask an admin there to add you again.`)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Request access for a different organization' })).toBeTruthy();
    await cleanup();
    await renderApp('/no-access', fakePortalApi({ me: meOf({ ...ACCESS.removed, byYou: true }) }));
    expect(await screen.findByRole('heading', { name: 'You left Sample Restaurant Group' })).toBeTruthy();
    expect(screen.getByText(`If you left by mistake, ask an admin there to add ${EMAIL} again.`)).toBeTruthy();
  });

  test('paused, with no way to request access', async () => {
    await renderApp('/no-access', fakePortalApi({ me: meOf(ACCESS.suspended) }));
    expect(await screen.findByRole('heading', { name: 'Access to Sample Restaurant Group is paused' })).toBeTruthy();
    expect(screen.getByText(/The Townwise team has paused access for Sample Restaurant Group\. Your organization’s data is kept\./)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /request/i })).toBeNull();
  });

  test('Sign out in the signed-in line signs out', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    await renderApp('/no-access', fakePortalApi({ me: meOf(ACCESS.removed) }), { signOut });
    await fireEvent.press(await screen.findByRole('link', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe('P6 Joining', () => {
  test('one invitation and no pending request: joins at once and opens Locations with the notice naming who added them', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.invited), org: ONE_LOCATION });
    const answer = deferred<unknown>();
    api.answers['/api/me/join'] = () => answer.promise;
    const { router } = await renderApp('/joining', api);
    expect(await screen.findByRole('heading', { name: 'Joining Sample Restaurant Group…' })).toBeTruthy();
    expect(screen.getByText(`owner@example.com added ${EMAIL}.`)).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/me/join', body: { inviteId: 'i1' } }]);
    await act(async () => { answer.resolve(meOf(ACCESS.member)); await answer.promise; });
    // One location: Locations opens its Forecast tab and keeps the notice.
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1'); });
    expect(await screen.findByText(`You joined Test Group. owner@example.com added ${EMAIL}. Not your team?`, { exact: false })).toBeTruthy();
    expect(writes(api)).toHaveLength(1);
    await fireEvent.press(screen.getByText('Leave Test Group'));
    expect(router.getPathname()).toBe('/settings');
    // Shown once.
    await fireEvent.press(screen.getByRole('link', { name: 'Home' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1'); });
    expect(screen.queryByText(/You joined Test Group/)).toBeNull();
  });

  test('with a pending request, nothing joins until Join; Not my team keeps the request and returns to Waiting', async () => {
    const access: Access = { state: 'invited', invitations: [INVITE], pendingRequest: REQUEST };
    const api = fakePortalApi({ me: meOf(access) });
    api.answers['/api/me/decline'] = () => meOf(ACCESS.pending);
    const { router } = await renderApp('/joining', api);
    expect(await screen.findByRole('heading', { name: 'Join Sample Restaurant Group?' })).toBeTruthy();
    expect(screen.getByText(`owner@example.com added ${EMAIL} to Sample Restaurant Group. Your request for Sample Mountain Tavern is still with our team. If you join Sample Restaurant Group, we withdraw that request.`)).toBeTruthy();
    expect(writes(api)).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: 'Not my team' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/me/decline', body: { inviteId: 'i1' } }]);
  });

  test('with a pending request, what Join does names the role with its article', async () => {
    for (const [invitation, words] of [[INVITE, 'as a Member'], [{ ...INVITE, role: 'org_admin' as const }, 'as an Admin']] as const) {
      await renderApp('/joining', fakePortalApi({ me: meOf({ state: 'invited', invitations: [invitation], pendingRequest: REQUEST }) }));
      expect(await screen.findByText(`Join: you join Sample Restaurant Group’s team ${words} and see its locations. We withdraw your request for Sample Mountain Tavern.`)).toBeTruthy();
      await cleanup();
    }
  });

  test('Join and Not my team share one row; a long name wraps inside Join instead', async () => {
    atWidth(320);
    const access: Access = { state: 'invited', invitations: [{ ...INVITE, orgName: 'Juniper Lane Hospitality Group' }], pendingRequest: REQUEST };
    await renderApp('/joining', fakePortalApi({ me: meOf(access) }));
    const join = await screen.findByRole('button', { name: 'Join Juniper Lane Hospitality Group' });
    const row = around(join, (scope) => scope.queryByRole('button', { name: 'Not my team' }));
    expect(styleOf(row)).toMatchObject({ flexDirection: 'row' });
    expect(styleOf(row).flexWrap ?? 'nowrap').toBe('nowrap');
    // Join's box gives way; Not my team keeps its width.
    expect(styleOf(join.parent ?? join)).toMatchObject({ flexShrink: 1, minWidth: 0 });
    const notMine = screen.getByRole('button', { name: 'Not my team' });
    expect(styleOf(notMine.parent ?? notMine)).toMatchObject({ flexShrink: 0 });
  });

  test('with a pending request, Join withdraws it and opens Locations', async () => {
    const access: Access = { state: 'invited', invitations: [INVITE], pendingRequest: REQUEST };
    const api = fakePortalApi({ me: meOf(access), org: orgOf('member') });
    api.answers['/api/me/join'] = () => meOf(ACCESS.member);
    const { router } = await renderApp('/joining', api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Join Sample Restaurant Group' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
    expect(await screen.findByText(/You joined Test Group\./)).toBeTruthy();
  });

  test('two or more: choose one; Not my team on one leaves the rest, which waits for a press', async () => {
    const access: Access = { state: 'invited', invitations: [INVITE, SECOND_INVITE], pendingRequest: REQUEST };
    const api = fakePortalApi({ me: meOf(access) });
    api.answers['/api/me/decline'] = () => meOf({ state: 'invited', invitations: [INVITE], pendingRequest: null });
    await renderApp('/joining', api);
    expect(await screen.findByRole('heading', { name: 'Choose your team' })).toBeTruthy();
    expect(screen.getByText(`2 organizations added ${EMAIL}. You can belong to one. Choose the team you work with. Joining one withdraws your request for Sample Mountain Tavern.`)).toBeTruthy();
    expect(screen.getByText('as Admin')).toBeTruthy();
    expect(screen.getByText('Added by Townwise staff')).toBeTruthy();
    // The count is a mono numeral; Added by is `small`, `text2`, at every width.
    expect(styleOf(screen.getByText('2'))).toMatchObject({ fontFamily: theme.type.mono.fontFamily, fontVariant: ['tabular-nums'] });
    expect(styleOf(screen.getByText('Added by Townwise staff'))).toMatchObject({ fontSize: 14, lineHeight: 20, color: theme.color.text2 });
    await fireEvent.press(screen.getByRole('button', { name: 'Not my team: Sample Ski Bar' }));
    expect(await screen.findByText('Removed the invitation from Sample Ski Bar.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Join Sample Restaurant Group?' })).toBeTruthy();
    expect(writes(api)).toEqual([{ method: 'POST', path: '/api/me/decline', body: { inviteId: 'i2' } }]);
  });

  test('409 no_invite reads the access again and routes', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.invited) });
    api.answers['/api/me/join'] = () => {
      api.me = meOf(ACCESS.noOrg);
      return refusal(409, 'no_invite');
    };
    const { router } = await renderApp('/joining', api);
    await waitFor(() => { expect(router.getPathname()).toBe('/request-access'); });
  });

  test('a network error shows the shared copy, and Try again joins again', async () => {
    const api = fakePortalApi({ me: meOf(ACCESS.invited), org: orgOf('member') });
    api.answers['/api/me/join'] = () => offline();
    const { router } = await renderApp('/joining', api);
    expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
    api.answers['/api/me/join'] = () => meOf(ACCESS.member);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(router.getPathname()).toBe('/dashboard'); });
    expect(writes(api)).toHaveLength(2);
  });

  test('who added them: an org admin’s email, “Townwise staff”, or the organization when the account is gone', async () => {
    const access: Access = {
      state: 'invited', pendingRequest: null,
      invitations: [{ ...INVITE, invitedBy: { staff: false, email: null } }, SECOND_INVITE],
    };
    await renderApp('/joining', fakePortalApi({ me: meOf(access) }));
    expect(await screen.findByText('Added by Sample Restaurant Group')).toBeTruthy();
    expect(screen.getByText('Added by Townwise staff')).toBeTruthy();
  });

  test('view-as: nothing joins on its own, and Join and Not my team are disabled', async () => {
    const api = fakePortalApi({ me: viewAsMe(ACCESS.invited) });
    await renderApp('/joining', api);
    expect(await screen.findByRole('heading', { name: 'Join Sample Restaurant Group?' })).toBeTruthy();
    expect(screen.getByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
    // userEvent presses through the responder, as a finger does; a disabled control ignores it.
    const user = userEvent.setup();
    for (const name of ['Join Sample Restaurant Group', 'Not my team']) {
      const button = screen.getByRole('button', { name });
      expect(button.props.accessibilityState).toMatchObject({ disabled: true });
      await user.press(button);
    }
    expect(writes(api)).toEqual([]);
  });
});

describe('P8 Staff sign in again, and the P7 staff notice', () => {
  test.each([
    ['session_too_old', 'Staff sessions need a fresh sign-in with your code every 60 minutes.'],
    ['session_before_codes', 'This session started before two-step sign-in was on.'],
  ] as const)('%s: says why, and Sign in again signs out', async (reason, text) => {
    const signOut = jest.fn(() => Promise.resolve());
    await renderApp('/staff/sign-in-again', fakePortalApi({ me: staffMe({ state: 'staff_reauth_required', reason }) }), { signOut });
    expect(await screen.findByRole('heading', { name: 'Sign in again to use the staff console' })).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test('staff in setup: the notice above two-step settings, in the gate frame, and Sign in again after the codes', async () => {
    const signOut = jest.fn(() => Promise.resolve());
    const codes = Array.from({ length: 10 }, (_, index) => String(index).padStart(20, '0'));
    await renderApp('/settings/security', fakePortalApi({ me: staffMe(ACCESS.staffSetup) }), {
      signOut,
      confirmTotpEnrollment: () => Promise.resolve({ recoveryCodes: codes }),
    });
    // The notice is the page's lead, under the eyebrow and title, not a numbered message.
    expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeTruthy();
    expect(screen.getByText('Townwise staff')).toBeTruthy();
    const notice = screen.getByText('Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.');
    expect(styleOf(notice)).toMatchObject({ ...theme.type.sub, color: theme.color.text2 });
    expect(screen.queryByText('01')).toBeNull();
    expect(screen.getByText(`Signed in as ${STAFF_EMAIL}`)).toBeTruthy();
    expect(screen.queryByLabelText('Main')).toBeNull();
    await fireEvent.press(await screen.findByText('Set up two-step sign-in'));
    await fireEvent.press(await screen.findByText('Confirm'));
    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeTruthy();
    expect(screen.queryByText('I saved these')).toBeNull();
    const again = screen.getAllByRole('button', { name: 'Sign in again' });
    await fireEvent.press(again[0] ?? screen.getByText('Sign in again'));
    expect(signOut).toHaveBeenCalled();
  });

  test('members see two-step settings in the client app, with no staff notice', async () => {
    await renderApp('/settings/security', fakePortalApi({ me: meOf(ACCESS.member) }));
    expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByText(/Townwise staff accounts need two-step sign-in/)).toBeNull();
  });
});
