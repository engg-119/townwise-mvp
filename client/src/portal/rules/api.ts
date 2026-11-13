import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The Business rules routes (spec 10.16, api/src/handlers/rules.ts), through the portal ApiClient. `z.object` strips
// unknown keys.

function rulesPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/rules`;
}

/** Spec 10.16 RuleView. `canEdit`: the author, or an org admin. `createdByEmail` may be “Townwise staff” or “Deleted person”. */
export const ruleSchema = z.object({
  id: z.string(),
  text: z.string(),
  addedVia: z.enum(['page', 'townwise_ai']),
  createdByEmail: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
});
export type Rule = z.infer<typeof ruleSchema>;

/** GET .../rules: oldest first, with the location's limit. */
export const rulesSchema = z.object({ rules: z.array(ruleSchema), limit: z.number() });
export type RulesList = z.infer<typeof rulesSchema>;

const savedRuleSchema = z.object({ rule: ruleSchema });

export function fetchRules(api: ApiClient, locationId: string): Promise<RulesList> {
  return api.json(rulesPath(locationId), rulesSchema);
}

/** 201; 409 rule_limit or rule_exists. */
export async function createRule(api: ApiClient, locationId: string, text: string): Promise<Rule> {
  const body = await api.json(rulesPath(locationId), savedRuleSchema, { method: 'POST', body: { text } });
  return body.rule;
}

/** 200; 403 forbidden for anyone but the author or an org admin; 409 rule_exists. */
export async function updateRule(api: ApiClient, locationId: string, ruleId: string, text: string): Promise<Rule> {
  const body = await api.json(`${rulesPath(locationId)}/${encodeURIComponent(ruleId)}`, savedRuleSchema, { method: 'PATCH', body: { text } });
  return body.rule;
}

/** 204; 403 forbidden as on PATCH. */
export async function deleteRule(api: ApiClient, locationId: string, ruleId: string): Promise<void> {
  await api.request(`${rulesPath(locationId)}/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}
