import { requestHref } from '../../../src/portal/console/links';
import { noticeShowsAt } from '../../../src/portal/PortalProvider';
import { splitEmails } from '../../../src/portal/console/OrgTeam';
import { viewAsBody } from '../../../src/portal/console/ViewAsDialog';
import { actorLine, actorRoleLabel, AUDIT_ACTIONS, auditDetails, KIND_LABEL, twoStepLabel } from '../../../src/portal/console/words';
import { formatTime } from '../../../src/portal/format';

// The console's words for the API's codes (src/portal/console/words.ts) and its small helpers.

test('kinds, actor roles and two-step states in plain words', () => {
  expect(Object.values(KIND_LABEL)).toEqual(['Townwise staff', 'Admin', 'Member', 'Invited', 'Requested', 'Rejected', 'Removed', 'Signed in only']);
  expect(['superadmin', 'org_admin', 'member', 'user', 'other'].map(actorRoleLabel)).toEqual(['Townwise staff', 'Admin', 'Member', 'No organization', 'other']);
  expect(actorLine({ actorRole: 'superadmin', viewAs: { targetEmail: 'gm@example.org' } })).toBe('Townwise staff, viewing as gm@example.org');
  expect(twoStepLabel({ state: 'on', since: '2026-08-01' })).toBe('On since Aug 1, 2026');
  expect(twoStepLabel({ state: 'not_set_up' })).toBe('Not set up');
  expect(twoStepLabel({ state: 'not_signed_in' })).toBe('Not signed in yet');
  expect(twoStepLabel(null)).toBe('');
});

test('the action filter covers every action the API records (api/src/stores/audit-events.ts)', () => {
  expect(AUDIT_ACTIONS.map((action) => action.value)).toEqual([
    'access_request.created', 'access_request.approved', 'access_request.rejected', 'access_request.withdrawn',
    'org.created', 'org.renamed', 'org.suspended', 'org.reactivated', 'org.deleted',
    'member.invited', 'member.declined', 'member.joined', 'member.role_changed', 'member.removed', 'member.left',
    'location.created', 'location.updated', 'location.deleted', 'sales.uploaded', 'sales.deleted',
    'note.created', 'note.updated', 'note.deleted', 'chat.turn_completed', 'chat.conversation_deleted',
    'view_as.started', 'view_as.ended', 'people.signed_out_everywhere', 'person.deleted', 'staff_action.not_applied',
  ]);
});

test.each<[string, Record<string, string | number | boolean | null>, string]>([
  ['access_request.created', { orgName: 'X', townId: null, townName: 'Norwich' }, 'Town: Norwich'],
  ['member.invited', { email: 'a@example.com', role: 'org_admin' }, 'Role: admin'],
  ['member.joined', { email: 'a@example.com', role: 'member' }, 'Role: member'],
  ['member.role_changed', { email: 'a@example.com', from: 'org_admin', to: 'member' }, 'From admin to member'],
  ['note.deleted', { locationId: 'l1', kind: 'private_event', startDate: '2026-12-24', endDate: '2026-12-26' }, 'Private event, Dec 24, 2026 to Dec 26, 2026'],
  ['sales.uploaded', { inserted: 1200, replaced: 0, firstDate: '2025-01-01', lastDate: '2026-01-01' }, '1,200 new, 0 replaced, Jan 1, 2025 to Jan 1, 2026'],
  ['view_as.ended', { endReason: 'expired' }, 'Ran out'],
  ['view_as.ended', { endReason: 'replaced' }, 'Replaced by a new view-as'],
  ['chat.turn_completed', { locationId: 'l1', inputTokens: 1000, outputTokens: 200 }, ''],
  ['org.renamed', { from: 'A', to: 'B' }, ''],
])('details for %s', (action, details, expected) => {
  expect(auditDetails({ action, details })).toBe(expected);
});

test('view-as details carry the staff member’s reason and the end time', () => {
  const expiresAt = '2026-10-10T15:30:00.000Z';
  expect(auditDetails({ action: 'view_as.started', details: { reason: 'A question.', expiresAt } })).toBe(`Reason: “A question.” Until ${formatTime(expiresAt)}.`);
});

test('the C1 body names the organization’s admins only when there is one', () => {
  expect(viewAsBody({ email: 'gm@example.org', userId: 'u1', orgName: null })).toBe(
    'You’ll see what gm@example.org sees, read-only, for 30 minutes. This is recorded in the audit log with your reason. It ends early if gm@example.org joins, leaves or changes organization.',
  );
  expect(viewAsBody({ email: 'gm@example.org', userId: 'u1', orgName: 'Sample Group' })).toContain('with your reason, and Sample Group’s admins can see it.');
});

test('addresses split on lines, commas, semicolons and spaces', () => {
  expect(splitEmails(' a@example.com,b@example.com\n\nc@example.com; d@example.com ')).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']);
  expect(splitEmails(' \n ,')).toEqual([]);
});

test('links: a request on its tab, and a notice that shows only on one path', () => {
  expect(requestHref('pending', 'r1')).toBe('/admin?request=r1');
  expect(requestHref('approved', 'r1')).toBe('/admin?status=approved&request=r1');
  // A string means exactly that path, so no pattern is ever built from a path.
  expect(noticeShowsAt('/admin/orgs', '/admin/orgs')).toBe(true);
  expect(noticeShowsAt('/admin/orgs', '/admin/orgs/o1')).toBe(false);
  expect(noticeShowsAt('/admin/orgs/a.b', '/admin/orgs/aXb')).toBe(false);
  expect(noticeShowsAt(/^\/admin$/, '/admin')).toBe(true);
  expect(noticeShowsAt(null, '/anywhere')).toBe(true);
});
