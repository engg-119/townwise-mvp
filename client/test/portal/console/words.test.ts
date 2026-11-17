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
    'sales.upload_deleted', 'data.turned_off', 'data.turned_on', 'data.renamed', 'data.edited',
    'file.uploaded', 'file.deleted', 'file.raw_deleted', 'files.raw_deleted_all',
    'file.ai_read_requested', 'file.ai_read', 'file.ai_undone', 'org.originals_deleted',
    'note.created', 'note.updated', 'note.deleted', 'chat.turn_completed', 'chat.conversation_deleted',
    'agent.question_answered', 'agent.suggestion_accepted', 'agent.suggestion_dismissed', 'org.weekly_suggestions_changed',
    'order.setup_saved', 'order.item_sales_uploaded', 'order.item_sales_deleted', 'order.count_saved', 'order.decision_saved',
    'order.rule_saved', 'order.rule_turned_off', 'order.card_saved', 'order.card_dismissed', 'order.setup_read',
    'forecast.imported', 'forecast.published', 'forecast.withdrawn', 'forecast.deleted',
    'calibration.scheduled', 'forecast_schedule.paused', 'forecast_schedule.resumed',
    'view_as.started', 'view_as.ended', 'open_as_admin.started', 'open_as_admin.ended', 'people.signed_out_everywhere', 'person.deleted', 'staff_action.not_applied',
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
  ['agent.question_answered', { locationId: 'l1', questionId: 'gap_2026-12-24_2026-12-26', answer: 'closed' }, 'Closed on those days'],
  ['agent.question_answered', { locationId: 'l1', questionId: 'weekday_1_2026-01-05_2026-12-28', answer: 'open' }, 'The data is missing'],
  ['agent.question_answered', { locationId: 'l1', questionId: 'likely_closed_2026-03-14', answer: 'open' }, 'Open, with few guests'],
  ['agent.question_answered', { locationId: 'l1', questionId: 'likely_closed_2026-03-14', answer: 'closed' }, 'Closed that day'],
  ['agent.question_answered', { locationId: 'l1', questionId: 'likely_closed_2026-03-14', answer: 'not_sure' }, 'Not sure'],
  ['agent.question_answered', { locationId: 'l1', questionId: 'likely_closed_2026-03-14', answer: 'other' }, 'Answered in the chat'],
  ['agent.question_answered', { locationId: 'l1', questionId: 'gap_2026-12-24_2026-12-26', answer: 'other' }, 'Answered in the chat'],
  ['agent.suggestion_accepted', { locationId: 'l1', suggestionId: 's1', type: 'note' }, 'Note'],
  ['agent.suggestion_dismissed', { locationId: 'l1', suggestionId: 's1', type: 'rule' }, 'Business rule'],
  ['org.weekly_suggestions_changed', { on: false }, 'Off'],
  ['forecast.published', { locationId: 'l1', modelVersion: 'v9', from: '2026-05-01', to: '2026-05-14', dayCount: 14 }, 'Model v9, May 1, 2026 to May 14, 2026, 14 days'],
])('details for %s', (action, details, expected) => {
  expect(auditDetails({ action, details })).toBe(expected);
});

test('D28: renaming and editing an item have the API’s labels (api/src/audit.ts)', () => {
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'data.renamed', label: 'Item renamed' });
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'data.edited', label: 'Item edited' });
});

test('D42: the weekly refresh’s actions have labels, and their details (ids only) show nothing', () => {
  const label = (value: string) => AUDIT_ACTIONS.find((action) => action.value === value)?.label;
  expect([label('calibration.scheduled'), label('forecast_schedule.paused'), label('forecast_schedule.resumed')])
    .toEqual(['Weekly calibration started', 'Weekly refresh paused', 'Weekly refresh resumed']);
  expect(auditDetails({ action: 'calibration.scheduled', details: { locationId: 'l1', calibrationId: 'c1' } })).toBe('');
});

test('D34: reading a file with TownwiseAI has the API’s actions, in plain words (api/src/stores/audit-events.ts)', () => {
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'file.ai_read_requested', label: 'TownwiseAI read asked' });
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'file.ai_read', label: 'File read by TownwiseAI' });
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'file.ai_undone', label: 'TownwiseAI read undone' });
});

test('order actions have plain labels, and the server’s summary carries their counts and dates', () => {
  expect(AUDIT_ACTIONS.filter((action) => action.value.startsWith('order.')).map((action) => action.label)).toEqual([
    'Ordering setup saved', 'Item sales uploaded', 'Item sales deleted', 'Count saved', 'Order line changed', 'Order rule saved',
    'Order rule turned off', 'TownwiseAI order card saved', 'TownwiseAI order card set aside', 'Ordering setup read by TownwiseAI',
  ]);
  expect(auditDetails({ action: 'order.count_saved', details: { locationId: 'l1', date: '2026-11-13', itemCount: 12 } })).toBe('');
  expect(auditDetails({ action: 'order.card_saved', details: { locationId: 'l1', conversationId: 'c1', kind: 'rule' } })).toBe('');
});

test('D41: reading the ordering setup with TownwiseAI has the API’s action, in plain words, and no details beyond the server’s summary', () => {
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'order.setup_read', label: 'Ordering setup read by TownwiseAI' });
  expect(auditDetails({ action: 'order.setup_read', details: { locationId: 'l1', inputKind: 'file', outcome: 'read', suppliers: 2, items: 14 } })).toBe('');
});

test('open as admin has its audit labels and end reasons', () => {
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'open_as_admin.started', label: 'Opened as admin' });
  expect(AUDIT_ACTIONS).toContainEqual({ value: 'open_as_admin.ended', label: 'Open as admin ended' });
  expect(auditDetails({ action: 'open_as_admin.ended', details: { endReason: 'expired' } })).toBe('The staff sign-in ended');
  expect(auditDetails({ action: 'open_as_admin.ended', details: { endReason: 'ended' } })).toBe('Ended by staff');
  expect(auditDetails({ action: 'open_as_admin.ended', details: { endReason: 'replaced' } })).toBe('Cleared at the next start');
  expect(auditDetails({ action: 'open_as_admin.started', details: {} })).toBe('');
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
