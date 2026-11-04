import { AppError } from '@ckeith26/server-core';

import type { TownwiseContext } from './app.ts';
import type { AuditAction, AuditDetails, AuditEventInput, AuditEventRecord } from './stores/audit-events.ts';

function logFailure(ctx: TownwiseContext, event: AuditEventInput): void {
  ctx.logger.error({ action: event.action, orgId: event.orgId, targetId: event.target.id }, 'townwise.audit_write_failed');
}

/**
 * Client actions (org members and org admins) are recorded after the effect succeeds. A failed write
 * leaves the action standing: it logs ids only, and the response is still success (spec 9.3).
 */
export async function recordAfter(ctx: TownwiseContext, event: AuditEventInput): Promise<void> {
  try {
    await ctx.stores.audit.insert(event);
  } catch {
    logFailure(ctx, event);
  }
}

/**
 * Staff actions are recorded before the effect, after the read-only checks. A failed write refuses the
 * action with 503 unavailable, so nothing changes (spec 9.3). Resolves the event id.
 */
export async function recordBefore(ctx: TownwiseContext, event: AuditEventInput): Promise<string> {
  try {
    return await ctx.stores.audit.insert(event);
  } catch {
    logFailure(ctx, event);
    throw new AppError(503, 'unavailable', 'Service temporarily unavailable');
  }
}

/** The staff action recorded as `event` (id `eventId`) did not take effect, so the record never claims it did. */
export async function recordNotApplied(ctx: TownwiseContext, event: AuditEventInput, eventId: string, code: string): Promise<void> {
  await recordAfter(ctx, {
    at: ctx.now(),
    actorUserId: event.actorUserId,
    actorEmail: event.actorEmail,
    actorRole: event.actorRole,
    viewAsGrantId: event.viewAsGrantId,
    orgId: event.orgId,
    action: 'staff_action.not_applied',
    target: event.target,
    details: { eventId, code },
  });
}

/** Spec 10.7: what the staff audit log and an organization's recent activity show for one event. */
export interface AuditEventView {
  id: string; at: string; actorEmail: string; actorRole: string;
  viewAs: { targetEmail: string } | null;
  orgId: string | null; orgName: string | null; action: string;
  /** Built on the server from the action and its allowlisted details. */
  summary: string;
  details: AuditDetails;
}

function text(value: AuditDetails[string] | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}

function roleWord(value: AuditDetails[string] | undefined): string {
  return value === 'org_admin' ? 'admin' : text(value);
}

const NOTE_KINDS: Readonly<Record<string, string>> = {
  closure: 'closure', private_event: 'private event', opening: 'opening', other: 'other',
};

function noteSummary(verb: string, d: AuditDetails): string {
  return `${verb} a note (${NOTE_KINDS[text(d.kind)] ?? text(d.kind)}), ${text(d.startDate)} to ${text(d.endDate)}`;
}

/** The plain-words summary for an event, from its action and allowlisted details only. */
export function summaryOf(action: AuditAction, d: AuditDetails): string {
  switch (action) {
    case 'access_request.created': return `Requested access for ${text(d.orgName)} in ${text(d.townName)}`;
    case 'access_request.approved': return 'Approved an access request';
    case 'access_request.rejected': return d.hasMessage === true ? 'Rejected an access request, with a message' : 'Rejected an access request';
    case 'access_request.withdrawn': return 'Withdrew an access request on joining an organization';
    case 'org.created': return `Created ${text(d.name)}`;
    case 'org.renamed': return `Renamed ${text(d.from)} to ${text(d.to)}`;
    case 'org.suspended': return 'Suspended the organization';
    case 'org.reactivated': return 'Reactivated the organization';
    case 'org.deleted': return 'Deleted the organization';
    case 'member.invited': return `Added ${text(d.email)} as ${roleWord(d.role)}`;
    case 'member.declined': return `Declined the invitation for ${text(d.email)}`;
    case 'member.joined': return `${text(d.email)} joined as ${roleWord(d.role)}`;
    case 'member.role_changed': return `Changed ${text(d.email)} from ${roleWord(d.from)} to ${roleWord(d.to)}`;
    case 'member.removed': return d.wasStatus === 'invited' ? `Removed the invitation for ${text(d.email)}` : `Removed ${text(d.email)}`;
    case 'member.left': return `${text(d.email)} left the organization`;
    case 'location.created': return `Added the location ${text(d.name)}`;
    case 'location.updated': return `Updated the location ${text(d.name)}`;
    case 'location.deleted': return `Deleted the location ${text(d.name)}`;
    case 'sales.uploaded': return `Uploaded ${text(d.dayCount)} days of sales data, ${text(d.firstDate)} to ${text(d.lastDate)}`;
    case 'sales.deleted': return `Deleted ${text(d.deletedDays)} days of sales data`;
    case 'note.created': return noteSummary('Added', d);
    case 'note.updated': return noteSummary('Edited', d);
    case 'note.deleted': return noteSummary('Deleted', d);
    case 'view_as.started': return `Started viewing as ${text(d.targetEmail)}`;
    case 'view_as.ended':
      if (d.endReason === 'expired') return 'View-as expired';
      if (d.endReason === 'replaced') return 'View-as replaced by a new one';
      return 'Ended view-as';
    case 'people.signed_out_everywhere': return 'Signed a person out everywhere';
    case 'person.deleted': return 'Deleted a person’s Townwise records';
    case 'staff_action.not_applied': return `Didn’t take effect (${text(d.code)})`;
  }
}

/**
 * Views for a page of events: the organization's current name, “viewing as” for view-as events (from the grant's
 * view_as.started record, so a deletion's redaction holds), and “Didn’t take effect” on a staff event that a
 * staff_action.not_applied event qualifies.
 */
export async function auditEventViews(ctx: TownwiseContext, events: readonly AuditEventRecord[]): Promise<AuditEventView[]> {
  const grantIds = [...new Set(events.flatMap((event) => (event.viewAsGrantId === null ? [] : [event.viewAsGrantId])))];
  const orgIds = [...new Set(events.flatMap((event) => (event.orgId === null ? [] : [event.orgId])))];
  const [qualifiers, starts, orgs] = await Promise.all([
    ctx.stores.audit.findNotApplied(events.map((event) => event.id)),
    ctx.stores.audit.findStarted(grantIds),
    ctx.stores.orgs.findByIds(orgIds),
  ]);
  const notApplied = new Map(qualifiers.map((event) => [text(event.details.eventId), text(event.details.code)]));
  const viewedAs = new Map(starts.map((event) => [event.target.id, text(event.details.targetEmail)]));
  const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
  return events.map((event) => {
    const summary = summaryOf(event.action, event.details);
    const code = notApplied.get(event.id);
    const targetEmail = event.viewAsGrantId === null ? undefined : viewedAs.get(event.viewAsGrantId);
    return {
      id: event.id,
      at: event.at.toISOString(),
      actorEmail: event.actorEmail,
      actorRole: event.actorRole,
      viewAs: targetEmail === undefined ? null : { targetEmail },
      orgId: event.orgId,
      orgName: event.orgId === null ? null : orgNames.get(event.orgId) ?? null,
      action: event.action,
      summary: code === undefined ? summary : `${summary}. Didn’t take effect (${code}).`,
      details: { ...event.details },
    };
  });
}
