// The staff console's Overview (openspec change staff-overview, design decisions 4 and 5): GET
// /api/admin/overview?days=7|28|90 answers, across organizations, who used Townwise in the window and the window before
// it, what they did, each organization's usage and forecast health, and what needs a staff member's attention. Counts,
// dates and a published forecast's live accuracy only (D7): never a sales figure, guest count, note text, chat text or a
// member's email. Windows are UTC days, today included. Activity comes from tw_activity_days; actions are audit events
// (stores/cross-tenant.ts peopleActionsSince says whose); each organization is scoped from the list just read
// (scopeForListedOrg), and its forecast column is one window read per location over the town's passed days. Nothing here
// writes, and its one log line carries the window and the organization count.
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { ACTIVITY_KEEP_DAYS } from '../access/activity.ts';
import { scopeForListedOrg, type OrgScope, type Principal, type StaffPrincipal } from '../access/policy.ts';
import { isInSetup } from '../access/setup.ts';
import type { TownwiseContext } from '../app.ts';
import { utcDay } from '../dates.ts';
import type { ForecastEngine } from '../forecasts/reader.ts';
import { WEEK_ROWS_LOOKBACK_DAYS } from '../lab/schedule.ts';
import type { AuditAction } from '../stores/audit-events.ts';
import { LIVE_STATUSES, type CalibrationRecord } from '../stores/calibrations.ts';
import {
  activityDaysSince, adminOrgStats, chatUsageForMonth, NO_ORG_STATS, openInvitesBefore, peopleActionsSince,
  type ActivityDayRow, type OpenInvites, type PeopleAction,
} from '../stores/cross-tenant.ts';
import type { ForecastWeekRecord } from '../stores/forecast-weeks.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { OrgRecord } from '../stores/orgs.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { staffOf } from './admin.ts';
import { scheduleView } from './calibrations.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The newest calibrations read per organization, as the forecast lab's list reads them. */
const CALIBRATIONS_READ = 50;

/** [CONFIRM: Needs attention's thresholds: 2 days, 14 days, 7 days, 80%] */
export const REQUEST_WAITING_DAYS = 2;
export const NO_UPLOAD_DAYS = 14;
export const INVITE_WAITING_DAYS = 7;
export const CHAT_BUDGET_SHARE = 0.8;

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
  'owner_calendar.bookings_sorted': 'townwiseAi',
  'owner_calendar.booking_labeled': 'notes',
  'owner_calendar.bookings_confirmed': 'notes',
  'google_calendar.connected': 'notes',
  'google_calendar.disconnected': 'notes',
  // D66: a person's edit of an event research found is a calendar change.
  'research.event_edited': 'notes',
  'research.event_hidden': 'notes',
  'research.event_restored': 'notes',
  // Staff taking a town row down for everyone: no organization's action.
  'research.town_event_suppressed': null,
  'chat.turn_completed': 'townwiseAi',
  'chat.conversation_deleted': 'townwiseAi',
  'agent.question_answered': 'townwiseAi',
  'org.weekly_suggestions_changed': 'team',
  'org.calendar_titles_ai_changed': 'team',
  // D59: the switch is the team's; a change TownwiseAI saved on its own is nobody's action, an undo is a person's.
  'org.agent_auto_switched': 'team',
  // D66: the research switch is the team's, as the other switches.
  'org.research_switched': 'team',
  'agent.change_applied': null,
  'agent.calendar_answered': null,
  'agent.change_undone': 'townwiseAi',
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

export type OverviewDays = 7 | 28 | 90;

const overviewQuery = z.object({ days: z.enum(['7', '28', '90']) });

export interface OverviewWindow {
  readonly days: OverviewDays;
  readonly from: string;
  readonly to: string;
  readonly previousFrom: string;
  readonly previousTo: string;
}

/** The day `days` after `day` (YYYY-MM-DD, UTC). */
function dayPlus(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

/** The last `days` UTC days, today included, and the `days` days before them. */
export function overviewWindow(now: Date, days: OverviewDays): OverviewWindow {
  return { days, from: utcDay(now, -(days - 1)), to: utcDay(now), previousFrom: utcDay(now, -(2 * days - 1)), previousTo: utcDay(now, -days) };
}

/**
 * How far after the oldest day kept the earliest stored row may be while recording still counts as having run for the
 * whole retention: with few people, the edge day (and a few after it) can simply be quiet.
 */
export const RETENTION_EDGE_SLACK_DAYS = 14;

/**
 * Whether the activity figures have a previous value: the record reaches back to the previous window's first day, or its
 * earliest row is within RETENTION_EDGE_SLACK_DAYS of the oldest day the 180 kept allow, so the gap is quiet days, not
 * missing recording. That second rule only ever matters to the 90-day window, whose previous window starts on that edge.
 */
export function hasPrevious(window: OverviewWindow, recordingSince: string | null): boolean {
  if (recordingSince === null) return false;
  const oldestKept = dayPlus(window.to, -(ACTIVITY_KEEP_DAYS - 1));
  return recordingSince <= window.previousFrom || recordingSince <= dayPlus(oldestKept, RETENTION_EDGE_SLACK_DAYS);
}

/** The four totals that each count one action. */
const TOTAL_ACTIONS = {
  chatTurns: 'chat.turn_completed', salesUploads: 'sales.uploaded', notesWritten: 'note.created', orderDecisions: 'order.decision_saved',
} as const satisfies Record<string, AuditAction>;
type TotalName = keyof typeof TOTAL_ACTIONS;

export interface Change { count: number; previous: number }
export interface ActivityChange { count: number; previous: number | null }
export type GroupCounts = Record<ActionGroup, number>;
export interface SeriesDay { day: string; activePeople: number; actions: GroupCounts }
export interface OrgUsage { activePeople: number; actions: number; lastActiveDay: string | null }

export interface Summary {
  /** The earliest stored activity day; null while nothing is recorded. */
  recordingSince: string | null;
  totals: { activeOrgs: ActivityChange; activePeople: ActivityChange } & Record<TotalName, Change>;
  /** One entry per day of the window, oldest first, zeros included. */
  series: SeriesDay[];
  /** Keyed by organization id: people active and actions in the window, and the newest stored day. */
  byOrg: Map<string, OrgUsage>;
}

function noActions(): GroupCounts {
  return { uploads: 0, notes: 0, townwiseAi: 0, orders: 0, team: 0 };
}

/** Folds the stored active days and people's actions into the window's totals, series and per-organization usage. */
export function summarize(window: OverviewWindow, activity: readonly ActivityDayRow[], actions: readonly PeopleAction[]): Summary {
  const inWindow = (day: string): boolean => day >= window.from && day <= window.to;
  const inPrevious = (day: string): boolean => day >= window.previousFrom && day <= window.previousTo;
  const days = Array.from({ length: window.days }, (_, index) => dayPlus(window.from, index));
  const perDay = new Map(days.map((day) => [day, { people: new Set<string>(), actions: noActions() }]));
  const perOrg = new Map<string, { people: Set<string>; actions: number; lastActiveDay: string | null }>();
  const orgOf = (orgId: string) => {
    const existing = perOrg.get(orgId);
    if (existing !== undefined) return existing;
    const created = { people: new Set<string>(), actions: 0, lastActiveDay: null as string | null };
    perOrg.set(orgId, created);
    return created;
  };
  const people = { now: new Set<string>(), before: new Set<string>() };
  const orgs = { now: new Set<string>(), before: new Set<string>() };
  let recordingSince: string | null = null;
  for (const row of activity) {
    if (recordingSince === null || row.day < recordingSince) recordingSince = row.day;
    const org = orgOf(row.orgId);
    if (org.lastActiveDay === null || row.day > org.lastActiveDay) org.lastActiveDay = row.day;
    if (inWindow(row.day)) {
      people.now.add(row.userId);
      orgs.now.add(row.orgId);
      org.people.add(row.userId);
      perDay.get(row.day)?.people.add(row.userId);
    } else if (inPrevious(row.day)) {
      people.before.add(row.userId);
      orgs.before.add(row.orgId);
    }
  }
  const counts: Record<TotalName, Change> = {
    chatTurns: { count: 0, previous: 0 }, salesUploads: { count: 0, previous: 0 },
    notesWritten: { count: 0, previous: 0 }, orderDecisions: { count: 0, previous: 0 },
  };
  for (const event of actions) {
    const day = utcDay(event.at);
    const current = inWindow(day);
    if (!current && !inPrevious(day)) continue;
    for (const name of Object.keys(TOTAL_ACTIONS) as TotalName[]) {
      if (event.action === TOTAL_ACTIONS[name]) counts[name][current ? 'count' : 'previous'] += 1;
    }
    const group = ACTION_GROUP[event.action];
    if (!current || group === null) continue;
    orgOf(event.orgId).actions += 1;
    const entry = perDay.get(day);
    if (entry !== undefined) entry.actions[group] += 1;
  }
  const comparable = hasPrevious(window, recordingSince);
  return {
    recordingSince,
    totals: {
      activeOrgs: { count: orgs.now.size, previous: comparable ? orgs.before.size : null },
      activePeople: { count: people.now.size, previous: comparable ? people.before.size : null },
      ...counts,
    },
    series: days.map((day) => {
      const entry = perDay.get(day);
      return { day, activePeople: entry?.people.size ?? 0, actions: entry?.actions ?? noActions() };
    }),
    byOrg: new Map([...perOrg].map(([orgId, org]) => [orgId, { activePeople: org.people.size, actions: org.actions, lastActiveDay: org.lastActiveDay }])),
  };
}

/** Actions in the window, most first, then name. */
export function sortOrgRows<T extends { readonly name: string; readonly actions: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
}

/** Needs attention's kinds, in the order the page lists them (design decision 5). */
export const ATTENTION_KINDS = [
  'request_waiting', 'refresh_off', 'refresh_paused', 'refresh_failed', 'no_recent_upload', 'in_setup', 'invites_waiting', 'chat_budget',
] as const;
export type AttentionKind = typeof ATTENTION_KINDS[number];

/** Ids, a count and a date only: the client builds each link (client/src/portal/console/links.ts). */
export interface AttentionItem {
  kind: AttentionKind;
  orgId: string | null;
  requestId: string | null;
  count: number | null;
  since: string | null;
}

export interface AttentionOrg {
  id: string;
  status: OrgRecord['status'];
  inSetup: boolean;
  createdAt: Date;
  locationCount: number;
  lastUploadAt: Date | null;
  /** Locations whose newest scheduled calibration failed or whose latest week row could not start, and the earliest failure. */
  failedLocations: { count: number; since: Date | null };
  /** Invitations open more than INVITE_WAITING_DAYS (openInvitesBefore); null when none. */
  invites: OpenInvites | null;
  chatSpentMicroUsd: number;
}

export interface AttentionFacts {
  now: Date;
  pendingRequests: readonly { readonly id: string; readonly createdAt: Date }[];
  /** The weekly refresh runs on this server (the lab runner and TOWNWISE_WEEKLY_FORECASTS). */
  refreshRunning: boolean;
  paused: { readonly at: Date } | null;
  orgs: readonly AttentionOrg[];
  chatBudgetMicroUsd: number;
}

/** Needs attention, independent of the window: in ATTENTION_KINDS order, then oldest first (no date first). */
export function attentionOf(facts: AttentionFacts): AttentionItem[] {
  const before = (days: number): number => facts.now.getTime() - days * DAY_MS;
  const items: AttentionItem[] = [];
  const add = (kind: AttentionKind, fields: Partial<Omit<AttentionItem, 'kind'>> = {}): void => {
    items.push({ kind, orgId: null, requestId: null, count: null, since: null, ...fields });
  };
  for (const request of facts.pendingRequests) {
    if (request.createdAt.getTime() < before(REQUEST_WAITING_DAYS)) add('request_waiting', { requestId: request.id, since: request.createdAt.toISOString() });
  }
  if (!facts.refreshRunning) add('refresh_off');
  if (facts.paused !== null) add('refresh_paused', { since: facts.paused.at.toISOString() });
  for (const org of facts.orgs) {
    const orgId = org.id;
    if (org.failedLocations.count > 0) {
      add('refresh_failed', { orgId, count: org.failedLocations.count, since: org.failedLocations.since?.toISOString() ?? null });
    }
    if (org.status === 'active' && !org.inSetup && org.locationCount > 0
      && (org.lastUploadAt === null || org.lastUploadAt.getTime() < before(NO_UPLOAD_DAYS))) {
      add('no_recent_upload', { orgId, since: org.lastUploadAt?.toISOString() ?? null });
    }
    if (org.inSetup) add('in_setup', { orgId, since: org.createdAt.toISOString() });
    if (org.invites !== null) add('invites_waiting', { orgId, count: org.invites.count, since: org.invites.oldest.toISOString() });
    if (facts.chatBudgetMicroUsd > 0 && org.chatSpentMicroUsd > facts.chatBudgetMicroUsd * CHAT_BUDGET_SHARE) add('chat_budget', { orgId });
  }
  const rank = (item: AttentionItem): number => ATTENTION_KINDS.indexOf(item.kind);
  return items.sort((a, b) => rank(a) - rank(b) || (a.since ?? '').localeCompare(b.since ?? ''));
}

/** One location's line: its forecast's health and the weekly refresh's. Never a guest count. */
export interface LocationLine {
  id: string;
  name: string;
  newestRun: { dataThrough: string; madeAt: string; engine: ForecastEngine } | null;
  /** The window's live accuracy over the town's passed days; null under 5 scored days. */
  accuracy: { days: number; inRange: number; typicalErrorPct: number | null } | null;
  refresh: { week: string; outcome: string } | null;
  lastScheduled: 'succeeded' | 'failed' | 'live' | null;
}

async function locationLine(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, days: OverviewDays,
  weeks: readonly ForecastWeekRecord[], calibrations: readonly CalibrationRecord[],
): Promise<{ line: LocationLine; failedAt: Date | null }> {
  // The window's passed days in the town: from `days` days before its today to its yesterday (at most 90, under 92).
  const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
  const read = await ctx.ports.forecasts.window(scope, location, { from: dayPlus(today, -days), to: dayPlus(today, -1) }, today);
  const [newest] = read.runs;
  const week = weeks.find((row) => row.locationId === location.id) ?? null;
  const scheduled = calibrations.find((each) => each.locationId === location.id && each.requestedBy.via === 'scheduled') ?? null;
  const failures = [
    scheduled?.status === 'failed' ? scheduled.finishedAt ?? scheduled.requestedAt : null,
    week?.status === 'start_failed' ? week.updatedAt : null,
  ].filter((at): at is Date => at !== null).sort((a, b) => a.getTime() - b.getTime());
  return {
    line: {
      id: location.id,
      name: location.name,
      newestRun: newest === undefined ? null : { dataThrough: newest.dataThrough, madeAt: newest.madeAt, engine: newest.engine },
      accuracy: read.accuracy === null ? null : { days: read.accuracy.days, inRange: read.accuracy.inRange, typicalErrorPct: read.accuracy.typicalErrorPct },
      refresh: week === null ? null : { week: week.week, outcome: week.status },
      lastScheduled: scheduled === null ? null : LIVE_STATUSES.includes(scheduled.status) ? 'live' : scheduled.status === 'failed' ? 'failed' : 'succeeded',
    },
    failedAt: failures[0] ?? null,
  };
}

/** The organization's own reads: whether it is in setup, its locations with their lines, and its refresh failures. */
async function orgDetails(ctx: TownwiseContext, staff: StaffPrincipal, org: OrgRecord, days: OverviewDays) {
  const scope = scopeForListedOrg(staff, org);
  const [inSetup, locations, weeks, calibrations] = await Promise.all([
    isInSetup(ctx, scope, org),
    ctx.stores.locations.list(scope),
    ctx.stores.forecastWeeks.latestByLocation(scope, utcDay(ctx.now(), -WEEK_ROWS_LOOKBACK_DAYS)),
    ctx.stores.calibrations.list(scope, CALIBRATIONS_READ),
  ]);
  const lines = await Promise.all(locations.map((location) => locationLine(ctx, scope, location, days, weeks, calibrations)));
  const failed = lines.flatMap((each) => (each.failedAt === null ? [] : [each.failedAt])).sort((a, b) => a.getTime() - b.getTime());
  return { inSetup, lines: lines.map((each) => each.line), failed: { count: failed.length, since: failed[0] ?? null } };
}

/**
 * GET /api/admin/overview?days=7|28|90 (staff): 200 { window, recordingSince, totals, series, schedule, orgs, attention }
 * (design decision 4). 400 for any other `days`.
 */
export async function getOverview(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const days = Number(parseInput(overviewQuery, req.query).days) as OverviewDays;
  const now = ctx.now();
  const window = overviewWindow(now, days);
  const [orgs, stats, activity, actions, invites, usage, pending, paused] = await Promise.all([
    ctx.stores.orgs.list(),
    adminOrgStats(ctx.connection),
    // Every stored day (the 180 kept): the window, the one before it, the record's first day and each last active day.
    activityDaysSince(ctx.connection, utcDay(now, -(ACTIVITY_KEEP_DAYS - 1))),
    peopleActionsSince(ctx.connection, new Date(`${window.previousFrom}T00:00:00.000Z`)),
    openInvitesBefore(ctx.connection, new Date(now.getTime() - INVITE_WAITING_DAYS * DAY_MS)),
    chatUsageForMonth(ctx.connection, now.toISOString().slice(0, 7)),
    ctx.stores.requests.listByStatus('pending'),
    ctx.stores.forecastSchedule.paused(),
  ]);
  const summary = summarize(window, activity, actions);
  const details = await Promise.all(orgs.map((org) => orgDetails(ctx, staff, org, days)));
  const budgetMicroUsd = Math.round(ctx.config.chatMonthlyBudgetUsd * 1_000_000);
  const rows = orgs.map((org, index) => {
    const counts = stats.get(org.id) ?? NO_ORG_STATS;
    const used = summary.byOrg.get(org.id);
    const detail = details[index];
    return {
      id: org.id, name: org.name, status: org.status, inSetup: detail?.inSetup ?? false,
      lastActiveDay: used?.lastActiveDay ?? null, activePeople: used?.activePeople ?? 0, actions: used?.actions ?? 0,
      salesDayCount: counts.salesDayCount, lastUploadAt: counts.lastUploadAt?.toISOString() ?? null, forecastsOn: org.forecasts.on,
      chat: { spentMicroUsd: usage.get(org.id) ?? 0, budgetMicroUsd },
      locations: detail?.lines ?? [],
    };
  });
  // The totals' "of": active organizations someone has joined, and the active seats in active organizations.
  const joined = orgs.filter((org, index) => org.status === 'active' && details[index]?.inSetup === false);
  const seats = orgs.filter((org) => org.status === 'active')
    .reduce((sum, org) => sum + (stats.get(org.id)?.adminCount ?? 0) + (stats.get(org.id)?.memberCount ?? 0), 0);
  const schedule = scheduleView(ctx, paused);
  const attention = attentionOf({
    now,
    pendingRequests: pending,
    refreshRunning: schedule.running,
    paused,
    chatBudgetMicroUsd: budgetMicroUsd,
    orgs: orgs.map((org, index) => ({
      id: org.id, status: org.status, inSetup: details[index]?.inSetup ?? false, createdAt: org.createdAt,
      locationCount: details[index]?.lines.length ?? 0, lastUploadAt: stats.get(org.id)?.lastUploadAt ?? null,
      failedLocations: details[index]?.failed ?? { count: 0, since: null }, invites: invites.get(org.id) ?? null,
      chatSpentMicroUsd: usage.get(org.id) ?? 0,
    })),
  });
  ctx.logger.info({ days, orgCount: orgs.length }, 'townwise.admin_overview_read');
  res.status(200).json({
    window,
    recordingSince: summary.recordingSince,
    totals: {
      // Never under the count: an organization suspended, or a person removed, after being active in the window still counts there.
      activeOrgs: { ...summary.totals.activeOrgs, of: Math.max(joined.length, summary.totals.activeOrgs.count) },
      activePeople: { ...summary.totals.activePeople, of: Math.max(seats, summary.totals.activePeople.count) },
      chatTurns: summary.totals.chatTurns,
      salesUploads: summary.totals.salesUploads,
      notesWritten: summary.totals.notesWritten,
      orderDecisions: summary.totals.orderDecisions,
    },
    series: summary.series,
    schedule,
    orgs: sortOrgRows(rows),
    attention,
  });
}
