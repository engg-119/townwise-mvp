// The staff console's Overview (openspec change staff-overview, design decisions 4 and 5): GET
// /api/admin/overview?days=7|28|90 answers, across organizations, who used Townwise in the window and the window before
// it, what they did, each organization's usage and forecast health, and what needs a staff member's attention. Counts,
// dates and a published forecast's live accuracy only (D7): never a sales figure, guest count, note text, chat text or a
// member's email.
import type { AuditAction } from '../stores/audit-events.ts';

/** The groups people's actions are counted in, in the order the page stacks them. */
export const ACTION_GROUPS = ['uploads', 'notes', 'townwiseAi', 'orders', 'team'] as const;
export type ActionGroup = typeof ACTION_GROUPS[number];

/**
 * Each audit action's group, or null for none (design decision 4): uploads and data; notes, rules and calendars;
 * TownwiseAI; orders; team and settings. Every action is a key, so a new one fails the typecheck and
 * test/overview.test.ts until it is placed. An action is an event, not a click: some single steps write two.
 */
export const ACTION_GROUP: Readonly<Record<AuditAction, ActionGroup | null>> = {
  'access_request.created': null,
  'access_request.approved': null,
  'access_request.rejected': null,
  'access_request.withdrawn': null,
  'org.created': null,
  'org.renamed': 'team',
  'org.suspended': null,
  'org.reactivated': null,
  'org.deleted': null,
  'member.invited': 'team',
  // Its actor role is `user`, never a member's.
  'member.declined': null,
  'member.joined': 'team',
  'member.role_changed': 'team',
  'member.removed': 'team',
  'member.left': 'team',
  'location.created': 'team',
  'location.updated': 'team',
  'location.deleted': 'team',
  'sales.uploaded': 'uploads',
  'sales.deleted': 'uploads',
  'sales.upload_deleted': 'uploads',
  'data.turned_off': 'uploads',
  'data.turned_on': 'uploads',
  'data.renamed': 'uploads',
  'data.edited': 'uploads',
  'file.uploaded': 'uploads',
  'file.deleted': 'uploads',
  'file.raw_deleted': 'uploads',
  'files.raw_deleted_all': 'uploads',
  'file.ai_read_requested': 'townwiseAi',
  // Written by the reader, not the person.
  'file.ai_read': null,
  'file.ai_undone': 'townwiseAi',
  'org.originals_deleted': null,
  'note.created': 'notes',
  'note.updated': 'notes',
  'note.deleted': 'notes',
  'rule.created': 'notes',
  'rule.updated': 'notes',
  'rule.deleted': 'notes',
  'owner_calendar.added': 'notes',
  'owner_calendar.removed': 'notes',
  'owner_calendar.refreshed': 'notes',
  'google_calendar.connected': 'notes',
  'google_calendar.disconnected': 'notes',
  'chat.turn_completed': 'townwiseAi',
  'chat.conversation_deleted': 'townwiseAi',
  'agent.question_answered': 'townwiseAi',
  'org.weekly_suggestions_changed': 'team',
  'agent.suggestion_accepted': 'townwiseAi',
  'agent.suggestion_dismissed': 'townwiseAi',
  'order.setup_saved': 'orders',
  'order.item_sales_uploaded': 'uploads',
  'order.item_sales_deleted': 'uploads',
  'order.count_saved': 'orders',
  'order.decision_saved': 'orders',
  'order.rule_saved': 'orders',
  'order.rule_turned_off': 'orders',
  'order.card_saved': 'townwiseAi',
  'order.card_dismissed': 'townwiseAi',
  'order.setup_read': 'townwiseAi',
  'forecast.imported': null,
  'forecast.published': null,
  'forecast.withdrawn': null,
  'forecast.deleted': null,
  'calibration.requested': 'townwiseAi',
  'calibration.finished': null,
  'calibration.scheduled': null,
  'org.forecasts_switched': null,
  'forecast_schedule.paused': null,
  'forecast_schedule.resumed': null,
  'view_as.started': null,
  'view_as.ended': null,
  'open_as_admin.started': null,
  'open_as_admin.ended': null,
  'people.signed_out_everywhere': null,
  'person.deleted': null,
  'staff_action.not_applied': null,
};
