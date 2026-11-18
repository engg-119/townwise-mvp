// Business rules (spec 6.24, 10.16, P29): standing facts about one location ("Closed Mondays") that TownwiseAI reads
// with every message. A rule may carry a schedule (D31), a note's fields but the detail, which the forecast read applies
// as it applies notes (spec 14.5); a rule without one never changes Townwise's forecast. Authors edit and delete their
// own; org admins edit and delete any. The text and the schedule are never logged; an audit event says only whether the
// rule has a schedule.
import { isDuplicateKeyError, objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { ruleSuggestionViews } from '../agent/rule-suggestion-views.ts';
import { utcDay } from '../dates.ts';
import { scheduleSummary } from '../forecasts/reasons.ts';
import { authorEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import { MAX_RULES, sameSeason, type BusinessRuleRecord, type RuleSchedule, type RuleVia } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { loadLocation, memberOf } from './locations.ts';
import { readRuleSchedule } from './notes.ts';
import { actorOf } from './team.ts';

export { MAX_RULES };

/** [CONFIRM: 30 business rules per location, 200 characters each] */
export const MAX_RULE_CHARS = 200;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/**
 * A rule's text: NFC, every run of whitespace (newlines included) one space, trimmed; then 1 to 200 code points with
 * no control or format character left. Null otherwise.
 */
export function ruleTextOf(raw: string): string | null {
  const text = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const length = Array.from(text).length;
  if (length < 1 || length > MAX_RULE_CHARS) return null;
  return CONTROL_OR_FORMAT.test(text) ? null : text;
}

/** Spec 10.16. */
export interface RuleView {
  id: string; text: string; addedVia: RuleVia; createdByEmail: string; createdAt: string; updatedAt: string; canEdit: boolean;
  /** The forecast effect (D31), as the request takes it; null when TownwiseAI reads the rule and the forecast doesn't change. */
  schedule: RuleSchedule | null;
  /** The schedule in plain words, built from its fields (scheduleSummary); null with no schedule. */
  scheduleSummary: string | null;
}

/** POST: the text, and a schedule (null or left out for none), checked by readRuleSchedule. */
const createBody = z.strictObject({ text: z.string().max(2000), schedule: z.unknown().optional() });
/** PATCH: either or both; a field left out keeps what it holds, and `schedule: null` takes the schedule off. */
const updateBody = z.strictObject({ text: z.string().max(2000).optional(), schedule: z.unknown().optional() })
  .refine((body) => body.text !== undefined || body.schedule !== undefined);

function invalid(): AppError {
  return new AppError(400, 'invalid_request', 'Invalid request');
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function ruleLimit(): AppError {
  return new AppError(409, 'rule_limit', 'This location has reached its business rule limit');
}

function ruleExists(): AppError {
  return new AppError(409, 'rule_exists', 'That rule is already saved');
}

/** The text in a request body; 400 invalid_request when the text rule fails. */
function ruleTextIn(raw: string): string {
  const text = ruleTextOf(raw);
  if (text === null) throw invalid();
  return text;
}

/** A schedule in a request body: null for none; 400 invalid_request when a note's rules refuse it (readRuleSchedule). */
function scheduleIn(raw: unknown, today: string): RuleSchedule | null {
  if (raw === null || raw === undefined) return null;
  const schedule = readRuleSchedule(raw, today);
  if (schedule === null) throw invalid();
  return schedule;
}

/** True when the two schedules say the same thing, field by field. */
export function sameSchedule(a: RuleSchedule | null, b: RuleSchedule | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.startDate === b.startDate && a.endDate === b.endDate && a.effect === b.effect
    && a.expectedGuests === b.expectedGuests && a.startTime === b.startTime && a.endTime === b.endTime
    && JSON.stringify(a.weekdays) === JSON.stringify(b.weekdays) && sameSeason(a.season, b.season);
}

function canEdit(caller: MemberPrincipal, rule: BusinessRuleRecord): boolean {
  return caller.role === 'org_admin' || rule.createdBy === caller.userId;
}

export function ruleView(rule: BusinessRuleRecord, createdByEmail: string, caller: MemberPrincipal): RuleView {
  return {
    id: rule.id,
    text: rule.text,
    addedVia: rule.addedVia,
    createdByEmail,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    canEdit: canEdit(caller, rule),
    schedule: rule.schedule,
    scheduleSummary: rule.schedule === null ? null : scheduleSummary(rule.schedule),
  };
}

/** The rule on this location, and the caller may change it: 404 before 403, so another location's rule reads as absent. */
async function editableRule(ctx: TownwiseContext, caller: MemberPrincipal, locationId: string, rawId: unknown): Promise<BusinessRuleRecord> {
  const rule = await ctx.stores.businessRules.find(caller.scope, locationId, parseInput(objectId, rawId));
  if (rule === null) throw notFound();
  if (!canEdit(caller, rule)) throw new AppError(403, 'forbidden', 'Forbidden');
  return rule;
}

/**
 * Adds a rule, with its schedule or none, to the location as the caller: the limit (409 rule_limit), the write, and
 * `rule.created`, which says only whether it has a schedule. A rule already
 * saved in another case or spacing is 409 rule_exists. Change, recount, revert: a write that finds more than 30 rules
 * after it deletes itself and answers 409 rule_limit, so two adds racing at 29 never leave 31 (both may revert). With
 * `id` (a TownwiseAI proposal's save), a rule that already holds it, made by an earlier try or a racing request, is
 * returned as it is, and only the request that wrote it records the event.
 */
export async function addRule(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, text: string,
  opts: { id?: string; via: RuleVia; schedule?: RuleSchedule | null },
): Promise<BusinessRuleRecord> {
  const { scope } = caller;
  const { businessRules } = ctx.stores;
  const { id, via } = opts;
  const schedule = opts.schedule ?? null;
  const existing = id === undefined ? null : await businessRules.find(scope, location.id, id);
  if (existing !== null) return existing;
  if (await businessRules.count(scope, location.id) >= MAX_RULES) throw ruleLimit();
  const now = ctx.now();
  let rule: BusinessRuleRecord;
  try {
    rule = await businessRules.create(scope, location.id, {
      text, schedule, addedVia: via, createdBy: caller.userId, now, ...(id === undefined ? {} : { id }),
      ...(caller.openAsAdmin !== null ? { byStaff: true } : {}),
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = id === undefined ? null : await businessRules.find(scope, location.id, id);
    if (raced !== null) return raced;
    throw ruleExists();
  }
  if (await businessRules.count(scope, location.id) > MAX_RULES) {
    await businessRules.remove(scope, location.id, rule.id);
    throw ruleLimit();
  }
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'rule.created',
    target: { type: 'rule', id: rule.id },
    details: { locationId: location.id, via, scheduled: rule.schedule !== null },
  });
  return rule;
}

/**
 * GET /api/org/locations/:locationId/rules, oldest first, with (D46) `suggested`: the open suggested closure rules from
 * files and the sales history (agent/rule-suggestion-views.ts), which P29 lists above Add a rule.
 */
export async function listRules(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const [rules, suggested] = await Promise.all([
    ctx.stores.businessRules.list(caller.scope, location.id), ruleSuggestionViews(ctx, caller, location),
  ]);
  const authors = [...new Set(rules.filter((rule) => !rule.byStaff).map((rule) => rule.createdBy))];
  const emails = new Map(await Promise.all(authors.map(async (userId) => [userId, await authorEmail(ctx, userId, false)] as const)));
  res.status(200).json({
    rules: rules.map((rule) => ruleView(rule, rule.byStaff ? TOWNWISE_STAFF : emails.get(rule.createdBy) ?? DELETED_PERSON, caller)),
    limit: MAX_RULES,
    suggested,
  });
}

/** POST /api/org/locations/:locationId/rules. */
export async function createRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const body = parseInput(createBody, req.body);
  const text = ruleTextIn(body.text);
  const schedule = scheduleIn(body.schedule, utcDay(ctx.now()));
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const rule = await addRule(ctx, caller, location, text, { via: 'page', schedule });
  res.status(201).json({ rule: ruleView(rule, rule.byStaff ? TOWNWISE_STAFF : caller.email, caller) });
}

/**
 * A schedule an edit sends with no `season` key keeps the stored rule's season (D46): a client from before seasons
 * never sends one, and must not turn a yearly rule into every day. `season: null` takes it off.
 */
function keepingSeason(raw: unknown, stored: RuleSchedule | null): unknown {
  const season = stored?.season ?? null;
  if (season === null || typeof raw !== 'object' || raw === null || Array.isArray(raw) || 'season' in raw) return raw;
  return { ...raw, season };
}

/**
 * PATCH /api/org/locations/:locationId/rules/:ruleId, by the author or an org admin. Only the fields that differ from
 * the stored rule are written, so an edit of the text and another of the schedule racing both land, and a field the
 * request leaves out (or sends unchanged) keeps whatever a racing edit wrote. Nothing different writes nothing. A
 * schedule with no `season` key keeps the stored season (keepingSeason).
 */
export async function updateRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(updateBody, req.body);
  const text = body.text === undefined ? undefined : ruleTextIn(body.text);
  // Checked before any read, so a bad schedule is 400 whatever the rule.
  if (body.schedule !== undefined) scheduleIn(body.schedule, utcDay(ctx.now()));
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const existing = await editableRule(ctx, caller, location.id, req.params.ruleId);
  const schedule = body.schedule === undefined ? undefined : scheduleIn(keepingSeason(body.schedule, existing.schedule), utcDay(ctx.now()));
  const change = {
    ...(text === undefined || text === existing.text ? {} : { text }),
    ...(schedule === undefined || sameSchedule(schedule, existing.schedule) ? {} : { schedule }),
  };
  let rule = existing;
  if (change.text !== undefined || change.schedule !== undefined) {
    const now = ctx.now();
    let updated: BusinessRuleRecord | null;
    try {
      updated = await ctx.stores.businessRules.update(scope, location.id, existing.id, change, now);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw ruleExists();
      throw err;
    }
    if (updated === null) throw notFound();
    rule = updated;
    await recordAfter(ctx, {
      ...actorOf(caller), at: now, orgId: scope.orgId, action: 'rule.updated',
      target: { type: 'rule', id: rule.id },
      details: { locationId: location.id, scheduled: rule.schedule !== null },
    });
  }
  res.status(200).json({ rule: ruleView(rule, await authorEmail(ctx, rule.createdBy, rule.byStaff), caller) });
}

/** DELETE /api/org/locations/:locationId/rules/:ruleId, by the author or an org admin. */
export async function deleteRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const rule = await editableRule(ctx, caller, location.id, req.params.ruleId);
  if (!(await ctx.stores.businessRules.remove(scope, location.id, rule.id))) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'rule.deleted',
    target: { type: 'rule', id: rule.id },
    details: { locationId: location.id },
  });
  res.status(204).end();
}
