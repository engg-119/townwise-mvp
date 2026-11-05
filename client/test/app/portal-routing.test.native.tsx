jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import type { Access, MeResponse } from '../../src/portal/schemas';
import {
  ACCESS, deferred, fakePortalApi, INVITE, meOf, offline, orgOf, refusal, SECOND_INVITE, staffMe, viewAsMe,
} from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';

afterEach(async () => {
  await cleanup();
});

// Two invitations wait for a press, so Joining stays still.
const TWO_INVITES: Access = { state: 'invited', invitations: [INVITE, SECOND_INVITE], pendingRequest: null };

function meFor(access: Access): MeResponse {
  return access.state.startsWith('staff') ? staffMe(access) : meOf(access);
}

// After sign-in the app opens /dashboard (src/auth/store.ts routeFor); the portal then routes on GET /api/me.
test.each<[string, Access, string, string]>([
  ['staff', ACCESS.staff, '/admin', 'The staff console is on the web. Open townwise.tech on a computer.'],
  ['staff_setup_required', ACCESS.staffSetup, '/settings/security', 'Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.'],
  ['staff_reauth_required', ACCESS.staffReauth, '/staff/sign-in-again', 'Sign in again to use the staff console'],
  ['member', ACCESS.member, '/dashboard', 'Main Street Bar'],
  ['invited', TWO_INVITES, '/joining', 'Choose your team'],
  ['pending', ACCESS.pending, '/waiting', 'Your request is in'],
  ['rejected', ACCESS.rejected, '/no-access', 'We can’t give you access yet'],
  ['removed', ACCESS.removed, '/no-access', 'You no longer have access to Sample Restaurant Group'],
  ['org_suspended', ACCESS.suspended, '/no-access', 'Access to Sample Restaurant Group is paused'],
  ['no_org', ACCESS.noOrg, '/request-access', 'Request access'],
])('%s lands on %s', async (_name, access, route, text) => {
  const api = fakePortalApi({ me: meFor(access), org: orgOf('member') });
  const { router } = await renderApp('/dashboard', api);
  await waitFor(() => { expect(router.getPathname()).toBe(route); });
  expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
});

test('“Checking your access” shows until GET /api/me answers', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.pending) });
  const answer = deferred<undefined>();
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => (path === '/api/me' ? answer.promise.then(() => json(path, schema, opts)) : json(path, schema, opts));
  const { router } = await renderApp('/waiting', api);
  expect(screen.getByText('Checking your access')).toBeTruthy();
  expect(screen.queryByText('Your request is in')).toBeNull();
  await act(async () => { answer.resolve(undefined); await answer.promise; });
  expect(await screen.findByText('Your request is in')).toBeTruthy();
  expect(router.getPathname()).toBe('/waiting');
});

test('if GET /api/me can’t be read: the shared copy, and Try again reads it again', async () => {
  const api = fakePortalApi({ me: offline() });
  const { router } = await renderApp('/dashboard', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  api.me = meOf(ACCESS.noOrg);
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(router.getPathname()).toBe('/request-access'); });
});

test.each<[string, MeResponse, string, string]>([
  ['a pending person on /dashboard', meOf(ACCESS.pending), '/dashboard', '/waiting'],
  ['a member on /waiting', meOf(ACCESS.member), '/waiting', '/dashboard'],
  ['a member on /request-access', meOf(ACCESS.member), '/request-access', '/dashboard'],
  ['a member on /team', meOf(ACCESS.member), '/team', '/dashboard'],
  ['a member on a location’s Settings', meOf(ACCESS.member), '/locations/l1/settings', '/dashboard'],
  ['a member on /admin', meOf(ACCESS.member), '/admin', '/dashboard'],
  ['staff on /dashboard', staffMe(), '/dashboard', '/admin'],
  ['staff on /joining', staffMe(), '/joining', '/admin'],
  ['staff in setup on /admin', staffMe(ACCESS.staffSetup), '/admin', '/settings/security'],
  ['a paused organization on /request-access', meOf(ACCESS.suspended), '/request-access', '/no-access'],
  ['no organization on /no-access', meOf(ACCESS.noOrg), '/no-access', '/request-access'],
  ['an invited person on /waiting', meOf(TWO_INVITES), '/waiting', '/joining'],
  ['view-as on the staff console', viewAsMe(ACCESS.pending), '/admin', '/waiting'],
  ['view-as on two-step settings', viewAsMe(ACCESS.member), '/settings/security', '/dashboard'],
])('%s is sent to its own route', async (_name, me, from, to) => {
  const api = fakePortalApi({ me, org: orgOf('member') });
  const { router } = await renderApp(from, api);
  await waitFor(() => { expect(router.getPathname()).toBe(to); });
});

test.each([['rejected', ACCESS.rejected], ['removed', ACCESS.removed]] as const)('%s may open /request-access by choice', async (_name, access) => {
  const api = fakePortalApi({ me: meOf(access) });
  const { router } = await renderApp('/no-access', api);
  await fireEvent.press(await screen.findByRole('link', { name: /request/i }));
  expect(router.getPathname()).toBe('/request-access');
  expect(await screen.findByRole('heading', { name: 'Request access' })).toBeTruthy();
});

test.each([
  [403, 'no_access'], [403, 'forbidden'], [409, 'view_as_active'],
])('a %i %s answer re-reads GET /api/me and routes again', async (status, code) => {
  // A member removed meanwhile: GET /api/org answers with the refusal, and /api/me now says removed.
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: refusal(status, code) });
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => {
    const answer = json(path, schema, opts);
    if (path === '/api/me') api.me = meOf(ACCESS.removed);
    return answer;
  };
  const { router } = await renderApp('/dashboard', api);
  await waitFor(() => { expect(router.getPathname()).toBe('/no-access'); });
  expect(api.calls.filter((call) => call.path === '/api/me')).toHaveLength(2);
  expect(await screen.findByText('You no longer have access to Sample Restaurant Group')).toBeTruthy();
});

test('a refusal that needs no re-read leaves the access alone', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: refusal(404, 'not_found') });
  const { router } = await renderApp('/dashboard', api);
  expect(await screen.findByText('Something went wrong with that request. Reload the page and try again.')).toBeTruthy();
  expect(api.calls.filter((call) => call.path === '/api/me')).toHaveLength(1);
  expect(router.getPathname()).toBe('/dashboard');
});
