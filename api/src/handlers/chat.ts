// TownwiseAI (docs/portal/tuning-chat.md): a member talks with an assistant about one location's demand, and it can
// propose notes the member saves (handlers/chat-proposals.ts). Conversations are private to their author, per
// location. Message text, tool inputs and tool results never reach a log or an audit event: only ids, counts, stop
// reasons and codes do.
import { randomUUID } from 'node:crypto';

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import { runTurn, type TurnEvent } from '../chat/turn.ts';
import { newestLeafUnder, nodeIdSchema, nodesOf, pathTo, type TreeNodeView } from '../chat/tree.ts';
import { chatMessageViews, OPEN, type ChatMessageView, type ProposalState, type ShownProposal } from '../chat/view.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import type { ConversationOwner, ConversationRecord, ConversationSummary } from '../stores/chat-conversations.ts';
import { loadLocation, memberOf } from './locations.ts';
import { sameNoteContent } from './notes.ts';
import { actorOf } from './team.ts';

/** Section 2. */
export interface ChatBudget { month: string; usedUsd: number; limitUsd: number; exhausted: boolean }
export interface ConversationListItem { id: string; title: string; updatedAt: string; turnCount: number }
export interface ChatSummary { enabled: boolean; budget: ChatBudget; conversations: ConversationListItem[] }
export interface ConversationView {
  id: string; title: string; updatedAt: string; activeLeafId: string | null; tree: TreeNodeView[]; messages: ChatMessageView[];
}

const MAX_LISTED = 50;
/** Section 5 caps. */
const MAX_TURNS = 40;
const MAX_STORED_BYTES = 1_500_000;
/** A live-turn claim older than this may be taken over, the person's and the conversation's alike. */
const STALE_TURN_MS = 3 * 60 * 1000;
/** Keeps the Container Apps ingress from closing an idle stream. */
const PING_MS = 15_000;
const TITLE_CHARS = 60;

const turnBody = z.object({
  conversationId: objectId.optional(),
  content: z.string().trim().min(1).max(4000),
});

export function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

export function ownerOf(caller: MemberPrincipal, locationId: string): ConversationOwner {
  return { locationId, userId: caller.userId };
}

function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The organization's spend this calendar month (UTC), used dollars rounded to cents. */
async function budgetOf(ctx: TownwiseContext, scope: OrgScope): Promise<ChatBudget> {
  const month = monthOf(ctx.now());
  const used = await ctx.stores.chatUsage.costMicroUsd(scope, month);
  const limitUsd = ctx.config.chatMonthlyBudgetUsd;
  return { month, usedUsd: Math.round(used / 10_000) / 100, limitUsd, exhausted: used >= Math.round(limitUsd * 1_000_000) };
}

function listItem(conversation: ConversationSummary): ConversationListItem {
  return {
    id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString(),
    turnCount: conversation.turnCount,
  };
}

function isFull(conversation: ConversationRecord): boolean {
  const bytes = conversation.messages.reduce((sum, message) => sum + Buffer.byteLength(message.param, 'utf8'), 0);
  return conversation.turnCount >= MAX_TURNS || bytes >= MAX_STORED_BYTES;
}

/** The first 60 characters of the first message. */
function titleOf(content: string): string {
  return Array.from(content).slice(0, TITLE_CHARS).join('').trimEnd();
}

/** GET /api/org/locations/:locationId/chat: on or off, the month's budget, and the caller's own conversations. */
export async function getChat(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const [budget, conversations] = await Promise.all([
    budgetOf(ctx, caller.scope),
    ctx.stores.chatConversations.list(caller.scope, ownerOf(caller, location.id), MAX_LISTED),
  ]);
  const body: ChatSummary = { enabled: ctx.chat !== null, budget, conversations: conversations.map(listItem) };
  res.status(200).json(body);
}

/** GET /api/org/locations/:locationId/chat/:conversationId: the caller's own conversation, its visible messages. */
export async function getConversation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const { node } = parseInput(z.strictObject({ node: nodeIdSchema.optional() }), req.query);
  const conversation = await ctx.stores.chatConversations.find(caller.scope, ownerOf(caller, location.id), conversationId);
  if (conversation === null) throw notFound();
  const nodes = nodesOf(conversation.messages);
  // `?node=` shows another version without storing it; otherwise the stored active leaf.
  if (node !== undefined && !nodes.some((candidate) => candidate.id === node)) throw notFound();
  const path = pathTo(nodes, node === undefined ? conversation.activeLeafId : newestLeafUnder(nodes, node));
  const [rows, notes] = await Promise.all([
    ctx.stores.chatProposals.list(caller.scope, conversation.id),
    ctx.stores.notes.list(caller.scope, location.id),
  ]);
  const byId = new Map(rows.map((row) => [row.proposalId, row]));
  const stateOf = (proposal: ShownProposal): ProposalState => {
    const row = byId.get(proposal.id);
    // A save that has not finished reads as open: pressing Save again finishes the same note.
    if (row !== undefined) return row.status === 'saving' ? OPEN : { status: row.status, noteId: row.status === 'saved' ? row.noteId : null };
    // A proposal added with the notes route (the Add note button before proposals were recorded) reads as saved when a
    // note the author wrote at this location says exactly the same, so it is not offered twice. Only the author could
    // press Add note in their own conversation, so a colleague's note never counts.
    const same = notes.find((note) => note.createdBy === caller.userId && sameNoteContent(note, proposal));
    return same === undefined ? OPEN : { status: 'saved', noteId: same.id };
  };
  const body: ConversationView = {
    id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString(),
    activeLeafId: path.at(-1)?.id ?? null,
    tree: nodes.map(({ id, parentId, role }) => ({ id, parentId, role })),
    // U13A: input views re-read their dates against the town's local day, as the tools ran them.
    messages: chatMessageViews(path, localDay(ctx.now(), timeZoneOf(location.town).timeZone), stateOf),
  };
  res.status(200).json(body);
}

/** DELETE /api/org/locations/:locationId/chat/:conversationId: the caller's own conversation. */
export async function deleteConversation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  if (!(await ctx.stores.chatConversations.remove(scope, ownerOf(caller, location.id), conversationId))) throw notFound();
  // After the conversation: while it exists its proposals keep their state, so none is offered for a second note.
  await ctx.stores.chatProposals.removeForConversation(scope, conversationId);
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'chat.conversation_deleted',
    target: { type: 'conversation', id: conversationId },
    details: { locationId: location.id, conversationId },
  });
  res.status(204).end();
}

interface ClaimedTurn { conversationId: string; title: string; history: BetaMessageParam[] }
interface TurnClaim { turnId: string; now: Date; staleBefore: Date }

/** Claims an existing conversation for this turn, or creates a new one already claimed. */
async function claimTurn(
  ctx: TownwiseContext, scope: OrgScope, owner: ConversationOwner, body: z.infer<typeof turnBody>, claim: TurnClaim,
): Promise<ClaimedTurn> {
  const conversations = ctx.stores.chatConversations;
  const { turnId, now } = claim;
  if (body.conversationId === undefined) {
    const title = titleOf(body.content);
    return { conversationId: await conversations.create(scope, owner, { title, turnId, now }), title, history: [] };
  }
  const claimed = await conversations.claim(scope, owner, body.conversationId, claim);
  if (claimed === null) {
    if ((await conversations.find(scope, owner, body.conversationId)) === null) throw notFound();
    throw new AppError(409, 'chat_turn_in_progress', 'This conversation is still answering. Wait for it, or stop it first.');
  }
  return {
    conversationId: claimed.id,
    title: claimed.title,
    history: claimed.messages.map((message) => JSON.parse(message.param) as BetaMessageParam),
  };
}

/**
 * POST /api/org/locations/:locationId/chat/turns (sections 2 and 3). Every refusal is a JSON error before the stream
 * starts; after that the answer is text/event-stream and ends with `done` or `error`. A person has at most one live
 * turn in the organization. The turn is saved once, when it finishes; closing the connection, or running past the time
 * limit, aborts the provider call and saves nothing but the cost.
 */
export async function postTurn(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(turnBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const model = ctx.chat;
  if (model === null) throw new AppError(503, 'chat_unavailable', 'TownwiseAI isn’t turned on yet');
  const owner = ownerOf(caller, location.id);
  const { timeZone } = timeZoneOf(location.town);
  if (body.conversationId !== undefined) {
    const existing = await ctx.stores.chatConversations.find(scope, owner, body.conversationId);
    if (existing === null) throw notFound();
    if (isFull(existing)) throw new AppError(409, 'conversation_full', 'This conversation is full. Start a new one.');
  }
  if ((await budgetOf(ctx, scope)).exhausted) {
    throw new AppError(409, 'chat_budget_exhausted', 'Your organization’s TownwiseAI budget for this month is used up');
  }
  const now = ctx.now();
  const claim: TurnClaim = { turnId: randomUUID(), now, staleBefore: new Date(now.getTime() - STALE_TURN_MS) };
  const { turnId } = claim;
  if (!(await ctx.stores.chatLiveTurns.claim(scope, caller.userId, claim))) {
    throw new AppError(409, 'chat_turn_in_progress', 'You already have a reply in progress. Wait for it, or stop it first.');
  }
  // Every exit from here on releases the person's claim, by this turn's id.
  const releaseLiveTurn = async (): Promise<void> => {
    try {
      await ctx.stores.chatLiveTurns.release(scope, caller.userId, turnId);
    } catch (err) {
      // The claim goes stale after 3 minutes; until then this person's next turn is 409.
      ctx.logger.warn({
        orgId: scope.orgId, locationId: location.id, errType: err instanceof Error ? err.constructor.name : typeof err,
      }, 'townwise.chat_live_turn_not_released');
    }
  };
  let claimed: ClaimedTurn;
  try {
    claimed = await claimTurn(ctx, scope, owner, body, claim);
  } catch (err) {
    await releaseLiveTurn();
    throw err;
  }
  const { conversationId, title, history } = claimed;
  const ids = { orgId: scope.orgId, locationId: location.id, conversationId };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: string, data: unknown): void => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Either one aborts the provider call. A closed connection sends nothing more; the time limit ends with `timeout`.
  const closed = new AbortController();
  res.on('close', () => { closed.abort(); });
  if (req.socket.destroyed) closed.abort();
  const timeLimit = AbortSignal.timeout(ctx.chatTurnTimeLimitMs);
  const signal = AbortSignal.any([closed.signal, timeLimit]);
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, PING_MS);

  try {
    send('conversation', { id: conversationId, title });
    const result = await runTurn({
      model,
      // U13A: today is the town's local date, so an evening turn is not already tomorrow.
      tools: { ctx, scope, location, today: localDay(ctx.now(), timeZone), timeZone },
      history,
      userMessage: { role: 'user', content: body.content },
      signal,
      now: ctx.now,
      emit: (event: TurnEvent) => { send(event.type, event.data); },
      charge: (cost) => ctx.stores.chatUsage.add(scope, monthOf(ctx.now()), cost, ctx.now()),
      budgetSpent: async () => (await budgetOf(ctx, scope)).exhausted,
    });
    if (result.kind !== 'done') {
      // Nothing of the turn is saved: the claim goes, and a conversation that never finished a turn is deleted.
      await ctx.stores.chatConversations.release(scope, conversationId, turnId);
      if (result.kind === 'refused') {
        ctx.logger.info({ ...ids, calls: result.calls, stopReason: 'refusal', costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn');
        send('done', { stopReason: 'refusal', costUsd: result.costMicroUsd / 1_000_000 });
        return;
      }
      if (result.kind === 'aborted') {
        // Whichever aborted first decides: a closed connection sends nothing, the time limit ends with `timeout`.
        if (!(timeLimit.aborted && signal.reason === timeLimit.reason)) {
          ctx.logger.info({ ...ids, calls: result.calls, costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn_aborted');
          return;
        }
        ctx.logger.warn({ ...ids, calls: result.calls, code: 'timeout', costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn_failed');
        send('error', { code: 'timeout' });
        return;
      }
      ctx.logger.warn({
        ...ids, calls: result.calls, code: result.code, errType: result.errType, status: result.status,
        costMicroUsd: result.costMicroUsd,
      }, 'townwise.chat_turn_failed');
      send('error', { code: result.code });
      return;
    }
    const saved = await ctx.stores.chatConversations.finish(scope, conversationId, turnId, { messages: result.messages, now: ctx.now() });
    if (!saved) {
      // Another turn took over the claim (this one ran past 3 minutes), or the conversation was deleted.
      ctx.logger.warn({ ...ids, calls: result.calls, costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn_not_saved');
      send('error', { code: 'internal' });
      return;
    }
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'chat.turn_completed',
      target: { type: 'conversation', id: conversationId },
      details: {
        locationId: location.id, conversationId, model: result.model, calls: result.calls,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, stopReason: result.stopReason,
      },
    });
    ctx.logger.info({
      ...ids, calls: result.calls, stopReason: result.stopReason, costMicroUsd: result.costMicroUsd,
    }, 'townwise.chat_turn');
    send('done', { stopReason: result.stopReason, costUsd: result.costMicroUsd / 1_000_000 });
  } catch (err) {
    // A store failure while saving: nothing was saved, and the claim goes if it can.
    ctx.logger.error({ ...ids, code: 'internal', errType: err instanceof Error ? err.constructor.name : typeof err }, 'townwise.chat_turn_failed');
    await ctx.stores.chatConversations.release(scope, conversationId, turnId).catch(() => undefined);
    send('error', { code: 'internal' });
  } finally {
    clearInterval(ping);
    // Before the stream ends, so the client's next turn never finds this one still live.
    await releaseLiveTurn();
    if (!res.writableEnded) res.end();
  }
}
