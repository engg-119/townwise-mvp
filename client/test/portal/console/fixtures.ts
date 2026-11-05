import type { AdminRequest, AuditEvent, Member, OrgDetail, OrgRow, Person } from '../../../src/portal/console/schemas';
import { REQUEST } from '../../helpers/portal';

// Staff console fixtures in the API's shapes (api/src/handlers/admin.ts, team.ts, audit.ts), with no app imports,
// so pure tests can use them on both platforms.

export function emailOf(name: string, domain = 'example.com'): string {
  return [name, domain].join('@');
}

export const REQUESTER_EMAIL = emailOf('pat', 'example.org');

export function adminRequest(extra?: Partial<AdminRequest>): AdminRequest {
  return {
    ...REQUEST,
    requester: { userId: 'u9', email: REQUESTER_EMAIL },
    emailAtRequest: REQUESTER_EMAIL,
    requesterHasOrg: false,
    decidedBy: null,
    orgId: null,
    ...extra,
  };
}

export function orgRow(id: string, name: string, extra?: Partial<OrgRow>): OrgRow {
  return {
    id, name, status: 'active', createdAt: '2026-09-01T15:00:00.000Z', adminCount: 1, memberCount: 3, inviteCount: 1,
    locationCount: 2, salesDayCount: 400, lastUploadAt: '2026-10-01T15:00:00.000Z', ...extra,
  };
}

export const OWNER_EMAIL = emailOf('owner');
export const MANAGER_EMAIL = emailOf('manager');
export const CHEF_EMAIL = emailOf('chef');

export function member(id: string, email: string, extra?: Partial<Member>): Member {
  return {
    id, email, role: 'member', status: 'active', invitedAt: '2026-09-02T15:00:00.000Z', joinedAt: '2026-09-03T15:00:00.000Z',
    isYou: false, addedByStaff: false, ...extra,
  };
}

export function auditEvent(id: string, extra?: Partial<AuditEvent>): AuditEvent {
  return {
    id, at: '2026-10-10T15:00:00.000Z', actorEmail: OWNER_EMAIL, actorRole: 'org_admin', viewAs: null, orgId: 'o1',
    orgName: 'Sample Restaurant Group', action: 'member.invited', summary: `Added ${CHEF_EMAIL} as member`,
    details: { email: CHEF_EMAIL, role: 'member' }, ...extra,
  };
}

export function orgDetail(extra?: { org?: Partial<OrgDetail['org']>; members?: Member[]; locations?: OrgDetail['locations']; recent?: AuditEvent[] }): OrgDetail {
  return {
    org: {
      id: 'o1', name: 'Sample Restaurant Group', status: 'active', createdAt: '2026-09-01T15:00:00.000Z', fromRequestId: 'r1',
      fromRequestSentAt: null, suspendedAt: null, ...extra?.org,
    },
    members: extra?.members ?? [
      member('m1', OWNER_EMAIL, { role: 'org_admin' }),
      member('m2', MANAGER_EMAIL, { addedByStaff: true }),
      member('m3', CHEF_EMAIL, { status: 'invited', joinedAt: null }),
    ],
    locations: extra?.locations ?? [{
      id: 'l1', name: 'Hanover', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
      coverage: { dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-02-04' }, notesCount: 2, lastUploadAt: '2026-02-05T15:00:00.000Z',
    }],
    recent: extra?.recent ?? [auditEvent('e1')],
  };
}

export function person(email: string, kind: Person['kind'], extra?: Partial<Person>): Person {
  return { userId: null, email, kind, org: null, since: '2026-09-03T15:00:00.000Z', staffTwoStep: null, ...extra };
}

