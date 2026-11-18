import { z } from 'zod';

import { ApiError, type ApiClient } from '../../api/client';
import { NOTE_EFFECTS, NOTE_KINDS } from '../locations/api';
import type { ScheduleInput } from '../locations/noteRules';

// The Business rules routes (spec 10.16, api/src/handlers/rules.ts), through the portal ApiClient. `z.object` strips
// unknown keys.

function rulesPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/rules`;
}

/** D46: a yearly season, 'MM-DD' to 'MM-DD' both inclusive; `to` before `from` crosses the new year. */
export const ruleSeasonSchema = z.object({ repeat: z.literal('yearly'), from: z.string(), to: z.string() });
export type RuleSeason = z.infer<typeof ruleSeasonSchema>;

/**
 * A rule's schedule (D31): a note's fields but its detail, with `endDate` null for no end, and (D46) a yearly season,
 * absent or null for none, with `endDate` null.
 */
export const ruleScheduleSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  startDate: z.string(),
  endDate: z.string().nullable(),
  weekdays: z.array(z.number()).nullable(),
  effect: z.enum(NOTE_EFFECTS),
  expectedGuests: z.number().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  season: ruleSeasonSchema.nullish(),
});
export type RuleSchedule = z.infer<typeof ruleScheduleSchema>;

/**
 * Spec 10.16 RuleView. `canEdit`: the author, or an org admin. `createdByEmail` may be “Townwise staff” or “Deleted
 * person”. `schedule` and `scheduleSummary` (the API's words for it) are null, or missing from an API before
 * schedules, when the rule changes nothing in the forecast.
 */
export const ruleSchema = z.object({
  id: z.string(),
  text: z.string(),
  addedVia: z.enum(['page', 'townwise_ai']),
  createdByEmail: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
  schedule: ruleScheduleSchema.nullish(),
  scheduleSummary: z.string().nullish(),
});
export type Rule = z.infer<typeof ruleSchema>;

/**
 * D46: a suggested closure rule from a file TownwiseAI read or from the sales history (api/src/agent/rule-suggestion-views.ts
 * RuleSuggestionView). `text` and `scheduleSummary` are Townwise's words, shown as sent. `file`: the item it came from
 * (its name null under view-as), null once deleted or for the sales history; `evidence`: the sales history's day
 * counts and its last day with sales. `canDecide`: any member outside view-as. Its id is a stored id, or
 * `sales_weekday_{d}` while the sales history's suggestion is not stored yet.
 */
export const ruleSuggestionSchema = z.object({
  id: z.string(),
  source: z.enum(['file', 'sales']),
  text: z.string(),
  schedule: ruleScheduleSchema,
  scheduleSummary: z.string(),
  file: z.object({ ref: z.string(), title: z.string().nullable() }).nullable(),
  evidence: z.object({ noSalesCount: z.number(), weekdayCount: z.number(), lastSalesDate: z.string().nullable() }).nullable(),
  canDecide: z.boolean(),
});
export type RuleSuggestion = z.infer<typeof ruleSuggestionSchema>;

/** Items read one by one: a suggestion this client can't read (a source it doesn't know) is left out. */
export function knownRuleSuggestions(items: readonly unknown[]): RuleSuggestion[] {
  return items.flatMap((item) => {
    const parsed = ruleSuggestionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** GET .../rules: oldest first, with the location's limit and (D46) its open suggested rules, absent before them. */
export const rulesSchema = z.object({ rules: z.array(ruleSchema), limit: z.number(), suggested: z.array(z.unknown()).optional() });
export interface RulesList { rules: Rule[]; limit: number; suggested: RuleSuggestion[] }

const savedRuleSchema = z.object({ rule: ruleSchema });

export async function fetchRules(api: ApiClient, locationId: string): Promise<RulesList> {
  const { rules, limit, suggested } = await api.json(rulesPath(locationId), rulesSchema);
  return { rules, limit, suggested: knownRuleSuggestions(suggested ?? []) };
}

/** What a page writes: the text, and the schedule when there is one to send (null takes it off on PATCH). */
export interface RuleWrite {
  text: string;
  schedule?: ScheduleInput | null;
}

/** 201; 409 rule_limit or rule_exists. */
export async function createRule(api: ApiClient, locationId: string, write: RuleWrite): Promise<Rule> {
  const body = await api.json(rulesPath(locationId), savedRuleSchema, { method: 'POST', body: write });
  return body.rule;
}

/** 200; 403 forbidden for anyone but the author or an org admin; 409 rule_exists. A schedule left out keeps what it holds. */
export async function updateRule(api: ApiClient, locationId: string, ruleId: string, write: RuleWrite): Promise<Rule> {
  const body = await api.json(`${rulesPath(locationId)}/${encodeURIComponent(ruleId)}`, savedRuleSchema, { method: 'PATCH', body: write });
  return body.rule;
}

/** 204; 403 forbidden as on PATCH. */
export async function deleteRule(api: ApiClient, locationId: string, ruleId: string): Promise<void> {
  await api.request(`${rulesPath(locationId)}/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}

const ruleDecidedSchema = z.object({
  suggestion: z.object({ id: z.string(), status: z.enum(['accepted', 'dismissed']) }),
  rule: ruleSchema.nullable(),
});
/** What a decision on a suggested rule did: the stored suggestion's id and status, and the rule Confirm or Edit wrote (null when dismissed, or deleted since). */
export type RuleDecided = z.infer<typeof ruleDecidedSchema>;

/**
 * POST .../agent/rule-suggestions/:suggestionId/accept or /dismiss (D46, any member): Confirm and Dismiss send `{}`, Edit
 * sends `{ rule: { text, schedule } }` (schedule null for none). 404 when it is gone (decided elsewhere, or its end
 * passed); 409 already_decided (alreadyDecidedRule), rule_limit or rule_exists.
 */
export function decideRuleSuggestion(
  api: ApiClient, locationId: string, suggestionId: string, decision: 'accept' | 'dismiss', rule?: { text: string; schedule: ScheduleInput | null },
): Promise<RuleDecided> {
  const path: `/${string}` = `/api/org/locations/${encodeURIComponent(locationId)}/agent/rule-suggestions/${encodeURIComponent(suggestionId)}/${decision}`;
  return api.json(path, ruleDecidedSchema, { method: 'POST', body: rule === undefined ? {} : { rule } });
}

/** The rule a 409 already_decided names: the one a racing Confirm or Edit already saved; null for any other error. */
export function alreadyDecidedRule(error: unknown): Rule | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'already_decided') return null;
  const parsed = ruleSchema.safeParse(error.detail?.rule);
  return parsed.success ? parsed.data : null;
}
