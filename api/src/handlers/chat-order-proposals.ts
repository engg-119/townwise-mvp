// GET and POST .../chat/:conversationId/order-proposals/:proposalId. The item and the delivery come from the
// stored tool call. The POST may send the owner's quantity and reason, or save or dismiss a rule. It cannot
// retarget the line: a change is saved on the live board's line for that item and delivery, as the Orders page saves
// one. A change save claims the card before it stores the edit, under the id the card holds, so two saves at once
// store one edit and one `order.card_saved`. A saved change card shows the edit stored under its id; a save that
// sends another quantity or reason than that edit is 409 `card_saved` with the stored one, so a retry after a failure
// never reads as saving what it sent. A rule save sends the situation its card showed, and is refused when the
// item's latest edit has changed since. A labeled sample is never a shown card. Audit details carry ids and the
// card's kind only, and only a call that changed the card's state writes one.
//
// A setup card (spec D56, chat/tools/order-setup.ts) shows the ordering setup suggestions TownwiseAI wrote from a file
// attached to the conversation, checked again by the tool's own check. It is served only while the caller may still
// read that file (kept, on, its original there, and theirs or an org admin's), so it is 404 once the file is turned
// off or deleted. Under view-as its GET answers how many suppliers and items were suggested, never a name or a note.
// It can only be set aside: nothing saves from the chat, the owner saves on Ordering setup, and the card keeps no
// saved mark.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { shownToolCall } from '../chat/shown-call.ts';
import { proposeOrderSetupTool, shownOrderSetup, type ShownOrderSetup } from '../chat/tools/order-setup.ts';
import { ORDER_CHANGE_RESULT, ORDER_RULE_RESULT, proposeOrderChangeTool, proposeOrderRuleTool } from '../chat/tools/orders.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { DecisionRecord, OrderCardKind, OrderCardRecord, OrderCardStatus } from '../stores/orders.ts';
import { notFound, ownerOf } from './chat.ts';
import { loadLocation, memberOf } from './locations.ts';
import { decisionFor } from './orders.ts';
import { actorOf } from './team.ts';

const proposalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const reasonSchema = z.string().trim().min(1).max(280);

const changeBody = z.union([
  z.strictObject({ action: z.literal('save'), quantity: z.number().int().min(0).max(999), reason: reasonSchema }),
  z.strictObject({ action: z.literal('dismiss') }),
]);
/** A rule save sends back the situation the card's GET showed (the item's latest edit's reason then). */
const ruleBody = z.union([
  z.strictObject({ action: z.literal('save'), situation: reasonSchema }),
  z.strictObject({ action: z.literal('dismiss') }),
]);
/** A setup card is only set aside: nothing saves from the chat. */
const setupBody = z.strictObject({ action: z.literal('dismiss') });

type Shown =
  | { kind: 'change'; location: LocationRecord; locationId: string; conversationId: string; proposalId: string; itemId: string; delivery: string }
  | { kind: 'rule'; location: LocationRecord; locationId: string; conversationId: string; proposalId: string; itemId: string }
  | { kind: 'setup'; location: LocationRecord; locationId: string; conversationId: string; proposalId: string; setup: ShownOrderSetup };

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
  const call = shownToolCall(conversation.messages, proposeOrderSetupTool.definition.name, proposalId);
  const setup = call === null ? null : shownOrderSetup(call.input, call.content);
  if (setup !== null) {
    // The file again, as the caller is now: the check only. No content is read (for a picture, its first bytes are, to
    // tell its type).
    const file = await ctx.items.readForModel(caller.scope, location.id, setup.ref.slice(2), { userId: caller.userId, role: caller.role });
    if (file.status !== 'readable') throw notFound();
    return { kind: 'setup', location, locationId: location.id, conversationId, proposalId, setup };
  }
  throw notFound();
}

/** What a card's GET and answers show: a save in progress (`saving`) has stored nothing yet, so it reads as open. */
function statusOf(status: OrderCardStatus | undefined): 'open' | 'saved' | 'dismissed' {
  return status === undefined || status === 'saving' ? 'open' : status;
}

/** A saved change card's edit, the one stored under its id: the quantity, its unit and the reason. */
function editOf(decision: DecisionRecord | null): { quantity: number; unit: string; reason: string } | Record<string, never> {
  return decision === null ? {} : { quantity: decision.quantity, unit: decision.unit, reason: decision.reason };
}

async function storedEdit(ctx: TownwiseContext, caller: MemberPrincipal, shown: Shown, card: OrderCardRecord | null): Promise<DecisionRecord | null> {
  return card === null ? null : ctx.stores.orders.findDecision(caller.scope, shown.locationId, card.decisionId);
}

/**
 * GET: what the card shows. The quantity on an open change card is not filled in; the owner types it. A saved one
 * shows the edit stored under its id.
 */
export async function getOrderProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const shown = await loadShown(ctx, principal, req);
  const card = await ctx.stores.orders.findCard(caller.scope, shown);
  const status = statusOf(card?.status);
  if (shown.kind === 'setup') {
    // Never `saved`: a setup card's only stored state is set aside.
    const state = { kind: 'setup', status: status === 'dismissed' ? 'dismissed' : 'open', readWeb: shown.setup.readWeb } as const;
    // Under view-as, counts only: the names and notes come from a file, and staff see no file-derived text there
    // (handlers/data.ts hides a read's event titles the same way). [CONFIRM: under view-as the setup card shows counts only]
    const { read } = shown.setup;
    res.status(200).json({ proposal: caller.viewAs === null ? { ...state, read } : { ...state, counts: { suppliers: read.suppliers.length, items: read.items.length } } });
    return;
  }
  if (shown.kind === 'change') {
    const edit = status === 'saved' ? editOf(await storedEdit(ctx, caller, shown, card)) : {};
    res.status(200).json({ proposal: { kind: 'change', status, itemId: shown.itemId, delivery: shown.delivery, ...edit } });
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
async function recordCard(ctx: TownwiseContext, caller: MemberPrincipal, shown: Shown, status: 'saved' | 'dismissed'): Promise<void> {
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: caller.scope.orgId, action: status === 'saved' ? 'order.card_saved' : 'order.card_dismissed',
    target: { type: 'conversation', id: shown.conversationId },
    details: { locationId: shown.locationId, conversationId: shown.conversationId, kind: shown.kind },
  });
}

/** Sets the card aside unless it is saved; resolves the card as it is. Recorded only when it was not set aside already. */
async function dismiss(ctx: TownwiseContext, caller: MemberPrincipal, shown: Shown, kind: OrderCardKind): Promise<OrderCardRecord> {
  const { card, changed } = await ctx.stores.orders.setCard(caller.scope, shown.locationId, shown, { kind, status: 'dismissed', now: ctx.now() });
  if (changed) await recordCard(ctx, caller, shown, 'dismissed');
  return card;
}

/** POST: save the owner's quantity, remember a rule, or set the card aside. A saved card stays saved. A setup card is only set aside. */
export async function actOnOrderProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const shown = await loadShown(ctx, principal, req);
  if (shown.kind === 'setup') {
    parseInput(setupBody, req.body);
    await dismiss(ctx, caller, shown, 'setup');
    res.status(200).json({ proposal: { kind: 'setup', status: 'dismissed' } });
    return;
  }
  if (shown.kind === 'change') {
    const body = parseInput(changeBody, req.body);
    const view = { kind: 'change', itemId: shown.itemId, delivery: shown.delivery } as const;
    if (body.action === 'dismiss') {
      const card = await dismiss(ctx, caller, shown, 'change');
      const edit = card.status === 'saved' ? editOf(await storedEdit(ctx, caller, shown, card)) : {};
      res.status(200).json({ proposal: { ...view, status: card.status === 'saved' ? 'saved' : 'dismissed', ...edit } });
      return;
    }
    const { orders } = ctx.stores;
    /**
     * The card is saved with `decision`: 200 when it is the edit this call sent, else 409 `card_saved`, both with the
     * stored edit, so a second press or a retry with another quantity shows what was kept.
     */
    const answer = (decision: DecisionRecord | null): void => {
      const proposal = { ...view, status: 'saved', ...editOf(decision) } as const;
      if (decision === null || (decision.quantity === body.quantity && decision.reason === body.reason)) {
        res.status(200).json({ proposal });
        return;
      }
      res.status(409).json({ error: 'card_saved', message: 'This card was saved already, with another quantity or reason.', proposal });
    };
    // Saved already (a second press): the first save stands, and no second edit is stored.
    const card = await orders.findCard(caller.scope, shown);
    if (card?.status === 'saved') {
      answer(await storedEdit(ctx, caller, shown, card));
      return;
    }
    // Read the live line first, so a refusal (409, 404) leaves the card as it was.
    const input = await decisionFor(ctx, caller, shown.location, {
      itemId: shown.itemId, delivery: shown.delivery, quantity: body.quantity, reason: body.reason,
    });
    const decisionId = await orders.claimChange(caller.scope, shown.locationId, shown, ctx.now());
    if (decisionId === null) {
      answer(await storedEdit(ctx, caller, shown, await orders.findCard(caller.scope, shown)));
      return;
    }
    // A concurrent save of this card, or the first try of a retry, stores its edit under the same id, so only one is
    // kept, and it is the answer.
    const decision = await orders.addDecision(caller.scope, shown.locationId, { ...input, id: decisionId });
    const { changed } = await orders.setCard(caller.scope, shown.locationId, shown, { kind: 'change', status: 'saved', now: ctx.now() });
    if (changed) await recordCard(ctx, caller, shown, 'saved');
    answer(decision);
    return;
  }
  const body = parseInput(ruleBody, req.body);
  if (body.action === 'dismiss') {
    const card = await dismiss(ctx, caller, shown, 'rule');
    res.status(200).json({ proposal: { kind: 'rule', status: card.status === 'saved' ? 'saved' : 'dismissed', itemId: shown.itemId } });
    return;
  }
  const { orders } = ctx.stores;
  // Saved already (a second press): the first save stands, with no second event.
  if ((await orders.findCard(caller.scope, shown))?.status === 'saved') {
    res.status(200).json({ proposal: { kind: 'rule', status: 'saved', itemId: shown.itemId } });
    return;
  }
  const decision = await orders.latestDecision(caller.scope, shown.locationId, shown.itemId);
  if (decision === null) throw notFound();
  // The card showed the latest edit's reason when it was read; a newer edit since means it would save something else.
  if (decision.reason !== body.situation) {
    throw new AppError(409, 'rule_changed', 'The latest change for this item is not the one this card showed. Reload it to see the new one.');
  }
  const existing = await orders.findRule(caller.scope, shown.locationId, shown.itemId, decision.reason);
  if (existing?.off === true) throw new AppError(409, 'rule_off', 'That rule is turned off.');
  const delta = decision.quantity - decision.recommended;
  if (delta === 0) throw new AppError(400, 'invalid_request', 'That edit does not change the quantity.');
  // A rule in another unit than the edit's applies to no line; saving the card moves it to the edit's amount and unit.
  const { rule } = existing !== null && existing.unit === decision.unit
    ? { rule: existing }
    : await orders.addRule(caller.scope, shown.locationId, {
      itemId: decision.itemId, delta, unit: decision.unit, situation: decision.reason, now: ctx.now(),
    });
  const { changed } = await orders.setCard(caller.scope, shown.locationId, shown, { kind: 'rule', status: 'saved', now: ctx.now() });
  if (changed) await recordCard(ctx, caller, shown, 'saved');
  res.status(200).json({ proposal: { kind: 'rule', status: 'saved', itemId: shown.itemId, ruleId: rule.id, situation: rule.situation, delta: rule.delta, unit: rule.unit } });
}
