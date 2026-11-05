import { ApiError } from '../../../src/api/client';
import { addMembers, changeRole, fetchMembers, removeMember } from '../../../src/portal/team/api';
import { MAX_EMAILS, parseEmails } from '../../../src/portal/team/copy';
import { ACCESS, fakePortalApi, meOf, refusal, writes } from '../../helpers/portal';
import { CHEF, MANAGER, noContent, TEAM, withRoutes } from './fixtures';

function api() {
  const fake = fakePortalApi({ me: meOf(ACCESS.admin) });
  const routes = withRoutes(fake);
  return { fake, routes };
}

describe('team calls (spec 10.6, api/src/handlers/team.ts)', () => {
  test('GET /api/org/members returns the members, stripping keys the screen doesn’t read', async () => {
    const { fake, routes } = api();
    routes.gets['/api/org/members'] = () => ({ members: [{ ...MANAGER, userId: 'u9', removedBy: null }] });
    expect(await fetchMembers(fake)).toEqual([MANAGER]);
    expect(fake.calls).toEqual([{ method: 'GET', path: '/api/org/members', body: undefined }]);
  });

  test('a member shape the screen can’t read is an invalid response, not a broken row', async () => {
    const { fake, routes } = api();
    routes.gets['/api/org/members'] = () => ({ members: [{ ...MANAGER, role: 'owner' }] });
    await expect(fetchMembers(fake)).rejects.toThrow();
  });

  test('POST /api/org/members sends the addresses and the role, and returns results and the team', async () => {
    const { fake } = api();
    const answer = { results: [{ email: 'chef@example.com', outcome: 'already_invited' }], members: TEAM };
    fake.answers['/api/org/members'] = () => answer;
    expect(await addMembers(fake, ['chef@example.com'], 'org_admin')).toEqual(answer);
    expect(writes(fake)).toEqual([{ method: 'POST', path: '/api/org/members', body: { emails: ['chef@example.com'], role: 'org_admin' } }]);
  });

  test('POST /api/org/members passes 409 member_limit through', async () => {
    const { fake } = api();
    fake.answers['/api/org/members'] = () => refusal(409, 'member_limit');
    await expect(addMembers(fake, ['cook@example.com'], 'member')).rejects.toMatchObject({ status: 409, code: 'member_limit' });
  });

  test('PATCH /api/org/members/:memberId sends the role and returns the row; the id is encoded', async () => {
    const { fake } = api();
    fake.answers['/api/org/members/m2'] = () => ({ member: { ...MANAGER, role: 'org_admin' } });
    expect(await changeRole(fake, 'm2', 'org_admin')).toEqual({ ...MANAGER, role: 'org_admin' });
    fake.answers['/api/org/members/a%2Fb'] = () => refusal(409, 'last_admin');
    await expect(changeRole(fake, 'a/b', 'member')).rejects.toMatchObject({ status: 409, code: 'last_admin' });
    expect(writes(fake)).toEqual([
      { method: 'PATCH', path: '/api/org/members/m2', body: { role: 'org_admin' } },
      { method: 'PATCH', path: '/api/org/members/a%2Fb', body: { role: 'member' } },
    ]);
  });

  test('DELETE /api/org/members/:memberId resolves on 204 and passes refusals through', async () => {
    const { fake, routes } = api();
    routes.requests['DELETE /api/org/members/m3'] = noContent;
    await expect(removeMember(fake, CHEF.id)).resolves.toBeUndefined();
    routes.requests['DELETE /api/org/members/m4'] = () => refusal(409, 'last_admin');
    const failed: unknown = await removeMember(fake, 'm4').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed).toMatchObject({ status: 409, code: 'last_admin' });
    expect(writes(fake).map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /api/org/members/m3', 'DELETE /api/org/members/m4']);
  });
});

describe('parseEmails (F5 step 1)', () => {
  test('splits on new lines and commas, trims, and drops repeats ignoring case', () => {
    expect(parseEmails(' a@example.com,\nB@example.com\r\n\n b@example.com ; c@example.com  d@example.com ')).toEqual({
      emails: ['a@example.com', 'B@example.com', 'c@example.com', 'd@example.com'],
    });
  });

  test('keeps what isn’t an email, for the server to call invalid', () => {
    expect(parseEmails('bartender.example.com')).toEqual({ emails: ['bartender.example.com'] });
  });

  test('none, or more than 20 distinct addresses, is a field message', () => {
    expect(parseEmails(' \n , ')).toEqual({ message: 'Enter at least one email address.' });
    const twenty = Array.from({ length: MAX_EMAILS }, (_, index) => `cook${String(index)}@example.com`);
    expect(parseEmails([...twenty, twenty[0] ?? ''].join('\n'))).toEqual({ emails: twenty });
    expect(parseEmails([...twenty, 'one@example.com'].join(','))).toEqual({ message: 'Add up to 20 addresses at a time.' });
  });
});
