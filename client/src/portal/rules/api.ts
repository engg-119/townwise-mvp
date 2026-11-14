import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { NOTE_EFFECTS, NOTE_KINDS } from '../locations/api';
import type { ScheduleInput } from '../locations/noteRules';

// The Business rules routes (spec 10.16, api/src/handlers/rules.ts), through the portal ApiClient. `z.object` strips
// unknown keys.

function rulesPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/rules`;
}

/** A rule's schedule (D31): a note's fields but its detail, with `endDate` null for no end. */
export const ruleScheduleSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  startDate: z.string(),
  endDate: z.string().nullable(),
  weekdays: z.array(z.number()).nullable(),
  effect: z.enum(NOTE_EFFECTS),
  expectedGuests: z.number().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
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

/** GET .../rules: oldest first, with the location's limit. */
export const rulesSchema = z.object({ rules: z.array(ruleSchema), limit: z.number() });
export type RulesList = z.infer<typeof rulesSchema>;

const savedRuleSchema = z.object({ rule: ruleSchema });

export function fetchRules(api: ApiClient, locationId: string): Promise<RulesList> {
  return api.json(rulesPath(locationId), rulesSchema);
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
