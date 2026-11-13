// Business rules (spec 6.24, 10.16, P28): standing facts about one location ("Closed Mondays") that TownwiseAI reads
// with every message. They never change Townwise's forecast. Authors edit and delete their own; org admins edit and
// delete any. The text is never logged and never copied into an audit event.
import { isDuplicateKeyError, objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { authorEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import { MAX_RULES, type BusinessRuleRecord, type RuleVia } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { loadLocation, memberOf } from './locations.ts';
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
}

const ruleBody = z.strictObject({ text: z.string().max(2000) });

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

/** The rule in a request body; 400 invalid_request when the body or the text rule fails. */
function ruleTextIn(raw: unknown): string {
  const text = ruleTextOf(parseInput(ruleBody, raw).text);
  if (text === null) throw invalid();
  return text;
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
 * Adds a rule to the location as the caller: the limit (409 rule_limit), the write, and `rule.created`. A rule already
 * saved in another case or spacing is 409 rule_exists. Change, recount, revert: a write that finds more than 30 rules
 * after it deletes itself and answers 409 rule_limit, so two adds racing at 29 never leave 31 (both may revert). With
 * `id` (a TownwiseAI proposal's save), a rule that already holds it, made by an earlier try or a racing request, is
 * returned as it is, and only the request that wrote it records the event.
 */
export async function addRule(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, text: string, opts: { id?: string; via: RuleVia },
): Promise<BusinessRuleRecord> {
  const { scope } = caller;
  const { businessRules } = ctx.stores;
  const { id, via } = opts;
  const existing = id === undefined ? null : await businessRules.find(scope, location.id, id);
  if (existing !== null) return existing;
  if (await businessRules.count(scope, location.id) >= MAX_RULES) throw ruleLimit();
  const now = ctx.now();
  let rule: BusinessRuleRecord;
  try {
    rule = await businessRules.create(scope, location.id, {
      text, addedVia: via, createdBy: caller.userId, now, ...(id === undefined ? {} : { id }),
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
    details: { locationId: location.id, via },
  });
  return rule;
}

/** GET /api/org/locations/:locationId/rules, oldest first. */
export async function listRules(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const rules = await ctx.stores.businessRules.list(caller.scope, location.id);
  const authors = [...new Set(rules.filter((rule) => !rule.byStaff).map((rule) => rule.createdBy))];
  const emails = new Map(await Promise.all(authors.map(async (userId) => [userId, await authorEmail(ctx, userId, false)] as const)));
  res.status(200).json({
    rules: rules.map((rule) => ruleView(rule, rule.byStaff ? TOWNWISE_STAFF : emails.get(rule.createdBy) ?? DELETED_PERSON, caller)),
    limit: MAX_RULES,
  });
}

/** POST /api/org/locations/:locationId/rules. */
export async function createRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const text = ruleTextIn(req.body);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const rule = await addRule(ctx, caller, location, text, { via: 'page' });
  res.status(201).json({ rule: ruleView(rule, rule.byStaff ? TOWNWISE_STAFF : caller.email, caller) });
}

/** PATCH /api/org/locations/:locationId/rules/:ruleId, by the author or an org admin. The same text writes nothing. */
export async function updateRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const text = ruleTextIn(req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const existing = await editableRule(ctx, caller, location.id, req.params.ruleId);
  let rule = existing;
  if (text !== existing.text) {
    const now = ctx.now();
    let replaced: BusinessRuleRecord | null;
    try {
      replaced = await ctx.stores.businessRules.replaceText(scope, location.id, existing.id, text, now);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw ruleExists();
      throw err;
    }
    if (replaced === null) throw notFound();
    rule = replaced;
    await recordAfter(ctx, {
      ...actorOf(caller), at: now, orgId: scope.orgId, action: 'rule.updated',
      target: { type: 'rule', id: rule.id },
      details: { locationId: location.id },
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
