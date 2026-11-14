// GET and POST /api/org/locations/:locationId/orders. The page and TownwiseAI read one board (orders/live.ts): the
// location's next order per supplier, or what its ordering setup lacks. `?sample=true` is the labeled preview, and an
// edit or a rule is never saved against it. Nothing is sent to a distributor. Audit details carry ids and dates only,
// never the owner's reason or a quantity.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { findLine, sampleBoard } from '../orders/board.ts';
import { addDays } from '../orders/dates.ts';
import { loadBoard, loadBoardNow, townClock } from '../orders/live.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { DecisionRecord } from '../stores/orders.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

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
  ruleId: objectId.transform((id) => id.toLowerCase()),
});

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** GET .../orders. `?sample=true` is the labeled preview. Every answer carries `today`, the town's date. */
export async function getOrders(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const { today, nowMinutes } = townClock(ctx, location);
  const board = req.query.sample === 'true'
    ? sampleBoard(today, nowMinutes)
    : await loadBoard(ctx, caller.scope, location, today, nowMinutes);
  res.status(200).json({ ...board, today });
}

export interface DecisionInput {
  readonly itemId: string;
  readonly delivery: string;
  readonly quantity: number;
  readonly reason: string;
}

/**
 * Saves the owner's quantity for one line of its supplier's next order, read from the live board now: 409
 * `order_unavailable` without a board, 404 for an item or a delivery not on it. The recommended quantity is the
 * board's, never the caller's. Shared with the order change card (chat-order-proposals.ts).
 */
export async function saveDecision(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, input: DecisionInput,
): Promise<DecisionRecord> {
  const board = await loadBoardNow(ctx, caller.scope, location);
  if (!board.available || board.sample) throw new AppError(409, 'order_unavailable', 'There is no order to change for this location.');
  const found = findLine(board, input.delivery, input.itemId);
  if (found === null) throw notFound();
  const { order, line } = found;
  return ctx.stores.orders.addDecision(caller.scope, location.id, {
    itemId: line.itemId,
    delivery: order.delivery,
    windowStart: order.cutoff,
    windowEnd: addDays(order.coversThrough, -1),
    recommended: line.recommended,
    quantity: input.quantity,
    unit: line.unit,
    reason: input.reason,
    now: ctx.now(),
  });
}

/** POST .../orders/decisions. */
export async function saveOrderDecision(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const body = parseInput(decisionBody, req.body);
  const saved = await saveDecision(ctx, caller, location, body);
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: caller.scope.orgId, action: 'order.decision_saved',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, itemId: saved.itemId, delivery: saved.delivery },
  });
  res.status(200).json({
    decision: { itemId: saved.itemId, delivery: saved.delivery, quantity: saved.quantity, reason: saved.reason, recommended: saved.recommended },
  });
}

/**
 * POST .../orders/rules. The amount is the latest saved edit's difference, and the situation is that edit's reason. A
 * rule already saved for the item and situation is the answer; one turned off is 409 `rule_off`.
 */
export async function saveOrderRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const body = parseInput(ruleBody, req.body);
  const decision = await ctx.stores.orders.latestDecision(caller.scope, location.id, body.itemId);
  if (decision?.reason !== body.situation) throw notFound();
  const existing = await ctx.stores.orders.findRule(caller.scope, location.id, body.itemId, body.situation);
  if (existing?.off === true) throw new AppError(409, 'rule_off', 'That rule is turned off.');
  const delta = decision.quantity - decision.recommended;
  if (delta === 0) throw new AppError(400, 'invalid_request', 'That edit does not change the quantity.');
  const rule = existing ?? await ctx.stores.orders.addRule(caller.scope, location.id, {
    itemId: decision.itemId, delta, unit: decision.unit, situation: decision.reason, now: ctx.now(),
  });
  if (existing === null) {
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: caller.scope.orgId, action: 'order.rule_saved',
      target: { type: 'location', id: location.id },
      details: { locationId: location.id, itemId: rule.itemId },
    });
  }
  res.status(200).json({ rule: { id: rule.id, itemId: rule.itemId, delta: rule.delta, situation: rule.situation, off: rule.off } });
}

/** POST .../orders/rules/off. The row stays, so the same reason is not proposed again. */
export async function turnOffOrderRule(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const body = parseInput(offBody, req.body);
  const turned = await ctx.stores.orders.turnOff(caller.scope, location.id, body.ruleId, ctx.now());
  if (!turned) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: caller.scope.orgId, action: 'order.rule_turned_off',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, ruleId: body.ruleId },
  });
  res.status(204).end();
}
