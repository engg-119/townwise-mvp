import { fetchStaffActivity, leaveOrg, renameOrg, signOutEverywhere } from '../../../src/portal/settings/api';
import { createAuthStore } from '../../../src/auth/store';
import { ACCESS, EMAIL, fakePortalApi, meOf, offline, refusal, writes } from '../../helpers/portal';
import { noContent, REFUSED_EVENT, VIEW_AS_EVENT, withRoutes } from '../team/fixtures';

function api() {
  const fake = fakePortalApi({ me: meOf(ACCESS.admin) });
  const routes = withRoutes(fake);
  return { fake, routes };
}

describe('settings calls (spec 10.3, api/src/handlers/org.ts)', () => {
  test('PATCH /api/org sends the name and returns the organization', async () => {
    const { fake } = api();
    fake.answers['/api/org'] = () => ({ org: { id: 'o1', name: 'Harbor Group' } });
    expect(await renameOrg(fake, 'Harbor Group')).toEqual({ id: 'o1', name: 'Harbor Group' });
    expect(writes(fake)).toEqual([{ method: 'PATCH', path: '/api/org', body: { name: 'Harbor Group' } }]);
  });

  test('GET /api/org/staff-activity returns the events, stripping keys the screen doesn’t read', async () => {
    const { fake, routes } = api();
    routes.gets['/api/org/staff-activity'] = () => ({ events: [{ ...VIEW_AS_EVENT, details: { reason: 'x' } }, REFUSED_EVENT] });
    expect(await fetchStaffActivity(fake)).toEqual([VIEW_AS_EVENT, REFUSED_EVENT]);
  });

  test('POST /api/org/leave sends exactly {} and returns the new access; 409 last_admin passes through', async () => {
    const { fake } = api();
    const removed = meOf({ ...ACCESS.removed, byYou: true });
    fake.answers['/api/org/leave'] = () => removed;
    expect(await leaveOrg(fake)).toEqual(removed);
    fake.answers['/api/org/leave'] = () => refusal(409, 'last_admin');
    await expect(leaveOrg(fake)).rejects.toMatchObject({ status: 409, code: 'last_admin' });
    expect(writes(fake)).toEqual([
      { method: 'POST', path: '/api/org/leave', body: {} },
      { method: 'POST', path: '/api/org/leave', body: {} },
    ]);
  });
});

describe('signOutEverywhere (kit POST /auth/logout-all)', () => {
  function auth(signOut: () => Promise<void>) {
    const { fake, routes } = api();
    const store = createAuthStore({ status: 'signedIn', user: { id: 'u1', email: EMAIL } });
    return { fake, routes, store, value: { api: fake, store, signOut: jest.fn(signOut) } };
  }

  test('revokes every session, then signs this device out', async () => {
    const { fake, routes, value } = auth(() => Promise.resolve());
    routes.requests['POST /auth/logout-all'] = noContent;
    await signOutEverywhere(value);
    expect(writes(fake)).toEqual([{ method: 'POST', path: '/auth/logout-all', body: undefined }]);
    expect(value.signOut).toHaveBeenCalledTimes(1);
  });

  test('a logout-all that fails changes nothing on this device', async () => {
    const { routes, store, value } = auth(() => Promise.resolve());
    routes.requests['POST /auth/logout-all'] = () => offline();
    await expect(signOutEverywhere(value)).rejects.toMatchObject({ kind: 'network' });
    expect(value.signOut).not.toHaveBeenCalled();
    expect(store.getState().status).toBe('signedIn');
  });

  test('once the sessions are revoked, a failed local sign-out still ends this one', async () => {
    const { routes, store, value } = auth(() => Promise.reject(offline()));
    routes.requests['POST /auth/logout-all'] = noContent;
    await signOutEverywhere(value);
    expect(store.getState()).toEqual({ status: 'signedOut' });
  });
});
