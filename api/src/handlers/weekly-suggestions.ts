// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions, spec 10.12, P25): the org admin's
// switch, and accepting or dismissing a suggestion the weekly pass made (lab/suggestions.ts). Suggestions are listed by
// GET .../agent (handlers/agent.ts) through suggestionsPanel below.
//
// Accepting writes the note or the business rule through the notes and rules code, as written by that admin, with the
// suggestion's id as the note's or rule's id, then marks the suggestion accepted by compare-and-set. There are no
// transactions, so a retry, a crash between the steps or a second tab end with one note or rule, and only the request
// whose compare-and-set lands records `agent.suggestion_accepted`. A dismiss racing an accept that already wrote its
// note loses to it: the note exists, so the dismiss finishes the accept instead (an accept that died between its two
// steps included). A suggestion whose first date is today or past in the town is gone (404), as an
// unknown id or another organization's is. Only org admins decide, outside view-as (staff open as admin among them, D25);
// members read.
// Logs and audit events carry ids, the type and the switch's state only.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { applyRecorded, recordAfter, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { scheduleSummary } from '../forecasts/reasons.ts';
import { authorEmail } from '../people.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { SuggestionRecord } from '../stores/agent-suggestions.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent } from '../stores/notes.ts';
import { SUGGESTIONS_SEEN_MS } from '../lab/schedule.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { townEvents } from '../town-calendar.ts';
import { utcDay } from '../dates.ts';
import { loadLocation } from './locations.ts';
import { addNote, noteView, type NoteView } from './notes.ts';
import { addRule, ruleView, type RuleView } from './rules.ts';
import { actorOf, assertOpenAsAdminTab, orgAdmin } from './team.ts';

/** `orgId`, the organization the page shows, is required in open as admin (D25), as renaming the organization's is. */
const switchBody = z.strictObject({ on: z.boolean(), orgId: objectId.optional() });
/** Accept and dismiss carry nothing. */
const decideBody = z.strictObject({});

/** A calendar entry a suggestion rests on, as the panel names it: public data only. */
export interface SuggestionCalendarView { id: string; title: string; start: string; end: string }

/** A suggestion as the panel shows it (open, its first date after today in the town). */
export type SuggestionView = {
  id: string; why: string; calendar: SuggestionCalendarView[]; createdAt: string;
} & (
  | { type: 'note'; note: NoteContent }
  | { type: 'rule'; text: string; schedule: RuleSchedule; scheduleSummary: string }
);

/** Whether weekly suggestions run for the organization, whether they can run at all here, and whether the caller decides. */
export interface WeeklySuggestionsView {
  /** The organization's switch: on unless an org admin turned it off. */
  on: boolean;
  /**
   * Passes run here: TOWNWISE_WEEKLY_SUGGESTIONS is true, the weekly worker ran them within the last 3 hours (the
   * schedule document's `suggestionsAt`, which only a worker with its own ANTHROPIC_API_KEY sets), and staff have not
   * paused it.
   */
  available: boolean;
  /** An org admin outside view-as: turns the switch and accepts or dismisses suggestions. */
  canChange: boolean;
}

export interface DecideResult {
  suggestion: { id: string; status: 'accepted' | 'dismissed' };
  /** The note or rule an accepted suggestion wrote, or null (dismissed, or deleted since). */
  note: NoteView | null;
  rule: RuleView | null;
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** An org admin outside view-as (staff open as admin borrow the org admin role, D25). */
export function decides(caller: MemberPrincipal): boolean {
  return caller.role === 'org_admin' && caller.viewAs === null;
}

/** The calendar entries the views name, by id: the town's, from a year back to 400 days on. */
function calendarById(location: LocationRecord, today: string): Map<string, SuggestionCalendarView> {
  const at = (days: number): string => utcDay(new Date(`${today}T00:00:00.000Z`), days);
  return new Map(townEvents(location.town.townId, { from: at(-366), to: at(400) })
    .map((event) => [event.id, { id: event.id, title: event.title, start: event.start, end: event.end }]));
}

function suggestionView(record: SuggestionRecord, calendar: ReadonlyMap<string, SuggestionCalendarView>): SuggestionView {
  const shared = {
    id: record.id, why: record.why, createdAt: record.createdAt.toISOString(),
    calendar: record.calendarIds.flatMap((id) => {
      const entry = calendar.get(id);
      return entry === undefined ? [] : [entry];
    }),
  };
  return record.type === 'note'
    ? { ...shared, type: 'note', note: record.note }
    : { ...shared, type: 'rule', text: record.text, schedule: record.schedule, scheduleSummary: scheduleSummary(record.schedule) };
}

/** The town's today for a location. */
function todayAt(ctx: TownwiseContext, location: LocationRecord): string {
  return localDay(ctx.now(), timeZoneOf(location.town).timeZone);
}

/** GET .../agent's suggestions part: the open suggestions whose first date is after today, and the switch. */
export async function suggestionsPanel(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord,
): Promise<{ suggestions: SuggestionView[]; weeklySuggestions: WeeklySuggestionsView }> {
  const today = todayAt(ctx, location);
  const [org, open, worker] = await Promise.all([
    ctx.stores.orgs.findById(caller.scope.orgId),
    ctx.stores.agentSuggestions.listOpen(caller.scope, location.id, today),
    ctx.stores.forecastSchedule.suggestionsState(),
  ]);
  const seen = worker.ranAt !== null && ctx.now().getTime() - worker.ranAt.getTime() <= SUGGESTIONS_SEEN_MS;
  const calendar = calendarById(location, today);
  return {
    suggestions: open.map((record) => suggestionView(record, calendar)),
    weeklySuggestions: {
      on: org?.weeklySuggestions.on ?? true,
      available: ctx.config.weeklySuggestions && seen && !worker.paused,
      canChange: decides(caller),
    },
  };
}

/**
 * PATCH /api/org/weekly-suggestions { on, orgId? } (org admin, outside view-as): 200 { weeklySuggestions }. A
 * change records `org.weekly_suggestions_changed` before it is applied; the same state again writes nothing. In open as
 * admin a missing or other `orgId` answers 409 open_as_admin_active (assertOpenAsAdminTab).
 */
export async function switchWeeklySuggestions(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const { on } = parseInput(switchBody, req.body);
  assertOpenAsAdminTab(admin, req.body);
  const org = await ctx.stores.orgs.findById(scope.orgId);
  // Only a deletion racing this request gets here; the client re-reads /api/me.
  if (org === null) throw new AppError(403, 'no_access', 'No access');
  if (org.weeklySuggestions.on !== on) {
    const now = ctx.now();
    const event: AuditEventInput = {
      ...actorOf(admin), at: now, orgId: scope.orgId, action: 'org.weekly_suggestions_changed', target: { type: 'org', id: scope.orgId },
      details: { on },
    };
    const eventId = await recordBefore(ctx, event);
    if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.orgs.setWeeklySuggestions(scope, { on, at: now, by: admin.userId })))) {
      await recordNotApplied(ctx, event, eventId, 'not_found');
      throw new AppError(403, 'no_access', 'No access');
    }
  }
  ctx.logger.info({ orgId: scope.orgId, on }, 'townwise.weekly_suggestions_switched');
  res.status(200).json({ weeklySuggestions: { on } });
}

/** Whether the note or rule an accept writes for this suggestion (with its id) exists. */
async function wasWritten(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: SuggestionRecord): Promise<boolean> {
  return record.type === 'note'
    ? (await ctx.stores.notes.find(caller.scope, location.id, record.id)) !== null
    : (await ctx.stores.businessRules.find(caller.scope, location.id, record.id)) !== null;
}

/** Marks it accepted by compare-and-set; only the request whose compare-and-set lands records `agent.suggestion_accepted`. */
async function markAccepted(ctx: TownwiseContext, admin: MemberPrincipal, location: LocationRecord, record: SuggestionRecord): Promise<void> {
  const { scope } = admin;
  if (await ctx.stores.agentSuggestions.markAccepted(scope, location.id, record.id, { by: admin.userId, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'agent.suggestion_accepted',
      target: { type: 'location', id: location.id },
      details: { locationId: location.id, suggestionId: record.id, type: record.type },
    });
  }
}

/** The note or rule an accepted suggestion wrote, as the caller sees it; null when it was deleted since. */
async function writtenView(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: SuggestionRecord,
): Promise<Pick<DecideResult, 'note' | 'rule'>> {
  const { scope } = caller;
  if (record.type === 'note') {
    const note = await ctx.stores.notes.find(scope, location.id, record.id);
    return { note: note === null ? null : noteView(note, await authorEmail(ctx, note.createdBy, note.byStaff), caller), rule: null };
  }
  const rule = await ctx.stores.businessRules.find(scope, location.id, record.id);
  return { note: null, rule: rule === null ? null : ruleView(rule, await authorEmail(ctx, rule.createdBy, rule.byStaff), caller) };
}

/** The suggestion named by the path, of this location; 404 for anything else. */
async function suggestionOf(ctx: TownwiseContext, caller: MemberPrincipal, req: Request): Promise<{ location: LocationRecord; record: SuggestionRecord }> {
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const id = parseInput(objectId, req.params.suggestionId);
  const record = await ctx.stores.agentSuggestions.find(caller.scope, location.id, id);
  if (record === null) throw notFound();
  return { location, record };
}

/** Open, and its first date is still after today in the town. */
function isOpen(ctx: TownwiseContext, location: LocationRecord, record: SuggestionRecord): boolean {
  return record.status === 'open' && record.firstDate > todayAt(ctx, location);
}

/**
 * POST /api/org/locations/:locationId/agent/suggestions/:suggestionId/accept {} (org admin): 200 DecideResult. An
 * accepted one answers what it wrote; a dismissed or expired one, or an unknown id, 404. The note limit (409
 * note_limit), the rule limit (409 rule_limit) and a rule already saved in other case (409 rule_exists) leave it open.
 */
export async function acceptSuggestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  parseInput(decideBody, req.body);
  const { location, record } = await suggestionOf(ctx, admin, req);
  if (record.status !== 'accepted') {
    if (!isOpen(ctx, location, record)) throw notFound();
    // The note or rule takes the suggestion's id, so a retry or a second tab finds the one already written.
    if (record.type === 'note') await addNote(ctx, admin, location, record.note, { id: record.id });
    else await addRule(ctx, admin, location, record.text, { id: record.id, via: 'townwise_ai', schedule: record.schedule });
    await markAccepted(ctx, admin, location, record);
  }
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, suggestionId: record.id, decision: 'accepted' }, 'townwise.agent_suggestion');
  const body: DecideResult = { suggestion: { id: record.id, status: 'accepted' }, ...await writtenView(ctx, admin, location, record) };
  res.status(200).json(body);
}

/**
 * POST /api/org/locations/:locationId/agent/suggestions/:suggestionId/dismiss {} (org admin): 200 DecideResult. One
 * an accept got to first answers as accepted, with what it wrote: also one whose note or rule an accept wrote without
 * reaching its compare-and-set (it died, or a store error answered 500), which this finishes accepting, recording
 * `agent.suggestion_accepted`. An expired one or an unknown id, 404.
 */
export async function dismissSuggestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  parseInput(decideBody, req.body);
  const { location, record } = await suggestionOf(ctx, admin, req);
  if (record.status === 'open' && !isOpen(ctx, location, record)) throw notFound();
  if (record.status === 'expired') throw notFound();
  if (record.status !== 'accepted' && await wasWritten(ctx, admin, location, record)) await markAccepted(ctx, admin, location, record);
  else if (await ctx.stores.agentSuggestions.markDismissed(scope, location.id, record.id, { by: admin.userId, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'agent.suggestion_dismissed',
      target: { type: 'location', id: location.id },
      details: { locationId: location.id, suggestionId: record.id, type: record.type },
    });
  }
  const now = await ctx.stores.agentSuggestions.find(scope, location.id, record.id);
  if (now === null) throw notFound();
  const status = now.status === 'accepted' ? 'accepted' : 'dismissed';
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, suggestionId: record.id, decision: status }, 'townwise.agent_suggestion');
  const written = status === 'accepted' ? await writtenView(ctx, admin, location, now) : { note: null, rule: null };
  const body: DecideResult = { suggestion: { id: record.id, status }, ...written };
  res.status(200).json(body);
}
