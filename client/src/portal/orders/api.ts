import { z } from 'zod';

import type { ApiClient } from '../../api/client';

const editSchema = z.object({ quantity: z.number(), reason: z.string() }).nullable();
const ruleSchema = z.object({ id: z.string(), delta: z.number(), situation: z.string() }).nullable();

export const orderLineSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  supplier: z.string(),
  unit: z.string(),
  neverRunOut: z.boolean(),
  recommended: z.number(),
  alternative: z.number().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  why: z.string(),
  sample: z.boolean(),
  edit: editSchema,
  rule: ruleSchema,
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderBoardSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    sample: z.boolean(),
    cutoff: z.string(),
    delivery: z.string(),
    coversThrough: z.string(),
    deadline: z.string(),
    missing: z.array(z.string()),
    lines: z.array(orderLineSchema),
  }),
]);
export type OrderBoard = z.infer<typeof orderBoardSchema>;

function ordersPath(locationId: string, sample: boolean): `/${string}` {
  const id = encodeURIComponent(locationId);
  return sample ? `/api/org/locations/${id}/orders?sample=true` : `/api/org/locations/${id}/orders`;
}

/** The location's order, or the labeled sample when `sample` is set. */
export function fetchOrderBoard(api: ApiClient, locationId: string, sample = false): Promise<OrderBoard> {
  return api.json(ordersPath(locationId, sample), orderBoardSchema);
}

const decisionSchema = z.object({
  decision: z.object({ itemId: z.string(), delivery: z.string(), quantity: z.number(), reason: z.string(), recommended: z.number() }),
});
const ruleSchemaSaved = z.object({
  rule: z.object({ id: z.string(), itemId: z.string(), delta: z.number(), situation: z.string(), off: z.boolean() }),
});

function decisionsPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/orders/decisions`;
}

function rulesPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/orders/rules`;
}

function ruleOffPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/orders/rules/off`;
}

/** Saves the owner's quantity for one line. The server keeps the recommended quantity. */
export function saveOrderDecision(
  api: ApiClient, locationId: string, body: { itemId: string; delivery: string; quantity: number; reason: string },
): Promise<unknown> {
  return api.json(decisionsPath(locationId), decisionSchema, { method: 'POST', body });
}

/** Remembers a rule from the latest saved reason. The server computes the difference. */
export function saveOrderRule(api: ApiClient, locationId: string, body: { itemId: string; situation: string }): Promise<unknown> {
  return api.json(rulesPath(locationId), ruleSchemaSaved, { method: 'POST', body });
}

/** Turns a rule off. The row stays, so the same reason is not proposed again. */
export async function turnOffOrderRule(api: ApiClient, locationId: string, ruleId: string): Promise<void> {
  await api.request(ruleOffPath(locationId), { method: 'POST', body: { ruleId } });
}
