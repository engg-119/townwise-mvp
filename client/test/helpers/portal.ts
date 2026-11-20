import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions, type StreamOptions } from '../../src/api/client';
import type {
  Access, AccessRequest, Invitation, LocationSummary, MeResponse, OrgResponse, ViewAs,
} from '../../src/portal/schemas';

// Fixtures in the API's real shapes (api/src/handlers/me.ts, locations.ts) and a fake ApiClient for the portal:
// GET /api/me, /api/org and the console's pending count answer from mutable fields, every POST answers from
// `answers` (any other GET from `answers['GET {path}']`), and anything else goes to `fallback` (the tuning chat's fake)
// or answers 404.

export const EMAIL = ['a', 'example.com'].join('@');
export const STAFF_EMAIL = ['staff', 'example.com'].join('@');
export const ADMIN_EMAIL = ['owner', 'example.com'].join('@');
export const TARGET_EMAIL = ['gm', 'example.org'].join('@');

export const REQUEST: AccessRequest = {
  id: 'r1', orgName: 'Sample Mountain Tavern', contactName: 'Pat', contactRole: 'Owner',
  town: { townId: 'stowe-vt', name: 'Stowe', state: 'VT' }, locationCount: 3, note: 'Two bars and a cafe.',
  status: 'pending', createdAt: '2026-10-02T15:00:00.000Z', decidedAt: null, decisionMessage: null,
};

export const INVITE: Invitation = {
  inviteId: 'i1', orgName: 'Sample Restaurant Group', role: 'member', invitedBy: { staff: false, email: ADMIN_EMAIL },
};

export const SECOND_INVITE: Invitation = {
  inviteId: 'i2', orgName: 'Sample Ski Bar', role: 'org_admin', invitedBy: { staff: true, email: null },
};

export const ORG_REF = { id: 'o1', name: 'Test Group' };

export const ACCESS = {
  staff: { state: 'staff' },
  staffSetup: { state: 'staff_setup_required' },
  staffReauth: { state: 'staff_reauth_required', reason: 'session_too_old' },
  member: { state: 'member', org: ORG_REF, role: 'member' },
  admin: { state: 'member', org: ORG_REF, role: 'org_admin' },
  invited: { state: 'invited', invitations: [INVITE], pendingRequest: null },
  pending: { state: 'pending', request: REQUEST },
  rejected: {
    state: 'rejected',
    request: { ...REQUEST, status: 'rejected', decidedAt: '2026-10-05T15:00:00.000Z', decisionMessage: 'We need a website first.' },
  },
  removed: { state: 'removed', org: { name: 'Sample Restaurant Group' }, removedAt: '2026-10-06T15:00:00.000Z', byYou: false },
  suspended: { state: 'org_suspended', org: { name: 'Sample Restaurant Group' } },
  noOrg: { state: 'no_org' },
} as const satisfies Record<string, Access>;

export const VERIFIED_UNTIL = '2026-11-04T19:30:00.000Z';

export function meOf(access: Access, extra?: Partial<MeResponse>): MeResponse {
  return { user: { id: 'u1', email: EMAIL }, access, viewAs: null, staff: null, ...extra };
}

export function staffMe(access: Access = ACCESS.staff): MeResponse {
  return meOf(access, { user: { id: 's1', email: STAFF_EMAIL }, staff: { verifiedUntil: VERIFIED_UNTIL } });
}

/** Staff viewing as a target with this access. */
export function viewAsMe(access: Access, endsAt = '2026-11-04T19:00:00.000Z'): MeResponse {
  const member = access.state === 'member' ? access : null;
  const viewAs: ViewAs = {
    id: 'g1', target: { userId: 't1', email: TARGET_EMAIL }, org: member?.org ?? null, role: member?.role ?? null,
    reason: 'Helping with a question.', startedAt: '2026-11-04T18:30:00.000Z', endsAt,
  };
  return meOf(access, { user: { id: 's1', email: STAFF_EMAIL }, viewAs, staff: { verifiedUntil: VERIFIED_UNTIL } });
}

/** Staff open as the admin of an organization nobody has joined (D25). */
export function openAsAdminMe(): MeResponse {
  return meOf(ACCESS.admin, {
    user: { id: 's1', email: STAFF_EMAIL }, staff: { verifiedUntil: VERIFIED_UNTIL },
    openAsAdmin: { id: 'g2', org: ORG_REF, startedAt: '2026-11-04T18:30:00.000Z' },
  });
}

const NO_COVERAGE = { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 };

export function locationOf(id: string, name: string, town: LocationSummary['town'], extra?: Partial<LocationSummary>): LocationSummary {
  return {
    id, name, town, coverage: NO_COVERAGE, calibration: { state: 'no_sales_data', updating: null }, notesCount: 0, lastUploadAt: null, ...extra,
  };
}

export const LOCATIONS: LocationSummary[] = [
  locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, {
    coverage: { dayCount: 400, guestsDayCount: 400, netSalesDayCount: 380, firstDate: '2025-01-01', lastDate: '2026-02-04', missingDays: 0 },
    calibration: { state: 'not_calibrated', dayCount: 400, firstDate: '2025-01-01', lastDate: '2026-02-04', updating: null, lastRun: null },
    notesCount: 2,
  }),
  locationOf('l2', 'River Grill', { townId: null, name: 'Norwich', state: 'VT' }),
];

export function orgOf(role: 'member' | 'org_admin', locations: LocationSummary[] = LOCATIONS, requestedLocationCount: number | null = null): OrgResponse {
  return { org: ORG_REF, role, locations, requestedLocationCount };
}

export interface Call { method: string; path: string; body: unknown }

export interface FakePortalApi extends ApiClient {
  me: MeResponse | ApiError;
  org: OrgResponse | ApiError;
  pendingCount: number;
  /** Answers for writes, by path, and for other GETs, by `GET {path}`: the response body, an ApiError to throw, or a promise of either. */
  answers: Record<string, (body: unknown) => unknown>;
  calls: Call[];
  fallback: ApiClient | null;
}

export function refusal(status: number, code: string | null, retryAfterSeconds?: number): ApiError {
  return new ApiError('http', 'The request was refused.', { status, code, retryAfterSeconds: retryAfterSeconds ?? null });
}

export function offline(): ApiError {
  return new ApiError('network', 'The network request failed.');
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  return schema.parse(resolved);
}

export function fakePortalApi(init: { me: MeResponse | ApiError; org?: OrgResponse | ApiError; fallback?: ApiClient }): FakePortalApi {
  const api: FakePortalApi = {
    me: init.me,
    org: init.org ?? orgOf('member'),
    pendingCount: 2,
    answers: {},
    calls: [],
    fallback: init.fallback ?? null,
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      api.calls.push({ method, path, body: opts?.body });
      if (method === 'GET' && path === '/api/me') return settle(api.me, schema);
      if (method === 'GET' && path === '/api/org') return settle(api.org, schema);
      if (method === 'GET' && path === '/api/admin/requests?status=pending') return settle({ requests: [], pendingCount: api.pendingCount }, schema);
      const answer = api.answers[method === 'GET' ? `GET ${path}` : path];
      if (answer !== undefined) return settle(answer(opts?.body), schema);
      if (api.fallback !== null) return api.fallback.json(path, schema, opts);
      return Promise.reject(refusal(404, 'not_found'));
    },
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      api.calls.push({ method: opts?.method ?? 'GET', path, body: opts?.body });
      if (api.fallback !== null) return api.fallback.request(path, opts);
      return Promise.reject(refusal(404, 'not_found'));
    },
    stream(path: `/${string}`, opts: StreamOptions): Promise<void> {
      if (api.fallback !== null) return api.fallback.stream(path, opts);
      return Promise.reject(refusal(404, 'not_found'));
    },
    logout: () => Promise.resolve(),
  };
  return api;
}

/** The writes the portal sent, in order, without the GETs. */
export function writes(api: FakePortalApi): Call[] {
  return api.calls.filter((call) => call.method !== 'GET');
}

/** A promise the test settles later, for answers that should still be running. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
