import { formatCount, formatDate, formatTime } from '../format';
import type { AddResult, AuditEvent, Person, PersonKind } from './schemas';

// The console's words for the API's codes (spec 16.4): person kinds, actor roles, two-step states, add results,
// and the Details column of the audit log. Details read only the keys each action allowlists (spec 9.2), so an
// unexpected key never reaches the screen.

export const KIND_LABEL: Readonly<Record<PersonKind, string>> = {
  staff: 'Townwise staff',
  org_admin: 'Admin',
  member: 'Member',
  invited: 'Invited',
  pending: 'Requested',
  rejected: 'Rejected',
  removed: 'Removed',
  signed_in: 'Signed in only',
};

/** The audit log's actor roles (spec 9.1). */
export function actorRoleLabel(role: string): string {
  switch (role) {
    case 'superadmin': return 'Townwise staff';
    case 'org_admin': return 'Admin';
    case 'member': return 'Member';
    case 'user': return 'No organization';
    default: return role;
  }
}

/** The Who column: the role, and who staff were viewing as. */
export function actorLine(event: Pick<AuditEvent, 'actorRole' | 'viewAs'>): string {
  const role = actorRoleLabel(event.actorRole);
  return event.viewAs === null ? role : `${role}, viewing as ${event.viewAs.targetEmail}`;
}

export function twoStepLabel(twoStep: Person['staffTwoStep']): string {
  if (twoStep === null) return '';
  if (twoStep.state === 'on') return `On since ${formatDate(twoStep.since)}`;
  return twoStep.state === 'not_set_up' ? 'Not set up' : 'Not signed in yet';
}

export const ADD_COPY: Readonly<Record<AddResult['outcome'], string>> = {
  invited: 'Added. They can join the next time they continue with Google.',
  already_invited: 'Already invited.',
  already_member: 'Already on the team.',
  invalid: 'That isn’t an email address.',
};

/** “{date}, {time}”. */
export function whenLabel(at: string): string {
  return `${formatDate(at)}, ${formatTime(at)}`;
}

/** The audit log's action filter: the API's action codes (api/src/stores/audit-events.ts), in plain words. */
export const AUDIT_ACTIONS: readonly { value: string; label: string }[] = [
  { value: 'access_request.created', label: 'Request sent' },
  { value: 'access_request.approved', label: 'Request approved' },
  { value: 'access_request.rejected', label: 'Request rejected' },
  { value: 'access_request.withdrawn', label: 'Request withdrawn' },
  { value: 'org.created', label: 'Organization created' },
  { value: 'org.renamed', label: 'Organization renamed' },
  { value: 'org.suspended', label: 'Organization suspended' },
  { value: 'org.reactivated', label: 'Organization reactivated' },
  { value: 'org.deleted', label: 'Organization deleted' },
  { value: 'member.invited', label: 'Added' },
  { value: 'member.declined', label: 'Declined' },
  { value: 'member.joined', label: 'Joined' },
  { value: 'member.role_changed', label: 'Role changed' },
  { value: 'member.removed', label: 'Removed' },
  { value: 'member.left', label: 'Left' },
  { value: 'location.created', label: 'Location added' },
  { value: 'location.updated', label: 'Location changed' },
  { value: 'location.deleted', label: 'Location deleted' },
  { value: 'sales.uploaded', label: 'Sales uploaded' },
  { value: 'sales.deleted', label: 'Sales deleted' },
  // D28, Your data.
  { value: 'sales.upload_deleted', label: 'Upload deleted' },
  { value: 'data.turned_off', label: 'Item turned off' },
  { value: 'data.turned_on', label: 'Item turned on' },
  { value: 'data.renamed', label: 'Item renamed' },
  { value: 'data.edited', label: 'Item edited' },
  { value: 'file.uploaded', label: 'File uploaded' },
  { value: 'file.deleted', label: 'File deleted' },
  { value: 'file.raw_deleted', label: 'Original deleted' },
  { value: 'files.raw_deleted_all', label: 'Originals deleted' },
  { value: 'org.originals_deleted', label: 'Originals purged' },
  { value: 'note.created', label: 'Note added' },
  { value: 'note.updated', label: 'Note changed' },
  { value: 'note.deleted', label: 'Note deleted' },
  { value: 'chat.turn_completed', label: 'Tuning chat used' },
  { value: 'chat.conversation_deleted', label: 'Tuning chat deleted' },
  // U9, TownwiseAI's questions.
  { value: 'agent.question_answered', label: 'TownwiseAI question answered' },
  // Orders: the ordering setup, item sales, counts, a line's edit, rules, and TownwiseAI's order cards.
  { value: 'order.setup_saved', label: 'Ordering setup saved' },
  { value: 'order.item_sales_uploaded', label: 'Item sales uploaded' },
  { value: 'order.item_sales_deleted', label: 'Item sales deleted' },
  { value: 'order.count_saved', label: 'Count saved' },
  { value: 'order.decision_saved', label: 'Order line changed' },
  { value: 'order.rule_saved', label: 'Order rule saved' },
  { value: 'order.rule_turned_off', label: 'Order rule turned off' },
  { value: 'order.card_saved', label: 'TownwiseAI order card saved' },
  { value: 'order.card_dismissed', label: 'TownwiseAI order card set aside' },
  // U13B, forecast runs.
  { value: 'forecast.imported', label: 'Forecast imported' },
  { value: 'forecast.published', label: 'Forecast published' },
  { value: 'forecast.withdrawn', label: 'Forecast withdrawn' },
  { value: 'forecast.deleted', label: 'Forecast deleted' },
  { value: 'view_as.started', label: 'View-as started' },
  { value: 'view_as.ended', label: 'View-as ended' },
  // D25, open as admin.
  { value: 'open_as_admin.started', label: 'Opened as admin' },
  { value: 'open_as_admin.ended', label: 'Open as admin ended' },
  { value: 'people.signed_out_everywhere', label: 'Signed out everywhere' },
  { value: 'person.deleted', label: 'Person deleted' },
  { value: 'staff_action.not_applied', label: 'Didn’t take effect' },
];

const NOTE_KIND: Readonly<Record<string, string>> = {
  closure: 'Closure', private_event: 'Private event', opening: 'Opening', other: 'Other',
};

/** U9: the answer to a TownwiseAI question about days with no sales. */
const QUESTION_ANSWER: Readonly<Record<string, string>> = {
  closed: 'Closed on those days', open: 'The data is missing', not_sure: 'Not sure',
};

const END_REASON: Readonly<Record<string, string>> = {
  ended: 'Ended by staff', expired: 'Ran out', replaced: 'Replaced by a new view-as',
};

/** D25: why an open-as-admin session ended. */
const OPEN_AS_END_REASON: Readonly<Record<string, string>> = {
  ended: 'Ended by staff', expired: 'The staff sign-in ended', replaced: 'Cleared at the next start',
};

function text(value: AuditEvent['details'][string] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function count(value: AuditEvent['details'][string] | undefined): string {
  return typeof value === 'number' ? formatCount(value) : '';
}

function role(value: AuditEvent['details'][string] | undefined): string {
  return value === 'org_admin' ? 'admin' : text(value);
}

function dates(details: AuditEvent['details']): string {
  const first = text(details.startDate ?? details.firstDate);
  const last = text(details.endDate ?? details.lastDate);
  return first === '' || last === '' ? '' : `${formatDate(first)} to ${formatDate(last)}`;
}

/** The Details column: what the summary leaves out, from the action's allowlisted keys only. */
export function auditDetails(event: Pick<AuditEvent, 'action' | 'details'>): string {
  const d = event.details;
  switch (event.action) {
    case 'access_request.created':
      return text(d.townName) === '' ? '' : `Town: ${text(d.townName)}`;
    case 'member.invited':
    case 'member.joined':
      return role(d.role) === '' ? '' : `Role: ${role(d.role)}`;
    case 'member.role_changed':
      return `From ${role(d.from)} to ${role(d.to)}`;
    case 'note.created':
    case 'note.updated':
    case 'note.deleted':
      return [NOTE_KIND[text(d.kind)] ?? '', dates(d)].filter((part) => part !== '').join(', ');
    case 'sales.uploaded':
      return [`${count(d.inserted)} new`, `${count(d.replaced)} replaced`, dates(d)].filter((part) => part !== '').join(', ');
    case 'view_as.started': {
      const until = text(d.expiresAt) === '' ? '' : ` Until ${formatTime(text(d.expiresAt))}.`;
      return `Reason: “${text(d.reason)}”${until}`;
    }
    case 'view_as.ended':
      return END_REASON[text(d.endReason)] ?? '';
    case 'open_as_admin.ended':
      return OPEN_AS_END_REASON[text(d.endReason)] ?? '';
    case 'agent.question_answered':
      return QUESTION_ANSWER[text(d.answer)] ?? '';
    // U13B: the model version, the dates and the day count, never a figure.
    case 'forecast.imported':
    case 'forecast.published':
    case 'forecast.withdrawn':
    case 'forecast.deleted': {
      const span = text(d.from) === '' || text(d.to) === '' ? '' : `${formatDate(text(d.from))} to ${formatDate(text(d.to))}`;
      const days = count(d.dayCount) === '' ? '' : `${count(d.dayCount)} days`;
      return [text(d.modelVersion) === '' ? '' : `Model ${text(d.modelVersion)}`, span, days].filter((part) => part !== '').join(', ');
    }
    default:
      return '';
  }
}
