// TOWNWISE_ROUTES and mountTownwiseRoutes(): every /api route, and the one chain each of them runs (spec 7.2).
import { authOf } from '@ckeith26/auth';
import { createRateLimiter, rateLimit } from '@ckeith26/rate-limit';
import { AppError, ConfigError } from '@ckeith26/server-core';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';

import type { TownwiseContext } from '../app.ts';
import {
  addOrgMembers, approveRequest, changeOrgMemberRole, createOrg, getOrg, listOrgs, listPeople, listRequests, lookupPerson,
  queryAudit, rejectRequest, removeOrgMember, signOutEverywhere, updateOrg,
} from '../handlers/admin.ts';
import { getLocationCalendar } from '../handlers/calendar.ts';
import { deleteConversation, getChat, getConversation, postTurn } from '../handlers/chat.ts';
import { actOnProposal } from '../handlers/chat-proposals.ts';
import { deleteOrg, deletePerson } from '../handlers/deletion.ts';
import { getEstimatesAbout, getForecast, getPeopleInTown } from '../handlers/estimates.ts';
import { deleteForecastRun, importForecastRun, listForecastRuns, publishForecastRun, withdrawForecastRun } from '../handlers/forecast-runs.ts';
import {
  answerImport, completeFile, createFile, currentImport, deleteFile, deleteRaw, downloadClean, downloadRaw, getFile, getImport,
  listFiles, putChunk, startImport,
} from '../handlers/files.ts';
import { createLocation, deleteLocation, getOwnOrg, updateLocation } from '../handlers/locations.ts';
import { declineInvite, getMe, joinInvite, recordWelcome } from '../handlers/me.ts';
import { createNote, deleteNote, listNotes, updateNote } from '../handlers/notes.ts';
import { getStaffActivity, leaveOrg, renameOrg } from '../handlers/org.ts';
import { placesAutocomplete, placesDetails } from '../handlers/places.ts';
import { createAccessRequest } from '../handlers/requests.ts';
import { deleteSales, getSales, getSalesDays, getSalesHistory, uploadSales } from '../handlers/sales.ts';
import { addMembers, changeRole, listMembers, removeMember } from '../handlers/team.ts';
import { getTownProfile } from '../handlers/towns.ts';
import { endViewAs, startViewAs } from '../handlers/view-as.ts';
import { policyRefusal, principalOf, recordResolution, viewAsRefusal, type Policy, type Principal } from './policy.ts';
import { resolveAccess } from './resolve.ts';

export interface TownwiseRoute {
  readonly id: string;
  /** PUT only with bodyLimit 'stream'. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Under /api. */
  readonly path: `/${string}`;
  readonly policy: Policy;
  /**
   * 'none' for GET and DELETE; '2kb' on the Places and files JSON routes; '8kb' on a TownwiseAI proposal; '256kb' only
   * on the upload route and (U13B) the staff forecast import; 'stream' only on the chunk route, whose handler reads the
   * raw body itself after the policy has passed.
   */
  readonly bodyLimit: 'none' | '2kb' | '8kb' | '32kb' | '256kb' | 'stream';
  /** 'writes' applies to every non-GET automatically, before access is resolved. */
  readonly limiter?: 'uploads' | 'requests' | 'view-as' | 'chat' | 'places' | 'files' | 'file_chunks' | 'downloads';
  readonly handler: (ctx: TownwiseContext, req: Request, res: Response, principal: Principal) => Promise<void>;
}

export const TOWNWISE_ROUTES: readonly TownwiseRoute[] = [
  { id: 'me.get', method: 'GET', path: '/me', policy: 'signed_in', bodyLimit: 'none', handler: getMe },
  { id: 'me.join', method: 'POST', path: '/me/join', policy: 'signed_in', bodyLimit: '32kb', handler: joinInvite },
  { id: 'me.decline', method: 'POST', path: '/me/decline', policy: 'signed_in', bodyLimit: '32kb', handler: declineInvite },
  // U11, statement moments: no body, so none is parsed; the writes limiter only.
  { id: 'me.welcome', method: 'POST', path: '/me/welcome', policy: 'member', bodyLimit: 'none', handler: recordWelcome },
  {
    id: 'requests.create', method: 'POST', path: '/access-requests', policy: 'signed_in', bodyLimit: '32kb',
    limiter: 'requests', handler: createAccessRequest,
  },
  { id: 'towns.get', method: 'GET', path: '/towns/:townId', policy: 'signed_in', bodyLimit: 'none', handler: getTownProfile },
  {
    id: 'places.autocomplete', method: 'POST', path: '/places/autocomplete', policy: 'signed_in', bodyLimit: '2kb',
    limiter: 'places', handler: placesAutocomplete,
  },
  {
    id: 'places.details', method: 'POST', path: '/places/details', policy: 'signed_in', bodyLimit: '2kb',
    limiter: 'places', handler: placesDetails,
  },

  { id: 'org.get', method: 'GET', path: '/org', policy: 'member', bodyLimit: 'none', handler: getOwnOrg },
  { id: 'org.update', method: 'PATCH', path: '/org', policy: 'org_admin', bodyLimit: '32kb', handler: renameOrg },
  {
    id: 'org.staff_activity', method: 'GET', path: '/org/staff-activity', policy: 'org_admin', bodyLimit: 'none',
    handler: getStaffActivity,
  },
  { id: 'org.leave', method: 'POST', path: '/org/leave', policy: 'member', bodyLimit: '32kb', handler: leaveOrg },
  {
    id: 'org.locations.create', method: 'POST', path: '/org/locations', policy: 'org_admin', bodyLimit: '32kb',
    handler: createLocation,
  },
  {
    id: 'org.locations.update', method: 'PATCH', path: '/org/locations/:locationId', policy: 'org_admin', bodyLimit: '32kb',
    handler: updateLocation,
  },
  {
    id: 'org.locations.remove', method: 'DELETE', path: '/org/locations/:locationId', policy: 'org_admin', bodyLimit: 'none',
    handler: deleteLocation,
  },
  {
    id: 'org.sales.get', method: 'GET', path: '/org/locations/:locationId/sales', policy: 'member', bodyLimit: 'none',
    handler: getSales,
  },
  {
    id: 'org.sales.days', method: 'GET', path: '/org/locations/:locationId/sales/days', policy: 'member', bodyLimit: 'none',
    handler: getSalesDays,
  },
  // Spec 10.10: sales history and the town calendar.
  {
    id: 'org.sales.history', method: 'GET', path: '/org/locations/:locationId/sales/history', policy: 'member',
    bodyLimit: 'none', handler: getSalesHistory,
  },
  {
    id: 'org.calendar.get', method: 'GET', path: '/org/locations/:locationId/calendar', policy: 'member', bodyLimit: 'none',
    handler: getLocationCalendar,
  },
  {
    id: 'org.sales.upload', method: 'POST', path: '/org/locations/:locationId/sales/uploads', policy: 'member',
    bodyLimit: '256kb', limiter: 'uploads', handler: uploadSales,
  },
  {
    id: 'org.sales.remove', method: 'DELETE', path: '/org/locations/:locationId/sales', policy: 'org_admin', bodyLimit: 'none',
    handler: deleteSales,
  },
  {
    id: 'org.notes.list', method: 'GET', path: '/org/locations/:locationId/notes', policy: 'member', bodyLimit: 'none',
    handler: listNotes,
  },
  {
    id: 'org.notes.create', method: 'POST', path: '/org/locations/:locationId/notes', policy: 'member', bodyLimit: '32kb',
    handler: createNote,
  },
  {
    id: 'org.notes.update', method: 'PATCH', path: '/org/locations/:locationId/notes/:noteId', policy: 'member',
    bodyLimit: '32kb', handler: updateNote,
  },
  {
    id: 'org.notes.remove', method: 'DELETE', path: '/org/locations/:locationId/notes/:noteId', policy: 'member',
    bodyLimit: 'none', handler: deleteNote,
  },
  // Stored files and imports (spec 10.11, 11A). imports/current is declared before imports/:importId.
  {
    id: 'org.files.create', method: 'POST', path: '/org/locations/:locationId/files', policy: 'member', bodyLimit: '2kb',
    limiter: 'files', handler: createFile,
  },
  {
    id: 'org.files.chunk', method: 'PUT', path: '/org/locations/:locationId/files/:fileId/chunks/:index', policy: 'member',
    bodyLimit: 'stream', limiter: 'file_chunks', handler: putChunk,
  },
  {
    id: 'org.files.complete', method: 'POST', path: '/org/locations/:locationId/files/:fileId/complete', policy: 'member',
    bodyLimit: '2kb', handler: completeFile,
  },
  { id: 'org.files.list', method: 'GET', path: '/org/locations/:locationId/files', policy: 'member', bodyLimit: 'none', handler: listFiles },
  {
    id: 'org.files.get', method: 'GET', path: '/org/locations/:locationId/files/:fileId', policy: 'member', bodyLimit: 'none',
    handler: getFile,
  },
  {
    id: 'org.files.raw', method: 'GET', path: '/org/locations/:locationId/files/:fileId/raw', policy: 'member', bodyLimit: 'none',
    limiter: 'downloads', handler: downloadRaw,
  },
  {
    id: 'org.files.clean', method: 'GET', path: '/org/locations/:locationId/files/:fileId/clean', policy: 'member',
    bodyLimit: 'none', limiter: 'downloads', handler: downloadClean,
  },
  {
    id: 'org.files.remove_raw', method: 'DELETE', path: '/org/locations/:locationId/files/:fileId/raw', policy: 'member',
    bodyLimit: 'none', handler: deleteRaw,
  },
  {
    id: 'org.files.remove', method: 'DELETE', path: '/org/locations/:locationId/files/:fileId', policy: 'member',
    bodyLimit: 'none', handler: deleteFile,
  },
  {
    id: 'org.imports.current', method: 'GET', path: '/org/locations/:locationId/imports/current', policy: 'member',
    bodyLimit: 'none', handler: currentImport,
  },
  {
    id: 'org.imports.get', method: 'GET', path: '/org/locations/:locationId/imports/:importId', policy: 'member',
    bodyLimit: 'none', handler: getImport,
  },
  {
    id: 'org.imports.start', method: 'POST', path: '/org/locations/:locationId/imports/:importId/start', policy: 'member',
    bodyLimit: '2kb', handler: startImport,
  },
  {
    id: 'org.imports.answer', method: 'POST', path: '/org/locations/:locationId/imports/:importId/answer', policy: 'member',
    bodyLimit: '2kb', handler: answerImport,
  },
  { id: 'org.chat.get', method: 'GET', path: '/org/locations/:locationId/chat', policy: 'member', bodyLimit: 'none', handler: getChat },
  {
    id: 'org.chat.conversation', method: 'GET', path: '/org/locations/:locationId/chat/:conversationId', policy: 'member',
    bodyLimit: 'none', handler: getConversation,
  },
  {
    id: 'org.chat.turn', method: 'POST', path: '/org/locations/:locationId/chat/turns', policy: 'member', bodyLimit: '32kb',
    limiter: 'chat', handler: postTurn,
  },
  {
    id: 'org.chat.remove', method: 'DELETE', path: '/org/locations/:locationId/chat/:conversationId', policy: 'member',
    bodyLimit: 'none', handler: deleteConversation,
  },
  // U9 (TownwiseAI): saving or setting aside a proposed note.
  {
    id: 'org.chat.proposal', method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/proposals/:proposalId',
    policy: 'member', bodyLimit: '8kb', handler: actOnProposal,
  },
  // U13A, estimates (spec 10.13): people in town and "How Townwise estimates". Reads with no limiter.
  {
    id: 'org.people.get', method: 'GET', path: '/org/locations/:locationId/people-in-town', policy: 'member',
    bodyLimit: 'none', handler: getPeopleInTown,
  },
  {
    id: 'org.estimates.about', method: 'GET', path: '/org/locations/:locationId/estimates/about', policy: 'member',
    bodyLimit: 'none', handler: getEstimatesAbout,
  },
  // U13B, forecast runs (spec 10.13, 14.4): the published forecast, a member read with no limiter.
  {
    id: 'org.forecast.get', method: 'GET', path: '/org/locations/:locationId/forecast', policy: 'member', bodyLimit: 'none',
    handler: getForecast,
  },

  { id: 'org.members.list', method: 'GET', path: '/org/members', policy: 'org_admin', bodyLimit: 'none', handler: listMembers },
  { id: 'org.members.add', method: 'POST', path: '/org/members', policy: 'org_admin', bodyLimit: '32kb', handler: addMembers },
  {
    id: 'org.members.update', method: 'PATCH', path: '/org/members/:memberId', policy: 'org_admin', bodyLimit: '32kb',
    handler: changeRole,
  },
  {
    id: 'org.members.remove', method: 'DELETE', path: '/org/members/:memberId', policy: 'org_admin', bodyLimit: 'none',
    handler: removeMember,
  },

  { id: 'admin.requests.list', method: 'GET', path: '/admin/requests', policy: 'staff', bodyLimit: 'none', handler: listRequests },
  {
    id: 'admin.requests.approve', method: 'POST', path: '/admin/requests/:requestId/approve', policy: 'staff',
    bodyLimit: '32kb', handler: approveRequest,
  },
  {
    id: 'admin.requests.reject', method: 'POST', path: '/admin/requests/:requestId/reject', policy: 'staff',
    bodyLimit: '32kb', handler: rejectRequest,
  },
  { id: 'admin.orgs.list', method: 'GET', path: '/admin/orgs', policy: 'staff', bodyLimit: 'none', handler: listOrgs },
  { id: 'admin.orgs.create', method: 'POST', path: '/admin/orgs', policy: 'staff', bodyLimit: '32kb', handler: createOrg },
  { id: 'admin.orgs.get', method: 'GET', path: '/admin/orgs/:orgId', policy: 'staff', bodyLimit: 'none', handler: getOrg },
  { id: 'admin.orgs.update', method: 'PATCH', path: '/admin/orgs/:orgId', policy: 'staff', bodyLimit: '32kb', handler: updateOrg },
  { id: 'admin.orgs.remove', method: 'DELETE', path: '/admin/orgs/:orgId', policy: 'staff', bodyLimit: 'none', handler: deleteOrg },
  {
    id: 'admin.orgs.members.add', method: 'POST', path: '/admin/orgs/:orgId/members', policy: 'staff', bodyLimit: '32kb',
    handler: addOrgMembers,
  },
  {
    id: 'admin.orgs.members.update', method: 'PATCH', path: '/admin/orgs/:orgId/members/:memberId', policy: 'staff',
    bodyLimit: '32kb', handler: changeOrgMemberRole,
  },
  {
    id: 'admin.orgs.members.remove', method: 'DELETE', path: '/admin/orgs/:orgId/members/:memberId', policy: 'staff',
    bodyLimit: 'none', handler: removeOrgMember,
  },
  // U13B, forecast runs from the staff console (spec 10.13, 14.4): import as a draft, publish, withdraw, delete.
  {
    id: 'admin.forecasts.list', method: 'GET', path: '/admin/orgs/:orgId/forecast-runs', policy: 'staff', bodyLimit: 'none',
    handler: listForecastRuns,
  },
  {
    id: 'admin.forecasts.import', method: 'POST', path: '/admin/orgs/:orgId/locations/:locationId/forecast-runs', policy: 'staff',
    bodyLimit: '256kb', handler: importForecastRun,
  },
  {
    id: 'admin.forecasts.publish', method: 'POST', path: '/admin/orgs/:orgId/forecast-runs/:runId/publish', policy: 'staff',
    bodyLimit: '32kb', handler: publishForecastRun,
  },
  {
    id: 'admin.forecasts.withdraw', method: 'POST', path: '/admin/orgs/:orgId/forecast-runs/:runId/withdraw', policy: 'staff',
    bodyLimit: '32kb', handler: withdrawForecastRun,
  },
  {
    id: 'admin.forecasts.remove', method: 'DELETE', path: '/admin/orgs/:orgId/forecast-runs/:runId', policy: 'staff',
    bodyLimit: 'none', handler: deleteForecastRun,
  },
  { id: 'admin.people.list', method: 'GET', path: '/admin/people', policy: 'staff', bodyLimit: 'none', handler: listPeople },
  {
    id: 'admin.people.lookup', method: 'GET', path: '/admin/people/lookup', policy: 'staff', bodyLimit: 'none',
    handler: lookupPerson,
  },
  {
    id: 'admin.people.sign_out_everywhere', method: 'POST', path: '/admin/people/:userId/sign-out-everywhere', policy: 'staff',
    bodyLimit: '32kb', handler: signOutEverywhere,
  },
  { id: 'admin.people.delete', method: 'POST', path: '/admin/people/delete', policy: 'staff', bodyLimit: '32kb', handler: deletePerson },
  { id: 'admin.audit.list', method: 'GET', path: '/admin/audit', policy: 'staff', bodyLimit: 'none', handler: queryAudit },
  {
    id: 'admin.view_as.start', method: 'POST', path: '/admin/view-as', policy: 'staff', bodyLimit: '32kb',
    limiter: 'view-as', handler: startViewAs,
  },
  {
    id: 'admin.view_as.end', method: 'POST', path: '/admin/view-as/end', policy: 'staff_self', bodyLimit: '32kb',
    handler: endViewAs,
  },
];

/** The only route that may use staff_self. */
const VIEW_AS_END = { method: 'POST', path: '/admin/view-as/end' } as const;

/** Spec 10.8. [CONFIRM: limits] */
const WRITES_LIMIT = { name: 'townwise:writes', limit: 300, windowSeconds: 600 } as const;
const ROUTE_LIMITS = {
  uploads: { name: 'townwise:uploads', limit: 30, windowSeconds: 3600, whenStoreDown: 'allow' },
  requests: { name: 'townwise:requests', limit: 5, windowSeconds: 86400, whenStoreDown: 'deny' },
  'view-as': { name: 'townwise:view-as', limit: 20, windowSeconds: 3600, whenStoreDown: 'deny' },
  // docs/portal/tuning-chat.md section 2: every turn costs money, so a store outage denies.
  chat: { name: 'townwise:chat', limit: 60, windowSeconds: 3600, whenStoreDown: 'deny' },
  // Both Places routes share it. A search is 10 to 15 debounced autocompletes and one details call, so this is about
  // 20 searches an hour; every call costs money, so a store outage denies.
  places: { name: 'townwise:places', limit: 300, windowSeconds: 3600, whenStoreDown: 'deny' },
  // Stored files (spec 10.8). The daily byte cap, not these, bounds the volume; an outage allows.
  files: { name: 'townwise:files', limit: 120, windowSeconds: 3600, whenStoreDown: 'allow' },
  file_chunks: { name: 'townwise:file-chunks', limit: 1500, windowSeconds: 3600, whenStoreDown: 'allow' },
  downloads: { name: 'townwise:downloads', limit: 300, windowSeconds: 3600, whenStoreDown: 'allow' },
} as const;

/** The only route that may stream its body. */
const STREAM_ROUTE = 'org.files.chunk';

/**
 * Boot refuses a duplicate method and path, a GET with a body limit, staff_self on any other route, a PUT without a
 * streamed body, and a streamed body on any route but the chunk route.
 */
export function assertRouteTable(routes: readonly TownwiseRoute[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new ConfigError('routes', `${key} is declared twice`);
    seen.add(key);
    if (route.method === 'GET' && route.bodyLimit !== 'none') {
      throw new ConfigError('routes', `${route.id} is a GET with a body limit`);
    }
    if (route.policy === 'staff_self' && (route.method !== VIEW_AS_END.method || route.path !== VIEW_AS_END.path)) {
      throw new ConfigError('routes', `${route.id} uses staff_self, which only POST /admin/view-as/end may use`);
    }
    if (route.method === 'PUT' && route.bodyLimit !== 'stream') throw new ConfigError('routes', `${route.id} is a PUT without a streamed body`);
    if (route.bodyLimit === 'stream' && (route.id !== STREAM_ROUTE || route.method !== 'PUT')) {
      throw new ConfigError('routes', `${route.id} streams its body, which only ${STREAM_ROUTE} may`);
    }
  }
}

const principals = new WeakMap<Request, Principal>();

function bound(run: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void run(req, res).then(() => { if (!res.headersSent) next(); }).catch(next);
  };
}

/** Steps 3 to 5: resolve, the view-as guard, the policy. Never reads the body. */
function authorize(ctx: TownwiseContext, route: TownwiseRoute): RequestHandler {
  return bound(async (req) => {
    const auth = authOf(req);
    const resolution = await resolveAccess(ctx, auth);
    const principal = principalOf(resolution, auth);
    const refusal = viewAsRefusal(route, principal) ?? policyRefusal(route.policy, principal);
    if (refusal !== null) {
      ctx.logger.info({ policy: route.policy, code: refusal.code }, 'townwise.access_denied');
      throw refusal;
    }
    if (principal.kind !== 'staff' && principal.viewAs !== null && route.method === 'GET') {
      ctx.logger.info({ grantId: principal.viewAs.grantId, routeId: route.id }, 'townwise.view_as_read');
    }
    principals.set(req, principal);
    recordResolution(req, resolution);
  });
}

function accountKey(req: Request): string {
  return `acct:${authOf(req).userId}`;
}

export function mountTownwiseRoutes(router: Router, routes: readonly TownwiseRoute[], ctx: TownwiseContext): void {
  assertRouteTable(routes);
  const writes = rateLimit({
    limiter: createRateLimiter({ redis: ctx.redis, ...WRITES_LIMIT }),
    key: accountKey,
    whenStoreDown: 'allow',
    logger: ctx.logger,
  });
  const routeLimiters = new Map<NonNullable<TownwiseRoute['limiter']>, RequestHandler>();
  const routeLimiter = (name: NonNullable<TownwiseRoute['limiter']>): RequestHandler => {
    const existing = routeLimiters.get(name);
    if (existing !== undefined) return existing;
    const { whenStoreDown, ...rule } = ROUTE_LIMITS[name];
    const created = rateLimit({ limiter: createRateLimiter({ redis: ctx.redis, ...rule }), key: accountKey, whenStoreDown, logger: ctx.logger });
    routeLimiters.set(name, created);
    return created;
  };

  for (const route of routes) {
    const chain: RequestHandler[] = [ctx.auth.requireAuth];
    if (route.method !== 'GET') chain.push(writes);
    chain.push(authorize(ctx, route));
    if (route.bodyLimit !== 'none' && route.bodyLimit !== 'stream') chain.push(express.json({ limit: route.bodyLimit }));
    if (route.limiter !== undefined) chain.push(routeLimiter(route.limiter));
    chain.push(bound(async (req, res) => {
      const principal = principals.get(req);
      if (principal === undefined) throw new AppError(500, 'internal', 'Internal server error');
      await route.handler(ctx, req, res, principal);
    }));
    const methods = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' } as const;
    const method = methods[route.method];
    router[method](route.path, ...chain);
  }
}
