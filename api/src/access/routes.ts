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
import { answerQuestion, getAgent } from '../handlers/agent.ts';
import { listAgentChanges, switchAgentAuto, undoAgentChange } from '../handlers/agent-changes.ts';
import { getLocationCalendar } from '../handlers/calendar.ts';
import { listCalibrations, setForecastSchedule, startCalibration, switchForecasts } from '../handlers/calibrations.ts';
import { deleteConversation, getChat, getConversation, postTurn, renameConversation, showVersion } from '../handlers/chat.ts';
import { rateReply } from '../handlers/chat-feedback.ts';
import { getTurnEvents, stopTurn } from '../handlers/chat-turns.ts';
import { actOnItemProposal, getItemProposal } from '../handlers/chat-item-proposals.ts';
import { actOnOrderProposal, getOrderProposal } from '../handlers/chat-order-proposals.ts';
import { actOnProposal } from '../handlers/chat-proposals.ts';
import {
  getDataItem, listData, removeDataItem, replaceDataItem, requestAiRead, retryDataCalendar, undoAiRead, updateDataItem,
} from '../handlers/data.ts';
import { deleteOrg, deletePerson, purgeOriginals } from '../handlers/deletion.ts';
import { getEstimatesAbout, getForecast, getPeopleInTown } from '../handlers/estimates.ts';
import { deleteItemSales, getOrderSetup, saveOrderCount, saveOrderSetup, uploadItemSales } from '../handlers/order-setup.ts';
import { holdSetupReadBytes, readOrderSetup } from '../handlers/order-setup-read.ts';
import { getOrders, saveOrderDecision, saveOrderRule, turnOffOrderRule } from '../handlers/orders.ts';
import { getOverview } from '../handlers/overview.ts';
import { deleteForecastRun, getForecastRun, importForecastRun, listForecastRuns, publishForecastRun, withdrawForecastRun } from '../handlers/forecast-runs.ts';
import {
  addTextItem, answerImport, completeFile, createFile, currentImport, deleteFile, deleteLocationOriginals, deleteRaw, downloadClean, downloadRaw, getFile, getImport,
  listEntries, listFiles, putChunk, startImport,
} from '../handlers/files.ts';
import { connectGoogle, dropGoogleConnection, listGoogleChoices } from '../handlers/google-calendars.ts';
import { createLocation, deleteLocation, getOwnOrg, updateLocation } from '../handlers/locations.ts';
import { getLocationsMap } from '../handlers/locations-map.ts';
import { confirmCalendarBookings, labelCalendarBooking, sortCalendarBookings } from '../handlers/calendar-bookings.ts';
import { declineInvite, getMe, joinInvite, recordWelcome } from '../handlers/me.ts';
import { createNote, deleteNote, listNotes, updateNote } from '../handlers/notes.ts';
import { startOpenAsAdmin } from '../handlers/open-as-admin.ts';
import { getStaffActivity, leaveOrg, renameOrg } from '../handlers/org.ts';
import {
  createOwnerCalendar, listOwnerCalendarEvents, listOwnerCalendars, refreshOwnerCalendar, removeOwnerCalendar,
} from '../handlers/owner-calendars.ts';
import { placesAutocomplete, placesDetails, placesMap, placesStatus } from '../handlers/places.ts';
import { getProfile, updateProfile } from '../handlers/profile.ts';
import { createAccessRequest } from '../handlers/requests.ts';
import { acceptRuleSuggestion, dismissRuleSuggestion } from '../handlers/rule-suggestions.ts';
import { createRule, deleteRule, listRules, updateRule } from '../handlers/rules.ts';
import { deleteSales, getSales, getSalesDays, getSalesHistory, uploadSales } from '../handlers/sales.ts';
import { createSetupLocation, deleteSetupLocation, deleteSetupSales, updateSetupLocation, uploadSetupSales } from '../handlers/staff-setup.ts';
import { addMembers, changeRole, listMembers, removeMember } from '../handlers/team.ts';
import { getTownProfile } from '../handlers/towns.ts';
import { endViewAs, startViewAs } from '../handlers/view-as.ts';
import { acceptSuggestion, dismissSuggestion, switchCalendarTitles, switchWeeklySuggestions } from '../handlers/weekly-suggestions.ts';
import { openAsAdminRefusal, policyRefusal, principalOf, recordResolution, viewAsRefusal, type Policy, type Principal } from './policy.ts';
import { resolveAccess } from './resolve.ts';

export interface TownwiseRoute {
  readonly id: string;
  /** PUT only with bodyLimit 'stream' (the file chunk) or '1mb' (the ordering setup, saved whole). */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Under /api. */
  readonly path: `/${string}`;
  readonly policy: Policy;
  /**
   * 'none' for GET and DELETE; '1kb' on a TownwiseAI question's answer, a TownwiseAI turn's stop, accepting or dismissing a weekly suggestion, a conversation's rename, a version switch, a reply's rating, the profile
   * edit, an order rule's turn-off and open as admin's start (its reason);
   * '2kb' on the Places, files, imports and (D28) Your data JSON routes, the start of a calibration, the forecasts
   * switch, the weekly suggestions switch, (D31) a business rule, the order decisions and rules, the item and order change cards, and connecting a
   * Google calendar;
   * '8kb' on a TownwiseAI proposal; '32kb' on the other JSON writes, among them (D29) the Places map, whose 25 place
   * ids may reach 13 KB, and an order count; '256kb' only on the upload routes (the member one, D23 staff setup's, and
   * the item sales upload) and (U13B) the staff forecast import; '1mb' only on the ordering setup's save (300 items
   * with 10 point-of-sale names each can pass 256kb); '2mb' only on adding an owner calendar, whose body may carry a
   * calendar file of at most 1 MB (its handler counts the file's own bytes) as a JSON string, in which each CR, LF,
   * tab, quote and backslash takes two bytes; '8mb' only on reading the ordering setup with TownwiseAI (D41), whose
   * body carries a file of at most 5 MB as base64 (a third larger) or pasted text; 'stream' only on the chunk route,
   * whose handler reads the raw body itself after the policy has passed.
   */
  readonly bodyLimit: 'none' | '1kb' | '2kb' | '8kb' | '32kb' | '256kb' | '1mb' | '2mb' | '8mb' | 'stream';
  /** 'writes' applies to every non-GET automatically, before access is resolved. */
  readonly limiter?:
    | 'uploads' | 'item_sales' | 'requests' | 'view-as' | 'chat' | 'chat_tail' | 'places' | 'files' | 'file_chunks' | 'downloads'
    | 'ai_reads' | 'google_calendars';
  /**
   * Runs while staff have the organization open as its admin (D25), as the grant organization's org admin. Without it
   * the route is refused then (403 `open_as_admin_refused`; staff routes 409 `open_as_admin_active`), so a new route
   * stays closed in that mode until someone decides. Never on a staff or staff_self route (boot refuses it).
   */
  readonly openAsAdmin?: true;
  /**
   * Runs right before the body is parsed, after the policy; a throw refuses the request unparsed. Only reading the
   * ordering setup with TownwiseAI (D41) has one, which holds the replica's byte gate for the body before it is buffered
   * (handlers/order-setup-read.ts holdSetupReadBytes); boot refuses it on any other route.
   */
  readonly beforeBody?: (ctx: TownwiseContext, req: Request, res: Response) => void;
  readonly handler: (ctx: TownwiseContext, req: Request, res: Response, principal: Principal) => Promise<void>;
}

export const TOWNWISE_ROUTES: readonly TownwiseRoute[] = [
  { id: 'me.get', method: 'GET', path: '/me', policy: 'signed_in', bodyLimit: 'none', openAsAdmin: true, handler: getMe },
  { id: 'me.join', method: 'POST', path: '/me/join', policy: 'signed_in', bodyLimit: '32kb', handler: joinInvite },
  { id: 'me.decline', method: 'POST', path: '/me/decline', policy: 'signed_in', bodyLimit: '32kb', handler: declineInvite },
  // U11, statement moments: no body, so none is parsed; the writes limiter only.
  { id: 'me.welcome', method: 'POST', path: '/me/welcome', policy: 'member', bodyLimit: 'none', handler: recordWelcome },
  // The display name for TownwiseAI's greeting: own account only; writes limiter only.
  // D25: open as admin, it is the staff member's own name (per person, not per organization).
  {
    id: 'me.profile.get', method: 'GET', path: '/me/profile', policy: 'member', bodyLimit: 'none', openAsAdmin: true,
    handler: getProfile,
  },
  {
    id: 'me.profile.update', method: 'PATCH', path: '/me/profile', policy: 'member', bodyLimit: '1kb', openAsAdmin: true,
    handler: updateProfile,
  },
  {
    id: 'requests.create', method: 'POST', path: '/access-requests', policy: 'signed_in', bodyLimit: '32kb',
    limiter: 'requests', handler: createAccessRequest,
  },
  {
    id: 'towns.get', method: 'GET', path: '/towns/:townId', policy: 'signed_in', bodyLimit: 'none', openAsAdmin: true,
    handler: getTownProfile,
  },
  // Whether the search is on, for P3 and P21's setup panel; it never calls Google.
  {
    id: 'places.status', method: 'GET', path: '/places/status', policy: 'signed_in', bodyLimit: 'none', openAsAdmin: true,
    handler: placesStatus,
  },
  {
    id: 'places.autocomplete', method: 'POST', path: '/places/autocomplete', policy: 'signed_in', bodyLimit: '2kb',
    limiter: 'places', openAsAdmin: true, handler: placesAutocomplete,
  },
  {
    id: 'places.details', method: 'POST', path: '/places/details', policy: 'signed_in', bodyLimit: '2kb',
    limiter: 'places', openAsAdmin: true, handler: placesDetails,
  },
  // D29: the signed map of every checked place; signing is local, so it answers with the Places search off.
  {
    id: 'places.map', method: 'POST', path: '/places/map', policy: 'signed_in', bodyLimit: '32kb',
    limiter: 'places', openAsAdmin: true, handler: placesMap,
  },

  { id: 'org.get', method: 'GET', path: '/org', policy: 'member', bodyLimit: 'none', openAsAdmin: true, handler: getOwnOrg },
  { id: 'org.update', method: 'PATCH', path: '/org', policy: 'org_admin', bodyLimit: '32kb', openAsAdmin: true, handler: renameOrg },
  {
    id: 'org.staff_activity', method: 'GET', path: '/org/staff-activity', policy: 'org_admin', bodyLimit: 'none',
    openAsAdmin: true, handler: getStaffActivity,
  },
  { id: 'org.leave', method: 'POST', path: '/org/leave', policy: 'member', bodyLimit: '32kb', handler: leaveOrg },
  // D47: Settings' lettered map of the caller's own locations, with where each pin sits, for its hover.
  {
    id: 'org.locations.map', method: 'GET', path: '/org/locations/map', policy: 'member', bodyLimit: 'none',
    limiter: 'places', openAsAdmin: true, handler: getLocationsMap,
  },
  {
    id: 'org.locations.create', method: 'POST', path: '/org/locations', policy: 'org_admin', bodyLimit: '32kb',
    openAsAdmin: true, handler: createLocation,
  },
  {
    id: 'org.locations.update', method: 'PATCH', path: '/org/locations/:locationId', policy: 'org_admin', bodyLimit: '32kb',
    openAsAdmin: true, handler: updateLocation,
  },
  {
    id: 'org.locations.remove', method: 'DELETE', path: '/org/locations/:locationId', policy: 'org_admin', bodyLimit: 'none',
    openAsAdmin: true, handler: deleteLocation,
  },
  {
    id: 'org.sales.get', method: 'GET', path: '/org/locations/:locationId/sales', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getSales,
  },
  {
    id: 'org.sales.days', method: 'GET', path: '/org/locations/:locationId/sales/days', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getSalesDays,
  },
  // Spec 10.10: sales history and the town calendar.
  {
    id: 'org.sales.history', method: 'GET', path: '/org/locations/:locationId/sales/history', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: getSalesHistory,
  },
  {
    id: 'org.calendar.get', method: 'GET', path: '/org/locations/:locationId/calendar', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getLocationCalendar,
  },
  {
    id: 'org.sales.upload', method: 'POST', path: '/org/locations/:locationId/sales/uploads', policy: 'member',
    bodyLimit: '256kb', limiter: 'uploads', openAsAdmin: true, handler: uploadSales,
  },
  {
    id: 'org.sales.remove', method: 'DELETE', path: '/org/locations/:locationId/sales', policy: 'org_admin', bodyLimit: 'none',
    openAsAdmin: true, handler: deleteSales,
  },
  {
    id: 'org.notes.list', method: 'GET', path: '/org/locations/:locationId/notes', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: listNotes,
  },
  {
    id: 'org.notes.create', method: 'POST', path: '/org/locations/:locationId/notes', policy: 'member', bodyLimit: '32kb',
    openAsAdmin: true, handler: createNote,
  },
  {
    id: 'org.notes.update', method: 'PATCH', path: '/org/locations/:locationId/notes/:noteId', policy: 'member',
    bodyLimit: '32kb', openAsAdmin: true, handler: updateNote,
  },
  {
    id: 'org.notes.remove', method: 'DELETE', path: '/org/locations/:locationId/notes/:noteId', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteNote,
  },
  // Business rules: standing facts about a location that TownwiseAI reads with every message (spec 10.16, D31).
  {
    id: 'org.rules.list', method: 'GET', path: '/org/locations/:locationId/rules', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: listRules,
  },
  {
    id: 'org.rules.create', method: 'POST', path: '/org/locations/:locationId/rules', policy: 'member', bodyLimit: '2kb',
    openAsAdmin: true, handler: createRule,
  },
  {
    id: 'org.rules.update', method: 'PATCH', path: '/org/locations/:locationId/rules/:ruleId', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: updateRule,
  },
  {
    id: 'org.rules.remove', method: 'DELETE', path: '/org/locations/:locationId/rules/:ruleId', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteRule,
  },
  // The owner's own calendars (openspec change connect-owner-calendar, design decision 7), as notes: every member, open
  // as admin included. events is declared before the :calendarId routes. "Refresh now" has no body; its handler holds
  // it to one per calendar per 5 minutes. No route limiter: a file import fetches nothing, and adding a link or a Google
  // calendar spends one of the account's link adds in its handler before the fetch (connect-google-calendar: the
  // handler refuses a Google add open as admin).
  {
    id: 'org.owner_calendars.list', method: 'GET', path: '/org/locations/:locationId/owner-calendars', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: listOwnerCalendars,
  },
  {
    id: 'org.owner_calendars.events', method: 'GET', path: '/org/locations/:locationId/owner-calendars/events', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: listOwnerCalendarEvents,
  },
  {
    id: 'org.owner_calendars.create', method: 'POST', path: '/org/locations/:locationId/owner-calendars', policy: 'member',
    bodyLimit: '2mb', openAsAdmin: true, handler: createOwnerCalendar,
  },
  {
    id: 'org.owner_calendars.refresh', method: 'POST', path: '/org/locations/:locationId/owner-calendars/:calendarId/refresh',
    policy: 'member', bodyLimit: 'none', openAsAdmin: true, handler: refreshOwnerCalendar,
  },
  {
    id: 'org.owner_calendars.remove', method: 'DELETE', path: '/org/locations/:locationId/owner-calendars/:calendarId',
    policy: 'member', bodyLimit: 'none', openAsAdmin: true, handler: removeOwnerCalendar,
  },
  // A file calendar's booking labels (learn-from-calendar-bookings, D58): an org admin's only. Sort with TownwiseAI sends
  // the titles to Anthropic, so it is never staff's open as admin; its handler holds it to 3 a calendar an hour. A label
  // names its event by uid in the 2 KB body, never the path; the sort and the confirm have no body.
  {
    id: 'org.owner_calendars.bookings_sort', method: 'POST', path: '/org/locations/:locationId/owner-calendars/:calendarId/bookings/sort',
    policy: 'org_admin', bodyLimit: 'none', handler: sortCalendarBookings,
  },
  {
    id: 'org.owner_calendars.bookings_label', method: 'PATCH', path: '/org/locations/:locationId/owner-calendars/:calendarId/bookings',
    policy: 'org_admin', bodyLimit: '2kb', openAsAdmin: true, handler: labelCalendarBooking,
  },
  {
    id: 'org.owner_calendars.bookings_confirm', method: 'POST', path: '/org/locations/:locationId/owner-calendars/:calendarId/bookings/confirm',
    policy: 'org_admin', bodyLimit: 'none', openAsAdmin: true, handler: confirmCalendarBookings,
  },
  // Connecting a Google calendar (openspec change connect-google-calendar, design decision 8): a member's own Google
  // account, never staff's, so none runs open as admin (D25). Every call reaches Google, so all three spend the
  // google_calendars limiter. The connect body is the code and the agreement; the choices and the disconnect have none.
  // No path shadows another: the choices and connect sit under google-calendars, and the disconnect names no location.
  {
    id: 'org.google_calendars.connect', method: 'POST', path: '/org/locations/:locationId/google-calendars/connect', policy: 'member',
    bodyLimit: '2kb', limiter: 'google_calendars', handler: connectGoogle,
  },
  {
    id: 'org.google_calendars.list', method: 'GET', path: '/org/locations/:locationId/google-calendars', policy: 'member',
    bodyLimit: 'none', limiter: 'google_calendars', handler: listGoogleChoices,
  },
  {
    id: 'org.google_calendars.disconnect', method: 'DELETE', path: '/org/google-connection', policy: 'member', bodyLimit: 'none',
    limiter: 'google_calendars', handler: dropGoogleConnection,
  },
  // Stored files and imports (spec 10.11, 11A). imports/current is declared before imports/:importId.
  {
    id: 'org.files.create', method: 'POST', path: '/org/locations/:locationId/files', policy: 'member', bodyLimit: '2kb',
    limiter: 'files', openAsAdmin: true, handler: createFile,
  },
  {
    id: 'org.files.chunk', method: 'PUT', path: '/org/locations/:locationId/files/:fileId/chunks/:index', policy: 'member',
    bodyLimit: 'stream', limiter: 'file_chunks', openAsAdmin: true, handler: putChunk,
  },
  {
    id: 'org.files.complete', method: 'POST', path: '/org/locations/:locationId/files/:fileId/complete', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: completeFile,
  },
  {
    id: 'org.files.list', method: 'GET', path: '/org/locations/:locationId/files', policy: 'member', bodyLimit: 'none', openAsAdmin: true,
    handler: listFiles,
  },
  {
    id: 'org.files.get', method: 'GET', path: '/org/locations/:locationId/files/:fileId', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getFile,
  },
  {
    id: 'org.files.entries', method: 'GET', path: '/org/locations/:locationId/files/:fileId/entries', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: listEntries,
  },
  {
    id: 'org.files.raw', method: 'GET', path: '/org/locations/:locationId/files/:fileId/raw', policy: 'member', bodyLimit: 'none',
    limiter: 'downloads', openAsAdmin: true, handler: downloadRaw,
  },
  {
    id: 'org.files.clean', method: 'GET', path: '/org/locations/:locationId/files/:fileId/clean', policy: 'member',
    bodyLimit: 'none', limiter: 'downloads', openAsAdmin: true, handler: downloadClean,
  },
  {
    id: 'org.files.remove_raw', method: 'DELETE', path: '/org/locations/:locationId/files/:fileId/raw', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteRaw,
  },
  {
    id: 'org.files.remove', method: 'DELETE', path: '/org/locations/:locationId/files/:fileId', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteFile,
  },
  {
    id: 'org.data.text', method: 'POST', path: '/org/locations/:locationId/data/text', policy: 'member', bodyLimit: '32kb',
    limiter: 'files', openAsAdmin: true, handler: addTextItem,
  },
  // D28, Your data: the list (a location's, or the organization's), one item (its page), turning an item off or on or
  // renaming it, saving an edit of it (another stored file takes its place), and deleting it.
  {
    id: 'org.data.list', method: 'GET', path: '/org/data', policy: 'member', bodyLimit: 'none', openAsAdmin: true,
    handler: listData,
  },
  {
    id: 'org.data.get', method: 'GET', path: '/org/locations/:locationId/data/:ref', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getDataItem,
  },
  {
    id: 'org.data.update', method: 'PATCH', path: '/org/locations/:locationId/data/:ref', policy: 'member', bodyLimit: '2kb',
    openAsAdmin: true, handler: updateDataItem,
  },
  {
    id: 'org.data.replace', method: 'POST', path: '/org/locations/:locationId/data/:ref/replace', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: replaceDataItem,
  },
  // Spec 11A.9 (D34): letting TownwiseAI read an item's stored file, opted in per file, and undoing what the read made.
  {
    id: 'org.data.ai_read', method: 'POST', path: '/org/locations/:locationId/data/:ref/ai', policy: 'member', bodyLimit: '2kb',
    limiter: 'ai_reads', openAsAdmin: true, handler: requestAiRead,
  },
  {
    id: 'org.data.ai_undo', method: 'DELETE', path: '/org/locations/:locationId/data/:ref/ai', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: undoAiRead,
  },
  {
    id: 'org.data.remove', method: 'DELETE', path: '/org/locations/:locationId/data/:ref', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: removeDataItem,
  },
  // D60: importing a calendar file kept in Your data again, after a refusal a retry may mend. Every member, as Your
  // calendars' import, open as admin included; it fetches nothing, so no route limiter.
  {
    id: 'org.data.calendar', method: 'POST', path: '/org/locations/:locationId/data/:ref/calendar', policy: 'member', bodyLimit: '2kb',
    openAsAdmin: true, handler: retryDataCalendar,
  },
  {
    id: 'org.originals.remove', method: 'DELETE', path: '/org/locations/:locationId/originals', policy: 'org_admin',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteLocationOriginals,
  },
  {
    id: 'org.imports.current', method: 'GET', path: '/org/locations/:locationId/imports/current', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: currentImport,
  },
  {
    id: 'org.imports.get', method: 'GET', path: '/org/locations/:locationId/imports/:importId', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: getImport,
  },
  {
    id: 'org.imports.start', method: 'POST', path: '/org/locations/:locationId/imports/:importId/start', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: startImport,
  },
  {
    id: 'org.imports.answer', method: 'POST', path: '/org/locations/:locationId/imports/:importId/answer', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: answerImport,
  },
  {
    id: 'org.chat.get', method: 'GET', path: '/org/locations/:locationId/chat', policy: 'member', bodyLimit: 'none', openAsAdmin: true,
    handler: getChat,
  },
  {
    id: 'org.chat.conversation', method: 'GET', path: '/org/locations/:locationId/chat/:conversationId', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: getConversation,
  },
  {
    id: 'org.chat.turn', method: 'POST', path: '/org/locations/:locationId/chat/turns', policy: 'member', bodyLimit: '32kb',
    limiter: 'chat', openAsAdmin: true, handler: postTurn,
  },
  // resumable-chat-turns: a running turn's events, read back from its record, for a page that lost its stream.
  {
    id: 'org.chat.turn_events', method: 'GET', path: '/org/locations/:locationId/chat/:conversationId/turns/:turnId',
    policy: 'member', bodyLimit: 'none', limiter: 'chat_tail', openAsAdmin: true, handler: getTurnEvents,
  },
  // resumable-chat-turns: stopping a running turn, from any replica; an empty body, the writes limiter only.
  {
    id: 'org.chat.turn_stop', method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/turns/:turnId/stop',
    policy: 'member', bodyLimit: '1kb', openAsAdmin: true, handler: stopTurn,
  },
  {
    id: 'org.chat.remove', method: 'DELETE', path: '/org/locations/:locationId/chat/:conversationId', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteConversation,
  },
  // TownwiseAI's conversation trees: renaming, and switching the version shown. Neither calls the model: writes only.
  {
    id: 'org.chat.rename', method: 'PATCH', path: '/org/locations/:locationId/chat/:conversationId', policy: 'member',
    bodyLimit: '1kb', openAsAdmin: true, handler: renameConversation,
  },
  {
    id: 'org.chat.active', method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/active', policy: 'member',
    bodyLimit: '1kb', openAsAdmin: true, handler: showVersion,
  },
  // U9 (TownwiseAI): saving or setting aside a proposed note.
  {
    id: 'org.chat.proposal', method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/proposals/:proposalId',
    policy: 'member', bodyLimit: '8kb', openAsAdmin: true, handler: actOnProposal,
  },
  // Rating a reply: private display state that never calls the model, so writes only.
  {
    id: 'org.chat.feedback', method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/feedback/:nodeId',
    policy: 'member', bodyLimit: '1kb', openAsAdmin: true, handler: rateReply,
  },
  // D28 (TownwiseAI): a card proposing to keep pasted text on Your data, and keeping it or setting it aside.
  {
    id: 'org.chat.item_proposal.get', method: 'GET',
    path: '/org/locations/:locationId/chat/:conversationId/item-proposals/:proposalId', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getItemProposal,
  },
  {
    id: 'org.chat.item_proposal', method: 'POST',
    path: '/org/locations/:locationId/chat/:conversationId/item-proposals/:proposalId', policy: 'member', bodyLimit: '2kb',
    limiter: 'files', openAsAdmin: true, handler: actOnItemProposal,
  },
  // U9 (TownwiseAI): the side panel's questions and activity, and answering a question.
  {
    id: 'org.agent.get', method: 'GET', path: '/org/locations/:locationId/agent', policy: 'member', bodyLimit: 'none', openAsAdmin: true,
    handler: getAgent,
  },
  {
    id: 'org.agent.answer', method: 'POST', path: '/org/locations/:locationId/agent/questions/:questionId', policy: 'member',
    bodyLimit: '1kb', openAsAdmin: true, handler: answerQuestion,
  },
  // TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions): an org admin accepts or dismisses one,
  // and turns them off or on for the organization (the switch carries the tab's orgId in open as admin, D25).
  {
    id: 'org.agent.suggestion_accept', method: 'POST', path: '/org/locations/:locationId/agent/suggestions/:suggestionId/accept',
    policy: 'org_admin', bodyLimit: '1kb', openAsAdmin: true, handler: acceptSuggestion,
  },
  {
    id: 'org.agent.suggestion_dismiss', method: 'POST', path: '/org/locations/:locationId/agent/suggestions/:suggestionId/dismiss',
    policy: 'org_admin', bodyLimit: '1kb', openAsAdmin: true, handler: dismissSuggestion,
  },
  // Suggested closure rules (openspec change suggest-closure-rules, D46): any member confirms, edits or dismisses a
  // file or sales suggestion; 2 KB so an Edit of 200 four-byte characters and a schedule fits. A weekly one is 404 here.
  {
    id: 'org.agent.rule_suggestion_accept', method: 'POST',
    path: '/org/locations/:locationId/agent/rule-suggestions/:suggestionId/accept', policy: 'member', bodyLimit: '2kb', openAsAdmin: true,
    handler: acceptRuleSuggestion,
  },
  {
    id: 'org.agent.rule_suggestion_dismiss', method: 'POST',
    path: '/org/locations/:locationId/agent/rule-suggestions/:suggestionId/dismiss', policy: 'member', bodyLimit: '2kb', openAsAdmin: true,
    handler: dismissRuleSuggestion,
  },
  {
    id: 'org.weekly_suggestions.switch', method: 'PATCH', path: '/org/weekly-suggestions', policy: 'org_admin', bodyLimit: '2kb',
    openAsAdmin: true, handler: switchWeeklySuggestions,
  },
  // Sending the calendars' event titles to the weekly call (calendar-event-suggestions): open as admin may turn it off only.
  {
    id: 'org.weekly_suggestions.calendar_titles', method: 'PATCH', path: '/org/weekly-suggestions/calendar-titles', policy: 'org_admin',
    bodyLimit: '2kb', openAsAdmin: true, handler: switchCalendarTitles,
  },
  // D59 (openspec change auto-apply-agent-reads): TownwiseAI working on its own. The org admin's switch (open as admin may
  // turn it off only), the log of a location's changes, and Undo of one (any member for a note, an org admin for days,
  // checked in the handler; never under view-as, which refuses every write).
  {
    id: 'org.agent_auto.switch', method: 'PATCH', path: '/org/agent-auto', policy: 'org_admin', bodyLimit: '2kb', openAsAdmin: true,
    handler: switchAgentAuto,
  },
  {
    id: 'org.agent.changes', method: 'GET', path: '/org/locations/:locationId/agent/changes', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: listAgentChanges,
  },
  {
    id: 'org.agent.change_undo', method: 'POST', path: '/org/locations/:locationId/agent/changes/:changeId/undo', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: undoAgentChange,
  },
  // U13A, estimates (spec 10.13): people in town and "How Townwise estimates". Reads with no limiter.
  {
    id: 'org.people.get', method: 'GET', path: '/org/locations/:locationId/people-in-town', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: getPeopleInTown,
  },
  {
    id: 'org.estimates.about', method: 'GET', path: '/org/locations/:locationId/estimates/about', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: getEstimatesAbout,
  },
  // U13B, forecast runs (spec 10.13, 14.4): the published forecast, a member read with no limiter.
  {
    id: 'org.forecast.get', method: 'GET', path: '/org/locations/:locationId/forecast', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getForecast,
  },
  // Orders: the board, a saved edit, and a confirmed rule. The sample is a query on the GET.
  {
    id: 'org.orders.get', method: 'GET', path: '/org/locations/:locationId/orders', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getOrders,
  },
  {
    id: 'org.orders.decision', method: 'POST', path: '/org/locations/:locationId/orders/decisions', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: saveOrderDecision,
  },
  {
    id: 'org.orders.rule', method: 'POST', path: '/org/locations/:locationId/orders/rules', policy: 'member',
    bodyLimit: '2kb', openAsAdmin: true, handler: saveOrderRule,
  },
  {
    id: 'org.orders.rule_off', method: 'POST', path: '/org/locations/:locationId/orders/rules/off', policy: 'member',
    bodyLimit: '1kb', openAsAdmin: true, handler: turnOffOrderRule,
  },
  // Ordering setup, item sales and counts (design Decisions 3, 4 and 8): every member edits the setup, uploads item
  // sales and counts; only an org admin deletes item sales. The setup is saved whole, under compare-and-set.
  {
    id: 'org.orders.setup.get', method: 'GET', path: '/org/locations/:locationId/orders/setup', policy: 'member',
    bodyLimit: 'none', openAsAdmin: true, handler: getOrderSetup,
  },
  {
    id: 'org.orders.setup.save', method: 'PUT', path: '/org/locations/:locationId/orders/setup', policy: 'member',
    bodyLimit: '1mb', openAsAdmin: true, handler: saveOrderSetup,
  },
  // D41: TownwiseAI reads one file or pasted text into suggestions for the setup's unsaved draft. Nothing is stored;
  // each read is a model call, so it shares the ai_reads limiter with D34's reads.
  {
    id: 'org.orders.setup.read', method: 'POST', path: '/org/locations/:locationId/orders/setup/read', policy: 'member',
    bodyLimit: '8mb', limiter: 'ai_reads', openAsAdmin: true, beforeBody: holdSetupReadBytes, handler: readOrderSetup,
  },
  {
    id: 'org.orders.item_sales.upload', method: 'POST', path: '/org/locations/:locationId/orders/item-sales', policy: 'member',
    bodyLimit: '256kb', limiter: 'item_sales', openAsAdmin: true, handler: uploadItemSales,
  },
  {
    id: 'org.orders.item_sales.remove', method: 'DELETE', path: '/org/locations/:locationId/orders/item-sales', policy: 'org_admin',
    bodyLimit: 'none', openAsAdmin: true, handler: deleteItemSales,
  },
  {
    id: 'org.orders.counts.save', method: 'POST', path: '/org/locations/:locationId/orders/counts', policy: 'member',
    bodyLimit: '32kb', openAsAdmin: true, handler: saveOrderCount,
  },
  {
    id: 'org.chat.order_proposal.get', method: 'GET',
    path: '/org/locations/:locationId/chat/:conversationId/order-proposals/:proposalId', policy: 'member', bodyLimit: 'none',
    openAsAdmin: true, handler: getOrderProposal,
  },
  {
    id: 'org.chat.order_proposal', method: 'POST',
    path: '/org/locations/:locationId/chat/:conversationId/order-proposals/:proposalId', policy: 'member', bodyLimit: '2kb',
    openAsAdmin: true, handler: actOnOrderProposal,
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

  // The console's Overview (openspec change staff-overview): usage and health across organizations, a read with no limiter.
  { id: 'admin.overview', method: 'GET', path: '/admin/overview', policy: 'staff', bodyLimit: 'none', handler: getOverview },
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
  // D23, staff setup: an organization's locations and daily totals while nobody has joined it, with the org routes'
  // bodies and body limits; the writes limiter only, as the other staff writes.
  {
    id: 'admin.orgs.locations.create', method: 'POST', path: '/admin/orgs/:orgId/locations', policy: 'staff', bodyLimit: '32kb',
    handler: createSetupLocation,
  },
  {
    id: 'admin.orgs.locations.update', method: 'PATCH', path: '/admin/orgs/:orgId/locations/:locationId', policy: 'staff',
    bodyLimit: '32kb', handler: updateSetupLocation,
  },
  {
    id: 'admin.orgs.locations.remove', method: 'DELETE', path: '/admin/orgs/:orgId/locations/:locationId', policy: 'staff',
    bodyLimit: 'none', handler: deleteSetupLocation,
  },
  {
    id: 'admin.orgs.sales.upload', method: 'POST', path: '/admin/orgs/:orgId/locations/:locationId/sales/uploads', policy: 'staff',
    bodyLimit: '256kb', handler: uploadSetupSales,
  },
  {
    id: 'admin.orgs.sales.remove', method: 'DELETE', path: '/admin/orgs/:orgId/locations/:locationId/sales', policy: 'staff',
    bodyLimit: 'none', handler: deleteSetupSales,
  },
  // D25, open as admin: no body, and the view-as limiter, shared with view-as Start. End is view-as End.
  {
    id: 'admin.orgs.open_as_admin', method: 'POST', path: '/admin/orgs/:orgId/open-as-admin', policy: 'staff', bodyLimit: '1kb',
    limiter: 'view-as', handler: startOpenAsAdmin,
  },
  // U13B, forecast runs from the staff console (spec 10.13, 14.4): import as a draft, publish, withdraw, delete.
  {
    id: 'admin.forecasts.list', method: 'GET', path: '/admin/orgs/:orgId/forecast-runs', policy: 'staff', bodyLimit: 'none',
    handler: listForecastRuns,
  },
  {
    id: 'admin.forecasts.get', method: 'GET', path: '/admin/orgs/:orgId/forecast-runs/:runId', policy: 'staff', bodyLimit: 'none',
    handler: getForecastRun,
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
  // The forecast lab: an organization's calibrations, starting one for a location (its job returns a draft run, which
  // the system publishes when it passes the gate), and the organization's forecasts switch (G1). The writes limiter only
  // here; the service counts the organization's 4 a day itself.
  {
    id: 'admin.calibrations.list', method: 'GET', path: '/admin/orgs/:orgId/calibrations', policy: 'staff', bodyLimit: 'none',
    handler: listCalibrations,
  },
  {
    id: 'admin.calibrations.start', method: 'POST', path: '/admin/orgs/:orgId/locations/:locationId/calibrations', policy: 'staff',
    bodyLimit: '2kb', handler: startCalibration,
  },
  {
    id: 'admin.forecasts.switch', method: 'POST', path: '/admin/orgs/:orgId/forecasts-switch', policy: 'staff', bodyLimit: '2kb',
    handler: switchForecasts,
  },
  // D42: staff pause or resume every scheduled start of the weekly refresh, for all organizations.
  {
    id: 'admin.forecast_schedule.set', method: 'POST', path: '/admin/forecast-schedule', policy: 'staff', bodyLimit: '2kb',
    handler: setForecastSchedule,
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
  {
    id: 'admin.orgs.originals.remove', method: 'POST', path: '/admin/orgs/:orgId/originals/delete', policy: 'staff', bodyLimit: '32kb',
    handler: purgeOriginals,
  },
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
export const ROUTE_LIMITS = {
  uploads: { name: 'townwise:uploads', limit: 30, windowSeconds: 3600, whenStoreDown: 'allow' },
  // The browser sends an item sales file in chunks of up to 31 days (244 days is 8 chunks, more when a chunk is split
  // by size), so it has its own count instead of spending the sales uploads'. The kit's names take no underscore.
  item_sales: { name: 'townwise:item-sales', limit: 60, windowSeconds: 3600, whenStoreDown: 'allow' },
  requests: { name: 'townwise:requests', limit: 5, windowSeconds: 86400, whenStoreDown: 'deny' },
  'view-as': { name: 'townwise:view-as', limit: 20, windowSeconds: 3600, whenStoreDown: 'deny' },
  // docs/portal/tuning-chat.md section 2: every turn costs money, so a store outage denies.
  chat: { name: 'townwise:chat', limit: 60, windowSeconds: 3600, whenStoreDown: 'deny' },
  // resumable-chat-turns: reading a turn's events back spends nothing (two reads a second of the record's state, count
  // and lease, and the record only once it gained events, for at most 200 seconds), so a store outage allows. 300 an hour leaves room for a page that reconnects every few seconds through an outage.
  chat_tail: { name: 'townwise:chat-tail', limit: 300, windowSeconds: 3600, whenStoreDown: 'allow' },
  // Both Places routes share it. A search is 10 to 15 debounced autocompletes and one details call, so this is about
  // 20 searches an hour; every call costs money, so a store outage denies.
  places: { name: 'townwise:places', limit: 300, windowSeconds: 3600, whenStoreDown: 'deny' },
  // Stored files (spec 10.8). The daily byte cap, not these, bounds the volume; an outage allows.
  files: { name: 'townwise:files', limit: 120, windowSeconds: 3600, whenStoreDown: 'allow' },
  file_chunks: { name: 'townwise:file-chunks', limit: 1500, windowSeconds: 3600, whenStoreDown: 'allow' },
  downloads: { name: 'townwise:downloads', limit: 300, windowSeconds: 3600, whenStoreDown: 'allow' },
  // Spec 11A.9 and D41 (the ordering setup's read): each read is a model call on a whole file or text, so a store
  // outage denies (the writes limiter allows).
  ai_reads: { name: 'townwise:ai-reads', limit: 30, windowSeconds: 3600, whenStoreDown: 'deny' },
  // connect-google-calendar, design decision 8: every call is a Google call, so a store outage denies, as for Places.
  // [CONFIRM: 30 Google calendar calls an account an hour]
  google_calendars: { name: 'townwise:google-calendars', limit: 30, windowSeconds: 3600, whenStoreDown: 'deny' },
} as const;

/** The only route that may stream its body. */
const STREAM_ROUTE = 'org.files.chunk';
/** The only route that may take a 1 MB body: the ordering setup, saved whole. */
const ONE_MB_ROUTE = 'org.orders.setup.save';
/**
 * The only route that may take an 8 MB body, and the only one with a step before its body: reading the ordering setup
 * with TownwiseAI (D41).
 */
const EIGHT_MB_ROUTE = 'org.orders.setup.read';

/**
 * Boot refuses a duplicate method and path, a GET with a body limit, staff_self on any other route, a PUT without a
 * streamed or 1 MB body, a streamed body on any route but the chunk route, a 1 MB body on any route but the ordering
 * setup's save, an 8 MB body or a `beforeBody` step on any route but the ordering setup's read (a POST with an 8 MB
 * body), and `openAsAdmin` on a staff or staff_self route.
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
    if (route.method === 'PUT' && route.bodyLimit !== 'stream' && route.bodyLimit !== '1mb') {
      throw new ConfigError('routes', `${route.id} is a PUT without a streamed or 1 MB body`);
    }
    if (route.bodyLimit === 'stream' && (route.id !== STREAM_ROUTE || route.method !== 'PUT')) {
      throw new ConfigError('routes', `${route.id} streams its body, which only ${STREAM_ROUTE} may`);
    }
    if (route.bodyLimit === '1mb' && (route.id !== ONE_MB_ROUTE || route.method !== 'PUT')) {
      throw new ConfigError('routes', `${route.id} takes a 1 MB body, which only ${ONE_MB_ROUTE} may`);
    }
    if (route.bodyLimit === '8mb' && (route.id !== EIGHT_MB_ROUTE || route.method !== 'POST')) {
      throw new ConfigError('routes', `${route.id} takes an 8 MB body, which only ${EIGHT_MB_ROUTE} may`);
    }
    if (route.beforeBody !== undefined && (route.id !== EIGHT_MB_ROUTE || route.method !== 'POST' || route.bodyLimit !== '8mb')) {
      throw new ConfigError('routes', `${route.id} runs a step before its body, which only ${EIGHT_MB_ROUTE} may`);
    }
    if (route.openAsAdmin === true && (route.policy === 'staff' || route.policy === 'staff_self')) {
      throw new ConfigError('routes', `${route.id} is a staff route marked openAsAdmin`);
    }
  }
}

const principals = new WeakMap<Request, Principal>();

function bound(run: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void run(req, res).then(() => { if (!res.headersSent) next(); }).catch(next);
  };
}

/** Steps 3 to 5: resolve, the view-as and open-as-admin guards, the policy. Never reads the body. */
function authorize(ctx: TownwiseContext, route: TownwiseRoute): RequestHandler {
  return bound(async (req) => {
    const auth = authOf(req);
    const resolution = await resolveAccess(ctx, auth);
    const principal = principalOf(resolution, auth);
    const refusal = viewAsRefusal(route, principal) ?? openAsAdminRefusal(route, principal) ?? policyRefusal(route.policy, principal);
    if (refusal !== null) {
      ctx.logger.info({ policy: route.policy, code: refusal.code }, 'townwise.access_denied');
      throw refusal;
    }
    if (principal.kind !== 'staff' && principal.viewAs !== null && route.method === 'GET') {
      ctx.logger.info({ grantId: principal.viewAs.grantId, routeId: route.id }, 'townwise.view_as_read');
    }
    principals.set(req, principal);
    recordResolution(req, resolution);
    // The person's active day (staff-overview): only once every guard and the policy passed, never awaited.
    ctx.activity.record(principal);
  });
}

/** A route's step right before its body is parsed (TownwiseRoute.beforeBody): a throw refuses the request. */
function beforeBody(ctx: TownwiseContext, step: NonNullable<TownwiseRoute['beforeBody']>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      step(ctx, req, res);
    } catch (err) {
      next(err);
      return;
    }
    next();
  };
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
    if (route.beforeBody !== undefined) chain.push(beforeBody(ctx, route.beforeBody));
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
