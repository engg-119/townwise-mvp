// POST /api/org/locations/:locationId/chat/:conversationId/feedback/:nodeId (docs/portal/tuning-chat.md section 2):
// the author rates one of TownwiseAI's replies, or clears the rating. Private display state like a rename: it stores
// an enum and a time, never text; the only trace is the aggregate log line below, and there is no audit event.
import { objectId } from '@ckeith26/mongo';
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { nodeIdSchema, nodesOf } from '../chat/tree.ts';
import { FEEDBACK_REASONS } from '../stores/chat-conversations.ts';
import { notFound, ownerOf } from './chat.ts';
import { loadLocation, memberOf } from './locations.ts';

/** A reason goes only with a down rating. */
const feedbackBody = z.strictObject({
  rating: z.enum(['up', 'down']).nullable(),
  reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
}).refine((body) => body.rating === 'down' || body.reason === undefined || body.reason === null);

export async function rateReply(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const body = parseInput(feedbackBody, req.body);
  const nodeId = parseInput(nodeIdSchema, req.params.nodeId);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const owner = ownerOf(caller, location.id);
  const conversation = await ctx.stores.chatConversations.find(caller.scope, owner, conversationId);
  if (conversation === null) throw notFound();
  // Any branch, shown or not; a message of the person's is not rated.
  if (!nodesOf(conversation.messages).some((node) => node.id === nodeId && node.role === 'assistant')) throw notFound();
  const rating = body.rating;
  const reason = rating === 'down' ? body.reason ?? null : null;
  const feedback = rating === null ? null : { rating, reason, at: ctx.now() };
  if (!(await ctx.stores.chatConversations.rate(caller.scope, owner, conversationId, nodeId, feedback))) throw notFound();
  ctx.logger.info({ orgId: caller.scope.orgId, rating, reason }, 'townwise.chat_feedback');
  res.status(200).json({ nodeId, rating, reason });
}
