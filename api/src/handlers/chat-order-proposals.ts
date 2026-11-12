// GET and POST .../chat/:conversationId/order-proposals/:proposalId. The item and the delivery come from the
// stored tool call. The POST may send the owner's quantity and reason, or save or dismiss a rule. It cannot
// retarget the line. A labeled sample is never a shown card.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { shownToolCall } from '../chat/shown-call.ts';
import { ORDER_CHANGE_RESULT, ORDER_RULE_RESULT, proposeOrderChangeTool, proposeOrderRuleTool } from '../chat/tools/orders.ts';
import { notFound, ownerOf } from './chat.ts';
import { loadLocation, memberOf } from './locations.ts';

const proposalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const reasonSchema = z.string().trim().min(1).max(280);

const changeBody = z.union([
  z.strictObject({ action: z.literal('save'), quantity: z.number().int().min(0).max(999), reason: reasonSchema }),
  z.strictObject({ action: z.literal('dismiss') }),
]);
const ruleBody = z.strictObject({ action: z.enum(['save', 'dismiss']) });

type Shown =
  | { kind: 'change'; locationId: string; conversationId: string; proposalId: string; itemId: string; delivery: string }
  | { kind: 'rule'; locationId: string; conversationId: string; proposalId: string; itemId: string };

async function loadShown(ctx: TownwiseContext, principal: Principal, req: Request): Promise<Shown> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const proposalId = parseInput(proposalIdSchema, req.params.proposalId);
  const conversation = await ctx.stores.chatConversations.find(caller.scope, ownerOf(caller, location.id), conversationId);
  if (conversation === null) throw notFound();
  const change = shownToolCall(conversation.messages, proposeOrderChangeTool.definition.name, proposalId);
  if (change?.content === ORDER_CHANGE_RESULT) {
    const input = proposeOrderChangeTool.parse(change.input, '');
    if (input === null) throw notFound();
    return { kind: 'change', locationId: location.id, conversationId, proposalId, itemId: input.itemId, delivery: input.delivery };
  }
  const rule = shownToolCall(conversation.messages, proposeOrderRuleTool.definition.name, proposalId);
  if (rule?.content === ORDER_RULE_RESULT) {
    const input = proposeOrderRuleTool.parse(rule.input, '');
    if (input === null) throw notFound();
    return { kind: 'rule', locationId: location.id, conversationId, proposalId, itemId: input.itemId };
  }
  throw notFound();
}

/** GET: what the card shows. The quantity on a change card is not filled in; the owner types it. */
export async function getOrderProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const shown = await loadShown(ctx, principal, req);
  const card = await ctx.stores.orders.findCard(caller.scope, shown);
  const status = card?.status ?? 'open';
  if (shown.kind === 'change') {
    res.status(200).json({ proposal: { kind: 'change', status, itemId: shown.itemId, delivery: shown.delivery } });
    return;
  }
  const decision = await ctx.stores.orders.latestDecision(caller.scope, shown.locationId, shown.itemId);
  if (decision === null) throw notFound();
  res.status(200).json({
    proposal: {
      kind: 'rule', status, itemId: shown.itemId, situation: decision.reason,
      delta: decision.quantity - decision.recommended, unit: decision.unit,
    },
  });
}

/** POST: save the owner's quantity, remember a rule, or set the card aside. */
export async function actOnOrderProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const shown = await loadShown(ctx, principal, req);
  if (shown.kind === 'change') {
    const body = parseInput(changeBody, req.body);
    if (body.action === 'dismiss') {
      await ctx.stores.orders.setCard(caller.scope, shown.locationId, shown, { kind: 'change', status: 'dismissed', now: ctx.now() });
      res.status(200).json({ proposal: { kind: 'change', status: 'dismissed', itemId: shown.itemId, delivery: shown.delivery } });
      return;
    }
    throw new AppError(409, 'order_unavailable', 'There is no order to change for this location.');
  }
  const body = parseInput(ruleBody, req.body);
  if (body.action === 'dismiss') {
    await ctx.stores.orders.setCard(caller.scope, shown.locationId, shown, { kind: 'rule', status: 'dismissed', now: ctx.now() });
    res.status(200).json({ proposal: { kind: 'rule', status: 'dismissed', itemId: shown.itemId } });
    return;
  }
  const decision = await ctx.stores.orders.latestDecision(caller.scope, shown.locationId, shown.itemId);
  if (decision === null) throw notFound();
  const existing = await ctx.stores.orders.findRule(caller.scope, shown.locationId, shown.itemId, decision.reason);
  if (existing?.off === true) throw new AppError(409, 'rule_off', 'That rule is turned off.');
  const delta = decision.quantity - decision.recommended;
  if (delta === 0) throw new AppError(400, 'invalid_request', 'That edit does not change the quantity.');
  const rule = existing ?? await ctx.stores.orders.addRule(caller.scope, shown.locationId, {
    itemId: decision.itemId, delta, unit: decision.unit, situation: decision.reason, now: ctx.now(),
  });
  await ctx.stores.orders.setCard(caller.scope, shown.locationId, shown, { kind: 'rule', status: 'saved', now: ctx.now() });
  res.status(200).json({ proposal: { kind: 'rule', status: 'saved', itemId: shown.itemId, ruleId: rule.id, situation: rule.situation, delta: rule.delta, unit: rule.unit } });
}
