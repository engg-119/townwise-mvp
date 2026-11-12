// GET and POST /api/org/locations/:locationId/orders. The page and TownwiseAI read one board. A location has no
// live board until item sales, a count, and a supplier schedule exist, so the preview is the labeled sample.
// Saving an edit or a rule against the sample is refused. Nothing is sent to a distributor.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { liveBoard, sampleBoard, unavailable, withPreferences, type OrderAnswer, type StoredDecision, type StoredRule } from '../orders/board.ts';
import type { DecisionRecord, RuleRecord } from '../stores/orders.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { loadLocation, memberOf } from './locations.ts';

const REASON_MAX = 280;

const decisionBody = z.strictObject({
  itemId: z.string().trim().min(1).max(80),
  delivery: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.number().int().min(0).max(999),
  reason: z.string().trim().min(1).max(REASON_MAX),
});

const ruleBody = z.strictObject({
  itemId: z.string().trim().min(1).max(80),
  situation: z.string().trim().min(1).max(REASON_MAX),
});

const offBody = z.strictObject({
  ruleId: z.string().trim().min(1).max(32),
});

function todayOf(ctx: TownwiseContext, town: Parameters<typeof timeZoneOf>[0]): string {
  return localDay(ctx.now(), timeZoneOf(town).timeZone);
}

function asDecisions(rows: readonly DecisionRecord[]): StoredDecision[] {
  return rows.map((row) => ({ itemId: row.itemId, delivery: row.delivery, quantity: row.quantity, reason: row.reason }));
}

function asRules(rows: readonly RuleRecord[]): StoredRule[] {
  return rows.map((row) => ({ id: row.id, itemId: row.itemId, delta: row.delta, situation: row.situation, off: row.off }));
}

async function answer(ctx: TownwiseContext, scope: Parameters<typeof ctx.stores.orders.listDecisions>[0], locationId: string, today: string, sample: boolean): Promise<OrderAnswer> {
  if (!sample) {
    const live = liveBoard();
    if (live === null) return unavailable();
    const [decisions, rules] = await Promise.all([
      ctx.stores.orders.listDecisions(scope, locationId),
      ctx.stores.orders.listRules(scope, locationId),
    ]);
    return withPreferences(live, asDecisions(decisions), asRules(rules));
  }
  return sampleBoard(today);
}

/** GET .../orders. `?sample=true` is the labeled preview. */
export async function getOrders(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const sample = req.query.sample === 'true';
  const board = await answer(ctx, caller.scope, location.id, todayOf(ctx, location.town), sample);
  res.status(200).json(board);
}

/** POST .../orders/decisions. The recommended quantity is the board's, never the body's. */
export async function saveOrderDecision(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const body = parseInput(decisionBody, req.body);
  const today = todayOf(ctx, location.town);
  const board = await answer(ctx, caller.scope, location.id, today, false);
  if (!board.available || board.sample) throw new AppError(409, 'order_unavailable', 'There is no order to change for this location.');
  const line = board.lines.find((item) => item.itemId === body.itemId && board.delivery === body.delivery);
  if (line === undefined) throw new AppError(404, 'not_found', 'Not found');
  const saved = await ctx.stores.orders.addDecision(caller.scope, location.id, {
    itemId: line.itemId,
    delivery: board.delivery,
    windowStart: board.delivery,
    windowEnd: board.coversThrough,
    recommended: line.recommended,
    quantity: body.quantity,
    unit: line.unit,
    reason: body.reason,
    now: ctx.now(),
  });
  res.status(200).json({
    decision: { itemId: saved.itemId, delivery: saved.delivery, quantity: saved.quantity, reason: saved.reason, recommended: saved.recommended },
  });
}

/** POST .../orders/rules. The amount is the saved edit's difference, and the situation is that edit's reason. */
export async function saveOrderRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const body = parseInput(ruleBody, req.body);
  const decision = await ctx.stores.orders.latestDecision(caller.scope, location.id, body.itemId);
  if (decision === null || decision.reason !== body.situation) throw new AppError(404, 'not_found', 'Not found');
  const existing = await ctx.stores.orders.findRule(caller.scope, location.id, body.itemId, body.situation);
  if (existing?.off === true) throw new AppError(409, 'rule_off', 'That rule is turned off.');
  const delta = decision.quantity - decision.recommended;
  if (delta === 0) throw new AppError(400, 'invalid_request', 'That edit does not change the quantity.');
  const rule = existing ?? await ctx.stores.orders.addRule(caller.scope, location.id, {
    itemId: decision.itemId, delta, unit: decision.unit, situation: decision.reason, now: ctx.now(),
  });
  res.status(200).json({ rule: { id: rule.id, itemId: rule.itemId, delta: rule.delta, situation: rule.situation, off: rule.off } });
}

/** POST .../orders/rules/off. The row stays, so the same reason is not proposed again. */
export async function turnOffOrderRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const body = parseInput(offBody, req.body);
  const turned = await ctx.stores.orders.turnOff(caller.scope, location.id, body.ruleId, ctx.now());
  if (!turned) throw new AppError(404, 'not_found', 'Not found');
  res.status(204).end();
}
