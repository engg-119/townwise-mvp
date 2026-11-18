// Suggested closure rules (openspec change suggest-closure-rules, D46, P29, P25): any member, outside view-as (staff open
// as admin among them), confirms, edits or dismisses a file or sales suggestion through
// POST .../agent/rule-suggestions/:suggestionId/accept and .../dismiss. A weekly suggestion is 404 here before any
// write; the weekly routes (handlers/weekly-suggestions.ts) take those, for org admins. [CONFIRM: any member confirms,
// edits or dismisses a suggested closure rule; weekly suggestions stay with org admins]
//
// Confirm writes the suggestion's rule, and Edit the rule in the body, through the rules code as the caller, added by
// TownwiseAI, with the suggestion's id as the rule's id; then a compare-and-set marks the suggestion accepted, and only
// the request whose compare-and-set lands records `agent.suggestion_accepted`, with `edited` worked out from the stored
// rule. No transactions: a retry or a second tab finds the rule by its id, and a request that would write other words or
// another schedule than the stored rule finishes that accept if it is still open, then answers 409 already_decided with it. A dismiss that finds the rule written
// finishes the accept instead. A suggestion whose end has passed in the town is gone (404), as an unknown id or another
// organization's is. 409 rule_limit and rule_exists leave it open. Logs and audit events carry ids, the source and
// whether it was edited only: never the rule's words, its schedule or the file's name.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { closureKeyOf, closureRuleText } from '../agent/closure-suggestions.ts';
import { isLive, SALES_ID, salesSuggestions, townToday } from '../agent/rule-suggestion-views.ts';
import { utcDay } from '../dates.ts';
import { authorEmail } from '../people.ts';
import type { SuggestionRecord } from '../stores/agent-suggestions.ts';
import type { BusinessRuleRecord, RuleSchedule } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { loadLocation, memberOf } from './locations.ts';
import { readRuleSchedule } from './notes.ts';
import { addRule, ruleTextOf, ruleView, sameSchedule, type RuleView } from './rules.ts';
import { actorOf } from './team.ts';

/** A stored suggestion's id, or a sales suggestion's not stored yet (`sales_weekday_{d}`). */
const suggestionIdSchema = z.union([objectId, z.string().regex(SALES_ID)]);
/** Confirm sends nothing; Edit sends the rule's words and its schedule (null or left out for none). */
const acceptBody = z.strictObject({ rule: z.strictObject({ text: z.string().max(2000), schedule: z.unknown().optional() }).optional() });
const dismissBody = z.strictObject({});

/** What a decision answers: the suggestion's stored id and status, and the rule an accepted one wrote (null otherwise, or once deleted). */
export interface RuleDecideResult {
  suggestion: { id: string; status: 'accepted' | 'dismissed' };
  rule: RuleView | null;
}

/** A file or sales suggestion: its rule's words and schedule. */
type RuleRecord = SuggestionRecord & { type: 'rule' };

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function invalid(): AppError {
  return new AppError(400, 'invalid_request', 'Invalid request');
}

/** True when the stored rule has these words and this schedule. */
function sameRule(rule: BusinessRuleRecord, text: string, schedule: RuleSchedule | null): boolean {
  return rule.text === text && sameSchedule(rule.schedule, schedule);
}

/**
 * Marks the suggestion accepted by compare-and-set, from open or dismissed, and only when it lands records
 * `agent.suggestion_accepted` with its source and whether the stored rule differs from the suggestion. Undo uses it too
 * (handlers/data.ts), for a suggestion whose rule a confirm wrote before undo ran.
 */
export async function finishAccepted(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: RuleRecord, rule: BusinessRuleRecord,
): Promise<boolean> {
  const { scope } = caller;
  if (!(await ctx.stores.agentSuggestions.markAccepted(scope, location.id, record.id, { by: caller.userId, now: ctx.now() }))) return false;
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.suggestion_accepted', target: { type: 'location', id: location.id },
    details: {
      locationId: location.id, suggestionId: record.id, type: 'rule', source: record.source, edited: !sameRule(rule, record.text, record.schedule),
    },
  });
  return true;
}

/** The Monday that starts `day`'s week. */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return utcDay(new Date(`${day}T00:00:00.000Z`), -((weekday + 6) % 7));
}

/**
 * `sales_weekday_{d}` as a stored row: the row already holding its closure key (a file's, or one an earlier decide
 * stored), else the sales history's evidence recomputed (404 when it no longer holds, as a stale question is) and
 * stored open, under a new id; a racing decide that stored it first is found by the key, so two tabs end with one row.
 */
async function storedSalesSuggestion(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, weekday: number): Promise<RuleRecord> {
  const { scope } = caller;
  const store = ctx.stores.agentSuggestions;
  const key = closureKeyOf({
    kind: 'closure', startDate: '', endDate: null, weekdays: [weekday], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
  });
  const byKey = async (): Promise<RuleRecord> => {
    const row = await store.findByKey(scope, location.id, key);
    if (row?.type !== 'rule' || row.source === 'weekly') throw notFound();
    return row;
  };
  if (await store.findByKey(scope, location.id, key) !== null) return byKey();
  const found = (await salesSuggestions(ctx, scope, location.id)).find((each) => each.weekday === weekday);
  if (found === undefined) throw notFound();
  const stored = await store.insertOne(scope, {
    id: new Types.ObjectId().toHexString(), locationId: location.id, week: mondayOf(townToday(ctx, location)), source: 'sales',
    text: closureRuleText(found.schedule), schedule: found.schedule, closureKey: key, evidence: found.evidence, now: ctx.now(),
  });
  if (stored === null) return byKey();
  const { record } = stored;
  if (record.type !== 'rule') throw notFound();
  return record;
}

/**
 * The file or sales suggestion the path names, of this location; 404 for a weekly one, an unknown id or another
 * location's. A `sales_weekday_{d}` id is stored first (storedSalesSuggestion).
 */
async function suggestionOf(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, rawId: unknown): Promise<RuleRecord> {
  const id = parseInput(suggestionIdSchema, rawId);
  const sales = SALES_ID.exec(id);
  if (sales !== null) return storedSalesSuggestion(ctx, caller, location, Number(sales[1]));
  const record = await ctx.stores.agentSuggestions.find(caller.scope, location.id, id);
  if (record?.type !== 'rule' || record.source === 'weekly') throw notFound();
  return record;
}

async function viewOf(ctx: TownwiseContext, caller: MemberPrincipal, rule: BusinessRuleRecord | null): Promise<RuleView | null> {
  return rule === null ? null : ruleView(rule, await authorEmail(ctx, rule.createdBy, rule.byStaff), caller);
}

/**
 * POST /api/org/locations/:locationId/agent/rule-suggestions/:suggestionId/accept {} or { rule: { text, schedule } }
 * (member): 200 RuleDecideResult. The rule text and schedule are checked as P29's add checks them (400 invalid_request).
 * An accepted one answers what it wrote; a dismissed or expired one, or a weekly or unknown id, 404. A rule already under
 * its id with other words or another schedule: 409 already_decided with that rule.
 */
export async function acceptRuleSuggestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(acceptBody, req.body);
  const edit = body.rule === undefined ? null : (() => {
    const text = ruleTextOf(body.rule.text);
    const raw = body.rule.schedule;
    const schedule = raw === undefined || raw === null ? null : readRuleSchedule(raw, utcDay(ctx.now()));
    if (text === null || (raw !== undefined && raw !== null && schedule === null)) throw invalid();
    return { text, schedule };
  })();
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const record = await suggestionOf(ctx, caller, location, req.params.suggestionId);
  const wanted = edit ?? { text: record.text, schedule: record.schedule };
  let rule = await ctx.stores.businessRules.find(scope, location.id, record.id);
  if (rule === null) {
    if (record.status === 'accepted') {
      // Accepted, and its rule deleted since.
      const accepted: RuleDecideResult = { suggestion: { id: record.id, status: 'accepted' }, rule: null };
      res.status(200).json(accepted);
      return;
    }
    if (!isLive(record, townToday(ctx, location))) throw notFound();
    // The rule takes the suggestion's id, so a retry or a second tab finds the one already written.
    rule = await addRule(ctx, caller, location, wanted.text, { id: record.id, via: 'townwise_ai', schedule: wanted.schedule });
  }
  const view = await viewOf(ctx, caller, rule);
  // The rule is there: an accept that wrote it and stopped before its compare-and-set is finished first, as dismiss does,
  // so the suggestion never stays open beside its rule (UI review S5).
  if (record.status !== 'accepted') await finishAccepted(ctx, caller, location, record, rule);
  if (!sameRule(rule, wanted.text, wanted.schedule)) {
    res.status(409).json({ error: 'already_decided', message: 'This suggestion was already confirmed as another rule.', rule: view });
    return;
  }
  ctx.logger.info({
    orgId: scope.orgId, locationId: location.id, suggestionId: record.id, decision: 'accepted', source: record.source,
    edited: !sameRule(rule, record.text, record.schedule),
  }, 'townwise.agent_suggestion');
  const result: RuleDecideResult = { suggestion: { id: record.id, status: 'accepted' }, rule: view };
  res.status(200).json(result);
}

/**
 * POST /api/org/locations/:locationId/agent/rule-suggestions/:suggestionId/dismiss {} (member): 200 RuleDecideResult.
 * One an accept got to first answers as accepted, with its rule: also one whose rule an accept wrote without reaching its
 * compare-and-set, which this finishes accepting. An expired one, or a weekly or unknown id, 404.
 */
export async function dismissRuleSuggestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  parseInput(dismissBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const record = await suggestionOf(ctx, caller, location, req.params.suggestionId);
  if (record.status === 'expired' || (record.status === 'open' && !isLive(record, townToday(ctx, location)))) throw notFound();
  const written = record.status === 'accepted' ? null : await ctx.stores.businessRules.find(scope, location.id, record.id);
  if (written !== null) await finishAccepted(ctx, caller, location, record, written);
  else if (await ctx.stores.agentSuggestions.markDismissed(scope, location.id, record.id, { by: caller.userId, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.suggestion_dismissed', target: { type: 'location', id: location.id },
      details: { locationId: location.id, suggestionId: record.id, type: 'rule', source: record.source },
    });
    // A confirm that wrote its rule meanwhile wins, as it would have had it marked first: the rule exists, so this
    // finishes the accept and answers it, rather than "dismissed" over a rule that stands.
    const raced = await ctx.stores.businessRules.find(scope, location.id, record.id);
    if (raced !== null) await finishAccepted(ctx, caller, location, record, raced);
  }
  const now = await ctx.stores.agentSuggestions.find(scope, location.id, record.id);
  if (now === null) throw notFound();
  const status = now.status === 'accepted' ? 'accepted' : 'dismissed';
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, suggestionId: record.id, decision: status, source: record.source }, 'townwise.agent_suggestion');
  const rule = status === 'accepted' ? await ctx.stores.businessRules.find(scope, location.id, record.id) : null;
  const result: RuleDecideResult = { suggestion: { id: record.id, status }, rule: await viewOf(ctx, caller, rule) };
  res.status(200).json(result);
}
