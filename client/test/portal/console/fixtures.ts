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


interface Zeros { uploads: number; notes: number; townwiseAi: number; orders: number; team: number }
const NO_ACTIONS: Zeros = { uploads: 0, notes: 0, townwiseAi: 0, orders: 0, team: 0 };

/** One organization's row of GET /api/admin/overview, with one location and a published run. */
export function overviewOrg(id: string, name: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    id, name, status: 'active', inSetup: false, lastActiveDay: '2026-11-16', activePeople: 2, actions: 14,
    salesDayCount: 400, lastUploadAt: '2026-11-10T15:00:00.000Z', forecastsOn: true,
    chat: { spentMicroUsd: 4_100_000, budgetMicroUsd: 20_000_000 },
    locations: [{
      id: `${id}-l1`, name: 'Hanover', newestRun: { dataThrough: '2026-11-08', madeAt: '2026-11-09T08:00:00.000Z', engine: 'model' },
      accuracy: { days: 21, inRange: 17, typicalErrorPct: 12.4 }, refresh: { week: '2026-11-16', outcome: 'started' }, lastScheduled: 'succeeded',
    }],
    ...extra,
  };
}

/**
 * GET /api/admin/overview?days=<days> in the API's shape (api/src/handlers/overview.ts), the window ending Nov 17, 2026: the
 * series has one day per window day, the last two with activity.
 */
export function overviewAnswer(days = 28, extra?: Record<string, unknown>): Record<string, unknown> {
  const end = Date.UTC(2026, 10, 17);
  const day = (offset: number): string => new Date(end - offset * 86_400_000).toISOString().slice(0, 10);
  const series = Array.from({ length: days }, (_, index) => {
    const offset = days - 1 - index;
    if (offset === 0) return { day: day(0), activePeople: 3, actions: { ...NO_ACTIONS, uploads: 2, townwiseAi: 1 } };
    if (offset === 1) return { day: day(1), activePeople: 5, actions: { ...NO_ACTIONS, notes: 4, orders: 1, team: 1 } };
    return { day: day(offset), activePeople: 0, actions: NO_ACTIONS };
  });
  return {
    window: { days, from: day(days - 1), to: day(0), previousFrom: day(2 * days - 1), previousTo: day(days) },
    recordingSince: '2026-06-01',
    totals: {
      activeOrgs: { count: 4, previous: 3, of: 6 },
      activePeople: { count: 9, previous: 6, of: 14 },
      chatTurns: { count: 12, previous: 12 },
      salesUploads: { count: 3, previous: 5 },
      notesWritten: { count: 7, previous: 2 },
      orderDecisions: { count: 1, previous: 0 },
    },
    series,
    schedule: { running: true, paused: null },
    orgs: [overviewOrg('o1', 'Sample Mountain Tavern'), overviewOrg('o2', 'Sample Campus Pub', { actions: 3, activePeople: 1 })],
    attention: [],
    ...extra,
  };
}
