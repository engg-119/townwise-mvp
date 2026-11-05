import type { z } from 'zod';

import { ApiError } from '../../../src/api/client';
import type { StaffActivity } from '../../../src/portal/settings/api';
import type { MemberView } from '../../../src/portal/team/api';
import { jsonResponse } from '../../helpers/fakes';
import { EMAIL, refusal, type FakePortalApi } from '../../helpers/portal';

// Team and Settings fixtures in the API's real shapes (api/src/handlers/team.ts, org.ts, audit.ts), and the reads
// and DELETEs the shared fake does not answer: GET /api/org/members, GET /api/org/staff-activity, and the
// `api.request` calls (DELETE /api/org/members/:id, the kit's POST /auth/logout-all). Writes through `api.json`
// still answer from `api.answers`.

export const YOU: MemberView = {
  id: 'm1', email: EMAIL, role: 'org_admin', status: 'active', invitedAt: '2026-09-01T15:00:00.000Z',
  joinedAt: '2026-09-02T15:00:00.000Z', isYou: true, addedByStaff: false,
};

export const MANAGER: MemberView = {
  id: 'm2', email: 'manager@example.com', role: 'member', status: 'active', invitedAt: '2026-09-03T15:00:00.000Z',
  joinedAt: '2026-09-04T15:00:00.000Z', isYou: false, addedByStaff: true,
};

export const CHEF: MemberView = {
  id: 'm3', email: 'chef@example.com', role: 'member', status: 'invited', invitedAt: '2026-09-05T15:00:00.000Z',
  joinedAt: null, isYou: false, addedByStaff: false,
};

export const PARTNER: MemberView = {
  id: 'm4', email: 'partner@example.com', role: 'org_admin', status: 'active', invitedAt: '2026-09-06T15:00:00.000Z',
  joinedAt: '2026-09-07T15:00:00.000Z', isYou: false, addedByStaff: false,
};

export const TEAM: MemberView[] = [YOU, MANAGER, CHEF, PARTNER];

export const VIEW_AS_EVENT: StaffActivity = {
  at: '2026-10-20T15:05:00.000Z', staffEmail: 'staff@example.com', summary: 'Started viewing as owner@example.com',
  viewAs: { targetEmail: 'owner@example.com', reason: 'Checking an upload question.', endsAt: '2026-10-20T15:35:00.000Z' },
  notApplied: false,
};

export const ADD_EVENT: StaffActivity = {
  at: '2026-10-19T15:00:00.000Z', staffEmail: 'staff@example.com', summary: 'Added manager@example.com as member',
  viewAs: null, notApplied: false,
};

export const REFUSED_EVENT: StaffActivity = {
  at: '2026-10-18T15:00:00.000Z', staffEmail: 'staff@example.com', summary: 'Changed owner@example.com from admin to member',
  viewAs: null, notApplied: true,
};

type Answer = () => unknown;

export interface Routes {
  /** GET answers by path: the body, an ApiError to throw, or a promise of either. */
  gets: Record<string, Answer>;
  /** `api.request` answers by "METHOD path": a Response, an ApiError to throw, or a promise of either. */
  requests: Record<string, Answer>;
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  return schema.parse(resolved);
}

async function respond(value: unknown): Promise<Response> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  return resolved as Response;
}

/** Adds GET and `request` routes to the shared fake. Every call is still recorded in `api.calls`. */
export function withRoutes(api: FakePortalApi, init?: Partial<Routes>): Routes {
  const routes: Routes = { gets: { ...init?.gets }, requests: { ...init?.requests } };
  const json = api.json.bind(api);
  api.json = (path, schema, opts) => {
    const get = routes.gets[path];
    if ((opts?.method ?? 'GET') === 'GET' && get !== undefined) {
      api.calls.push({ method: 'GET', path, body: undefined });
      return settle(get(), schema);
    }
    return json(path, schema, opts);
  };
  api.request = (path, opts) => {
    const method = opts?.method ?? 'GET';
    api.calls.push({ method, path, body: opts?.body });
    const answer = routes.requests[`${method} ${path}`];
    return answer === undefined ? Promise.reject(refusal(404, 'not_found')) : respond(answer());
  };
  return routes;
}

export function noContent(): Response {
  return jsonResponse(204);
}
