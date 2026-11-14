// GET and POST .../chat/:conversationId/order-proposals/:proposalId. The item and the delivery come from the
// stored tool call. The POST may send the owner's quantity and reason, or save or dismiss a rule. It cannot
// retarget the line: a change is saved on the live board's line for that item and delivery, as the Orders page saves
// one. A labeled sample is never a shown card. Audit details carry ids and the card's kind only.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { shownToolCall } from '../chat/shown-call.ts';
import { ORDER_CHANGE_RESULT, ORDER_RULE_RESULT, proposeOrderChangeTool, proposeOrderRuleTool } from '../chat/tools/orders.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { OrderCardKind, OrderCardStatus } from '../stores/orders.ts';
import { notFound, ownerOf } from './chat.ts';
import { loadLocation, memberOf } from './locations.ts';
import { saveDecision } from './orders.ts';
import { actorOf } from './team.ts';

const proposalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const reasonSchema = z.string().trim().min(1).max(280);

const changeBody = z.union([
  z.strictObject({ action: z.literal('save'), quantity: z.number().int().min(0).max(999), reason: reasonSchema }),
  z.strictObject({ action: z.literal('dismiss') }),
]);
const ruleBody = z.strictObject({ action: z.enum(['save', 'dismiss']) });

type Shown =
  | { kind: 'change'; location: LocationRecord; locationId: string; conversationId: string; proposalId: string; itemId: string; delivery: string }
  | { kind: 'rule'; location: LocationRecord; locationId: string; conversationId: string; proposalId: string; itemId: string };

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
    return { kind: 'change', location, locationId: location.id, conversationId, proposalId, itemId: input.itemId, delivery: input.delivery };
  }
  const rule = shownToolCall(conversation.messages, proposeOrderRuleTool.definition.name, proposalId);
  if (rule?.content === ORDER_RULE_RESULT) {
    const input = proposeOrderRuleTool.parse(rule.input, '');
    if (input === null) throw notFound();
    return { kind: 'rule', location, locationId: location.id, conversationId, proposalId, itemId: input.itemId };
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

/** order.card_saved or order.card_dismissed: the location, the conversation and the card's kind, nothing more. */
async function recordCard(ctx: TownwiseContext, caller: MemberPrincipal, shown: Shown, status: OrderCardStatus): Promise<void> {
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: caller.scope.orgId, action: status === 'saved' ? 'order.card_saved' : 'order.card_dismissed',
    target: { type: 'conversation', id: shown.conversationId },
    details: { locationId: shown.locationId, conversationId: shown.conversationId, kind: shown.kind },
  });
}

/** Sets the card aside unless it is saved; resolves the status it holds. */
async function dismiss(ctx: TownwiseContext, caller: MemberPrincipal, shown: Shown, kind: OrderCardKind): Promise<OrderCardStatus> {
  const card = await ctx.stores.orders.setCard(caller.scope, shown.locationId, shown, { kind, status: 'dismissed', now: ctx.now() });
  if (card.status === 'dismissed') await recordCard(ctx, caller, shown, 'dismissed');
  return card.status;
}

/** POST: save the owner's quantity, remember a rule, or set the card aside. A saved card stays saved. */
export async function actOnOrderProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const shown = await loadShown(ctx, principal, req);
  if (shown.kind === 'change') {
    const body = parseInput(changeBody, req.body);
    const view = { kind: 'change', itemId: shown.itemId, delivery: shown.delivery } as const;
    if (body.action === 'dismiss') {
      res.status(200).json({ proposal: { ...view, status: await dismiss(ctx, caller, shown, 'change') } });
      return;
    }
    // Saved already (a second press): the first save stands, and no second edit is stored.
    if ((await ctx.stores.orders.findCard(caller.scope, shown))?.status === 'saved') {
      res.status(200).json({ proposal: { ...view, status: 'saved' } });
      return;
    }
    const decision = await saveDecision(ctx, caller, shown.location, {
      itemId: shown.itemId, delivery: shown.delivery, quantity: body.quantity, reason: body.reason,
    });
    await ctx.stores.orders.setCard(caller.scope, shown.locationId, shown, { kind: 'change', status: 'saved', now: ctx.now() });
    await recordCard(ctx, caller, shown, 'saved');
    res.status(200).json({ proposal: { ...view, status: 'saved', quantity: decision.quantity, reason: decision.reason } });
    return;
  }
  const body = parseInput(ruleBody, req.body);
  if (body.action === 'dismiss') {
    res.status(200).json({ proposal: { kind: 'rule', status: await dismiss(ctx, caller, shown, 'rule'), itemId: shown.itemId } });
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
  await recordCard(ctx, caller, shown, 'saved');
  res.status(200).json({ proposal: { kind: 'rule', status: 'saved', itemId: shown.itemId, ruleId: rule.id, situation: rule.situation, delta: rule.delta, unit: rule.unit } });
}
