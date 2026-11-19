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

import { targetStates, undoable } from '../agent/changes.ts';
import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import {
  ANSWER_TIME_MS, ATTACHMENT_BYTES_IN_FLIGHT, ATTACHMENT_REF, attachedOnPath, attachedTo, bytesToRead, checkAttachments, createByteGate, expandedMessage,
  MAX_ATTACHMENTS, readAttachments, refusalOf, turnAttachments, type Attached, type AttachmentRefusal, type TurnAttachments,
} from '../chat/attachments.ts';
import { runTurn, type TurnEvent, type TurnInput } from '../chat/turn.ts';
import { type RunningTurn, type StreamEvent, type TurnAbortReason, type TurnEnding } from '../chat/turn-runner.ts';
import { newestLeafUnder, newNodeId, nodeIdSchema, nodesOf, pathTo, type ChatNode, type TreeNodeView } from '../chat/tree.ts';
import { historyForModel, userMessageOf } from '../chat/user-message.ts';
import {
  chatMessageViews, OPEN, personMessageView, type AttachmentFile, type ChatMessageView, type FeedbackView, type ProposalState,
  type ShownProposal,
} from '../chat/view.ts';
import { loadDataItem, parseRef } from '../data/library.ts';
import { scheduleSummary } from '../forecasts/reasons.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import type { ConversationOwner, ConversationRecord, ConversationSummary } from '../stores/chat-conversations.ts';
import type { ChatTurnRecord, RunningTurnRef, TurnRecordEvent } from '../stores/chat-turns.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { loadLocation, memberOf } from './locations.ts';
import { sameNoteContent } from './notes.ts';
import { filesUnavailable } from './sales.ts';
import { actorOf } from './team.ts';

/** Section 2. */
export interface ChatBudget { month: string; usedUsd: number; limitUsd: number; exhausted: boolean }
/**
 * `running` (spec P25 build note, 2026-11-18): the conversation's newest turn is running with a live lease and the
 * conversation has not saved it, so History shows it replying.
 */
export interface ConversationListItem { id: string; title: string; updatedAt: string; turnCount: number; running: boolean }
/** resumable-chat-turns: `liveTurn` is the caller's running turn at this location, which the page opens on load. */
export interface ChatSummary { enabled: boolean; budget: ChatBudget; conversations: ConversationListItem[]; liveTurn: RunningTurnRef | null }
/**
 * resumable-chat-turns: the conversation's turn while it runs, or once it was interrupted until its record goes. `state`
 * is `interrupted` also for a running record whose lease has passed. `message` is the person's message (null for a
 * regenerate), shown under `parentId`.
 */
export interface LiveTurnView {
  turnId: string; state: 'running' | 'interrupted'; startedAt: string; userNodeId: string | null; replyNodeId: string;
  parentId: string | null; message: ChatMessageView | null;
}
export interface ConversationView {
  id: string; title: string; updatedAt: string; activeLeafId: string | null; tree: TreeNodeView[]; messages: ChatMessageView[];
  liveTurn: LiveTurnView | null;
}

const MAX_LISTED = 50;
/** Section 5 caps. */
const MAX_TURNS = 40;
const MAX_STORED_BYTES = 1_500_000;
/** A live-turn claim older than this may be taken over, the person's and the conversation's alike. */
const STALE_TURN_MS = 3 * 60 * 1000;
/** Keeps the Container Apps ingress from closing an idle stream. */
export const PING_MS = 15_000;
/** A turn's stream ends after one of these (resumable-chat-turns: `stopped` for a stopped turn). */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['done', 'error', 'stopped']);

/** One numbered event as a turn's streams send it: its number is the SSE id, so a reader resumes after the last one. */
export function eventFrame(event: TurnRecordEvent): string {
  return `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
const TITLE_CHARS = 60;
/** D36: the bytes of attached files this replica holds for its turns, from a send's checks to the end of its turn. */
export const attachmentBytes = createByteGate(ATTACHMENT_BYTES_IN_FLIGHT);

/**
 * A send, or a regenerate. A send's `parentId` makes it an edit: the node the new message hangs under, null for a new
 * first message; omitted, the stored active leaf (an older client's append). Only in an existing conversation. Its
 * `attachments` (D36) are 1 to 5 distinct files of Your data at this location, by `f_` ref; a message with attachments
 * still needs text. [CONFIRM: a message with attachments still needs text]
 */
const sendBody = z.strictObject({
  conversationId: objectId.optional(),
  content: z.string().trim().min(1).max(4000),
  parentId: nodeIdSchema.nullable().optional(),
  attachments: z.array(z.string().regex(ATTACHMENT_REF)).min(1).max(MAX_ATTACHMENTS)
    .refine((refs) => new Set(refs).size === refs.length).optional(),
}).refine((body) => body.parentId === undefined || body.conversationId !== undefined);
/** A regenerate: a new reply to the person's message `replyTo`, with no new message. */
const regenerateBody = z.strictObject({ conversationId: objectId, replyTo: nodeIdSchema });
const turnBody = z.union([sendBody, regenerateBody]);
type TurnBody = z.infer<typeof turnBody>;

const activeBody = z.strictObject({ nodeId: nodeIdSchema });
const renameBody = z.strictObject({
  title: z.string().trim()
    .refine((title) => Array.from(title).length >= 1 && Array.from(title).length <= TITLE_CHARS)
    .refine((title) => !/\p{Cc}/u.test(title)),
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

function listItem(conversation: ConversationSummary, runningId: string | null): ConversationListItem {
  return {
    id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString(),
    turnCount: conversation.turnCount, running: conversation.id === runningId,
  };
}

/** A live turn's record is running and its lease has not passed; readers treat a lapsed one as interrupted. */
function isRunning(ctx: TownwiseContext, live: ChatTurnRecord): boolean {
  return live.state === 'running' && live.leaseUntil.getTime() > ctx.now().getTime();
}

function isFull(conversation: ConversationRecord): boolean {
  const bytes = conversation.messages.reduce((sum, message) => sum + Buffer.byteLength(message.param, 'utf8'), 0);
  return conversation.turnCount >= MAX_TURNS || bytes >= MAX_STORED_BYTES;
}

/**
 * The location as TownwiseAI's tools read it: with one location its name is the organization's (spec D29), as member
 * pages show it, so get_location_overview never gives the model the stored name to repeat. Nothing is written.
 */
async function locationForTools(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord): Promise<LocationRecord> {
  const [org, count] = await Promise.all([ctx.stores.orgs.findById(scope.orgId), ctx.stores.locations.count(scope)]);
  return count > 1 || org === null ? location : { ...location, name: org.name };
}

/** The first 60 characters of the first message. */
function titleOf(content: string): string {
  return Array.from(content).slice(0, TITLE_CHARS).join('').trimEnd();
}

/** GET /api/org/locations/:locationId/chat: on or off, the month's budget, and the caller's own conversations. */
export async function getChat(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const owner = ownerOf(caller, location.id);
  const [budget, conversations, running] = await Promise.all([
    budgetOf(ctx, caller.scope),
    ctx.stores.chatConversations.list(caller.scope, owner, MAX_LISTED),
    ctx.stores.chatTurns.runningFor(caller.scope, { locationId: location.id, userId: caller.userId }),
  ]);
  // A turn its conversation already saved is not live, whatever its record says (its end was never written).
  const conversation = running === null ? null : await ctx.stores.chatConversations.find(caller.scope, owner, running.conversationId);
  const liveTurn = running === null || (conversation !== null && savedLeafOf(nodesOf(conversation.messages), running) !== null)
    ? null : { conversationId: running.conversationId, turnId: running.turnId };
  // The list marks that conversation running by the conversation view's rules (liveTurnOf, its `running` state). A
  // person has one live turn, so only the conversation of their newest running record can be.
  const live = conversation === null ? null : await liveTurnOf(ctx, caller.scope, conversation.id, nodesOf(conversation.messages));
  const runningId = conversation !== null && live !== null && isRunning(ctx, live) ? conversation.id : null;
  const body: ChatSummary = {
    enabled: ctx.chat !== null, budget, conversations: conversations.map((item) => listItem(item, runningId)), liveTurn,
  };
  res.status(200).json(body);
}

/**
 * D36: what each file the shown messages carry is on Your data now: its name (none under view-as) and whether it is on,
 * turned off, or gone (deleted, its original deleted, or stored files off, when Your data lists no stored file).
 */
async function attachedFiles(
  ctx: TownwiseContext, caller: MemberPrincipal, locationId: string, refs: readonly string[],
): Promise<Map<string, AttachmentFile>> {
  const items = await Promise.all(refs.map((ref) => loadDataItem(ctx, caller.scope, locationId, parseRef(ref), caller.userId)));
  return new Map(refs.map((ref, index): [string, AttachmentFile] => {
    const file = items[index]?.file ?? null;
    if (file === null) return [ref, { name: null, state: 'gone' }];
    const name = caller.viewAs === null ? file.name : null;
    if (file.rawDeletedAt !== null) return [ref, { name, state: 'gone' }];
    return [ref, { name, state: file.disabledAt === null ? 'on' : 'off' }];
  }));
}

/**
 * resumable-chat-turns: the leaf a turn left when the conversation holds its nodes (it was saved): its reply's node, else
 * its person's message's. Null when the conversation holds neither, so the turn saved nothing.
 */
export function savedLeafOf(nodes: readonly ChatNode[], turn: { userNodeId: string | null; replyNodeId: string }): string | null {
  if (nodes.some((node) => node.id === turn.replyNodeId)) return turn.replyNodeId;
  return turn.userNodeId !== null && nodes.some((node) => node.id === turn.userNodeId) ? turn.userNodeId : null;
}

/**
 * resumable-chat-turns: the conversation's newest turn while it is running or interrupted (until the sweep deletes its
 * record, 15 minutes after it ended), else null. A turn that ended any other way is in the saved messages, or saved
 * nothing; so is one the conversation already saved, though its record says running or interrupted (its end was never
 * written: shutdown gave up on it, or its lease lapsed after the save).
 */
async function liveTurnOf(ctx: TownwiseContext, scope: OrgScope, conversationId: string, nodes: readonly ChatNode[]): Promise<ChatTurnRecord | null> {
  const record = await ctx.stores.chatTurns.latestFor(scope, conversationId);
  if (record === null || (record.state !== 'running' && record.state !== 'interrupted')) return null;
  return savedLeafOf(nodes, record) === null ? record : null;
}

/** While a turn is live: the path to the node its first new node hangs under, so an edit's or a regenerate's branch shows. */
function livePath(nodes: readonly ChatNode[], live: ChatTurnRecord): ChatNode[] {
  return live.parentId === null ? [] : pathTo(nodes, live.parentId);
}

/** The conversation showing `path`, its visible messages, and its live turn. */
async function conversationView(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, conversation: ConversationRecord, nodes: readonly ChatNode[],
  path: readonly ChatNode[], live: ChatTurnRecord | null,
): Promise<ConversationView> {
  const liveFiles = live?.message?.attachments ?? [];
  const [rows, notes, files, changes] = await Promise.all([
    ctx.stores.chatProposals.list(caller.scope, conversation.id),
    ctx.stores.notes.list(caller.scope, location.id),
    attachedFiles(ctx, caller, location.id, [...new Set([...attachedOnPath(path), ...liveFiles.map((file) => file.ref)])]),
    // D59 slice 4: the notes TownwiseAI saved itself in this conversation, for their cards' Undo.
    ctx.stores.agentChanges.listBySource(caller.scope, location.id, { kind: 'chat', id: conversation.id }),
  ]);
  const fileOf = (ref: string): AttachmentFile => files.get(ref) ?? { name: null, state: 'gone' };
  const byId = new Map(rows.map((row) => [row.proposalId, row]));
  const states = await targetStates(ctx, caller.scope, location.id, changes);
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const stateOf = (proposal: ShownProposal): ProposalState => {
    const row = byId.get(proposal.id);
    // A save that has not finished reads as open: pressing Save again finishes the same note.
    if (row !== undefined) {
      if (row.status === 'saving') return OPEN;
      const state = { status: row.status, noteId: row.status === 'saved' ? row.noteId : null };
      const change = row.changeId === null ? undefined : changeById.get(row.changeId);
      return change === undefined ? state : {
        ...state, auto: { changeId: change.id, status: change.status, undoable: undoable(caller, change, states) },
      };
    }
    // A proposal added with the notes route (the Add note button before proposals were recorded) reads as saved when a
    // note the author wrote at this location says exactly the same, so it is not offered twice. Only the author could
    // press Add note in their own conversation, so a colleague's note never counts.
    const same = notes.find((note) => note.createdBy === caller.userId && sameNoteContent(note, proposal));
    return same === undefined ? OPEN : { status: 'saved', noteId: same.id };
  };
  const feedbackOf = (nodeId: string): FeedbackView | null => {
    const stored = conversation.feedback.get(nodeId);
    return stored === undefined ? null : { rating: stored.rating, reason: stored.reason };
  };
  return {
    id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString(),
    activeLeafId: path.at(-1)?.id ?? null,
    tree: nodes.map(({ id, parentId, role }) => ({ id, parentId, role })),
    // U13A: input views re-read their dates against the town's local day, as the tools ran them.
    messages: chatMessageViews(path, localDay(ctx.now(), timeZoneOf(location.town).timeZone), stateOf, feedbackOf, fileOf),
    liveTurn: live === null ? null : {
      turnId: live.turnId,
      // Readers treat a running record whose lease has passed as interrupted; the sweep settles it.
      state: isRunning(ctx, live) ? 'running' : 'interrupted',
      startedAt: live.startedAt.toISOString(), userNodeId: live.userNodeId, replyNodeId: live.replyNodeId, parentId: live.parentId,
      message: live.message === null || live.userNodeId === null ? null : personMessageView(
        live.userNodeId, live.startedAt, live.message.text, live.message.attachments.map(({ ref, kind }) => ({ ref, kind, ...fileOf(ref) })),
      ),
    },
  };
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
  // `?node=` shows another version without storing it; otherwise the path to a live turn's parent, else the stored
  // active leaf.
  if (node !== undefined && !nodes.some((candidate) => candidate.id === node)) throw notFound();
  const live = await liveTurnOf(ctx, caller.scope, conversation.id, nodes);
  const path = node !== undefined
    ? pathTo(nodes, newestLeafUnder(nodes, node))
    : live === null ? pathTo(nodes, conversation.activeLeafId) : livePath(nodes, live);
  const body: ConversationView = await conversationView(ctx, caller, location, conversation, nodes, path, live);
  res.status(200).json(body);
}

/**
 * POST /api/org/locations/:locationId/chat/:conversationId/active: shows another version and stores it, the path to
 * the newest leaf under `nodeId`. Display state, like a rename: no audit event, no log, and `updatedAt` stays.
 */
export async function showVersion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { nodeId } = parseInput(activeBody, req.body);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const owner = ownerOf(caller, location.id);
  const conversation = await ctx.stores.chatConversations.find(caller.scope, owner, conversationId);
  if (conversation === null) throw notFound();
  const nodes = nodesOf(conversation.messages);
  if (!nodes.some((candidate) => candidate.id === nodeId)) throw notFound();
  const leafId = newestLeafUnder(nodes, nodeId);
  if (!(await ctx.stores.chatConversations.setActiveLeaf(caller.scope, owner, conversationId, leafId))) throw notFound();
  const live = await liveTurnOf(ctx, caller.scope, conversation.id, nodes);
  const body: ConversationView = await conversationView(ctx, caller, location, conversation, nodes, pathTo(nodes, leafId), live);
  res.status(200).json(body);
}

/** PATCH /api/org/locations/:locationId/chat/:conversationId: the author renames their conversation (display state). */
export async function renameConversation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { title } = parseInput(renameBody, req.body);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  if (!(await ctx.stores.chatConversations.rename(caller.scope, ownerOf(caller, location.id), conversationId, title))) throw notFound();
  res.status(200).json({ id: conversationId, title });
}

/** DELETE /api/org/locations/:locationId/chat/:conversationId: the caller's own conversation. */
export async function deleteConversation(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const owner = ownerOf(caller, location.id);
  if ((await ctx.stores.chatConversations.find(scope, owner, conversationId)) === null) throw notFound();
  // Order cards go before the conversation: they hold no person id, so once the conversation is gone nothing (person
  // deletion goes by the person's conversations) could find them again. A failure after this leaves a card open again.
  await ctx.stores.orders.removeForConversation(scope, conversationId);
  if (!(await ctx.stores.chatConversations.remove(scope, owner, conversationId))) throw notFound();
  // resumable-chat-turns: its turns' records, so a turn still running ends at its next write and saves nothing.
  await ctx.stores.chatTurns.removeForConversation(scope, conversationId);
  // After the conversation: while it exists its proposals keep their state, so none is offered for a second note.
  await ctx.stores.chatProposals.removeForConversation(scope, conversationId);
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'chat.conversation_deleted',
    target: { type: 'conversation', id: conversationId },
    details: { locationId: location.id, conversationId },
  });
  res.status(204).end();
}

interface ClaimedTurn { conversationId: string; title: string; history: BetaMessageParam[]; nodes: TurnInput['nodes'] }
interface TurnClaim { turnId: string; now: Date; staleBefore: Date }

/** True when the node a branch names is in the conversation: an edit's parent, or a regenerate's message of the person. */
function namesKnownNode(nodes: readonly ChatNode[], body: TurnBody): boolean {
  if ('replyTo' in body) return nodes.some((node) => node.id === body.replyTo && node.role === 'user');
  return body.parentId === undefined || body.parentId === null || nodes.some((node) => node.id === body.parentId);
}

/** Section 3: a branch's history is its path, root to `leafId`, every message exactly as stored. */
function historyTo(nodes: readonly ChatNode[], leafId: string | null): BetaMessageParam[] {
  if (leafId === null) return [];
  return pathTo(nodes, leafId).flatMap((node) => node.messages.map((message) => JSON.parse(message.param) as BetaMessageParam));
}

/** A send's two new nodes: the person's message under `parentId`, and the reply under it. */
function sendNodes(parentId: string | null): TurnInput['nodes'] {
  const user = { id: newNodeId(), parentId };
  return { user, reply: { id: newNodeId(), parentId: user.id } };
}

/** Claims the author's conversation for this turn: 404 when it is gone, 409 while another turn holds it. */
async function claimExisting(
  ctx: TownwiseContext, scope: OrgScope, owner: ConversationOwner, conversationId: string, claim: TurnClaim,
): Promise<ConversationRecord> {
  const conversations = ctx.stores.chatConversations;
  const claimed = await conversations.claim(scope, owner, conversationId, claim);
  if (claimed !== null) return claimed;
  if ((await conversations.find(scope, owner, conversationId)) === null) throw notFound();
  throw new AppError(409, 'chat_turn_in_progress', 'This conversation is still answering. Wait for it, or stop it first.');
}

/**
 * Claims an existing conversation for this turn, or creates a new one already claimed. The turn continues the path to
 * its parent: a regenerate's message (that message included), an edit's parent, or else the stored active leaf. The
 * node postTurn checked is still there after the claim: messages are only ever appended.
 */
async function claimTurn(
  ctx: TownwiseContext, scope: OrgScope, owner: ConversationOwner, body: TurnBody, claim: TurnClaim,
): Promise<ClaimedTurn> {
  if ('replyTo' in body) {
    const claimed = await claimExisting(ctx, scope, owner, body.conversationId, claim);
    return {
      conversationId: claimed.id, title: claimed.title, history: historyTo(nodesOf(claimed.messages), body.replyTo),
      nodes: { user: null, reply: { id: newNodeId(), parentId: body.replyTo } },
    };
  }
  if (body.conversationId === undefined) {
    const title = titleOf(body.content);
    const conversationId = await ctx.stores.chatConversations.create(scope, owner, { title, turnId: claim.turnId, now: claim.now });
    return { conversationId, title, history: [], nodes: sendNodes(null) };
  }
  const claimed = await claimExisting(ctx, scope, owner, body.conversationId, claim);
  const nodes = nodesOf(claimed.messages);
  const parentId = body.parentId === undefined ? pathTo(nodes, claimed.activeLeafId).at(-1)?.id ?? null : body.parentId;
  return { conversationId: claimed.id, title: claimed.title, history: historyTo(nodes, parentId), nodes: sendNodes(parentId) };
}

/** D36: a send's answer for a file it can't attach. */
function attachmentRefused(refusal: AttachmentRefusal): AppError {
  switch (refusal) {
    case 'files_off': return filesUnavailable();
    case 'not_found': return notFound();
    case 'not_reference': return new AppError(400, 'invalid_request', 'Only files kept on Your data can be attached');
    case 'not_ready': return new AppError(409, 'attachment_not_ready', 'That file is still uploading. Send it when it’s ready.');
    // The right to download the original (handlers/files.ts isUploaderOrAdmin). Not `forbidden`, which makes the client
    // re-read GET /api/me and route again (spec 4.3): nothing about the caller's access changed.
    case 'not_allowed': return new AppError(403, 'attachment_not_allowed', 'Only the person who added a file or an org admin can attach it');
  }
}

/** The files a regenerate's message (the person's node `nodeId`) carries, from its stored attachments block. */
function attachedToNode(nodes: readonly ChatNode[], nodeId: string): Attached[] {
  const stored = nodes.find((node) => node.id === nodeId)?.messages[0];
  return stored === undefined ? [] : attachedTo(JSON.parse(stored.param) as BetaMessageParam);
}

/**
 * POST /api/org/locations/:locationId/chat/turns (sections 2 and 3). Every refusal is a JSON error before the stream
 * starts; after that the answer is text/event-stream, each event numbered by its SSE id, and ends with `done`, `error`
 * or `stopped`. A person has at most one live turn in the organization. The turn runs on this replica's turn runner
 * (resumable-chat-turns), so closing the connection aborts nothing; running past the time limit, a stop request, a lost
 * lease or shutdown abort the provider call and save nothing but the cost. The turn is saved once, when it finishes.
 */
export async function postTurn(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(turnBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const model = ctx.chat;
  if (model === null) throw new AppError(503, 'chat_unavailable', 'TownwiseAI isn’t turned on yet');
  // A replica shutting down takes no new turn (resumable-chat-turns).
  if (ctx.turnRunner.closing) throw new AppError(503, 'chat_restarting', 'TownwiseAI is restarting. Try again in a moment.');
  const owner = ownerOf(caller, location.id);
  const { timeZone } = timeZoneOf(location.town);
  // D36: a send's files are its body's; a regenerate's are those its stored message carries.
  let files: readonly { ref: string; kind: Attached['kind'] | null }[] = 'replyTo' in body
    ? [] : (body.attachments ?? []).map((ref) => ({ ref, kind: null }));
  if (body.conversationId !== undefined) {
    const existing = await ctx.stores.chatConversations.find(scope, owner, body.conversationId);
    if (existing === null) throw notFound();
    const nodes = nodesOf(existing.messages);
    // Before any claim: an edit's parent, or a regenerate's message, must be in the conversation.
    if (!namesKnownNode(nodes, body)) throw notFound();
    // Every branch counts toward the caps.
    if (isFull(existing)) throw new AppError(409, 'conversation_full', 'This conversation is full. Start a new one.');
    if ('replyTo' in body) files = attachedToNode(nodes, body.replyTo);
  }
  if ((await budgetOf(ctx, scope)).exhausted) {
    throw new AppError(409, 'chat_budget_exhausted', 'Your organization’s TownwiseAI budget for this month is used up');
  }
  if (!('replyTo' in body) && files.length > 0 && !ctx.items.on) throw filesUnavailable();
  // Before any claim, so a store failure has nothing to release. A regenerate resends its stored message as it was,
  // its files checked again as they are now. Only each file's record and first bytes are read here.
  const [rules, toolLocation, checks] = await Promise.all([
    'replyTo' in body ? [] : ctx.stores.businessRules.list(scope, location.id),
    locationForTools(ctx, scope, location),
    files.length === 0 ? [] : checkAttachments(ctx.items, scope, location.id, { userId: caller.userId, role: caller.role }, files),
  ]);
  // A send refuses a file that isn't on Your data here, a sales file, one not kept yet, or one the caller may not
  // attach; one turned off, or whose original is gone, is listed as not read instead. A regenerate refuses none: its
  // message was sent.
  const refusal = 'replyTo' in body ? null : refusalOf(checks);
  if (refusal !== null) throw attachmentRefused(refusal);
  // The bytes the turn will read are held from here until it ends (a document's only until it is read); every exit
  // gives back what is still held, once.
  let heldBytes = bytesToRead(checks);
  if (!attachmentBytes.reserve(heldBytes)) {
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, held: attachmentBytes.held }, 'townwise.chat_attachments_busy');
    throw new AppError(503, 'attachments_busy', 'TownwiseAI is reading a lot of files right now. Try again in a moment.', { retryAfterSeconds: 2 });
  }
  const releaseBytes = (): void => {
    attachmentBytes.release(heldBytes);
    heldBytes = 0;
  };
  // D36: the bytes this turn holds, as its reads take and give them back. A release gives back at most what the turn
  // still holds, so one after releaseBytes (a document read finishing after the send failed) frees no other turn's.
  const turnBytes = {
    reserve: (bytes: number): boolean => {
      if (!attachmentBytes.reserve(bytes)) return false;
      heldBytes += bytes;
      return true;
    },
    release: (bytes: number): void => {
      const given = Math.min(bytes, heldBytes);
      attachmentBytes.release(given);
      heldBytes -= given;
    },
  };
  const now = ctx.now();
  const claim: TurnClaim = { turnId: randomUUID(), now, staleBefore: new Date(now.getTime() - STALE_TURN_MS) };
  const { turnId } = claim;
  let live: boolean;
  try {
    live = await ctx.stores.chatLiveTurns.claim(scope, caller.userId, claim);
  } catch (err) {
    releaseBytes();
    throw err;
  }
  if (!live) {
    releaseBytes();
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
    releaseBytes();
    await releaseLiveTurn();
    throw err;
  }
  const { conversationId, title, history, nodes } = claimed;
  // The turn's time limit runs from its claims, so reading its files counts toward it: a PDF, Word or Excel file (D36)
  // can wait for the parse thread, and the claims go stale at 3 minutes. Every file read of the turn, its message's
  // and read_data_item's, is done ANSWER_TIME_MS before the limit, so the turn has time left to answer.
  const deadline = Date.now() + ctx.chatTurnTimeLimitMs;
  const filesBy = deadline - ANSWER_TIME_MS;
  // Nothing of the turn is saved: the claims go, and a conversation that never finished a turn is deleted.
  const releaseClaims = async (): Promise<void> => {
    releaseBytes();
    await ctx.stores.chatConversations.release(scope, conversationId, turnId).catch(() => undefined);
    await releaseLiveTurn();
  };
  // D36: the files' bytes, read only now that the turn holds its claims. A failure gives everything back before the stream.
  let attached: TurnAttachments | null = null;
  try {
    if (checks.length > 0) attached = turnAttachments(await readAttachments(checks, filesBy, turnBytes));
  } catch (err) {
    await releaseClaims();
    throw err;
  }
  // D36: a turn's log lines count its message's files by kind, never a name or anything from a file.
  const ids = { orgId: scope.orgId, locationId: location.id, conversationId, ...(attached === null ? {} : { attachments: attached.counts }) };
  // D37: and its web searches, a count only, on a turn that made any: never a query, a URL or anything from a page.
  const searched = (count: number): { webSearches?: number } => (count > 0 ? { webSearches: count } : {});
  // `parentId` is where the turn's first new node hangs: the person's message, or a regenerate's reply.
  const parentId = nodes.user === null ? nodes.reply.parentId : nodes.user.parentId;
  // Spec 10.16: the location's business rules go before the person's text when they differ from the path's last list.
  // D36: the attachments block goes after the rules block, and the files' content only into this turn's requests. Made
  // before the turn starts, so its record shows the files the message carries (resumable-chat-turns).
  let userMessage: BetaMessageParam | null;
  try {
    const blockRules = rules.map((rule) => ({ text: rule.text, summary: rule.schedule === null ? null : scheduleSummary(rule.schedule) }));
    userMessage = 'replyTo' in body ? null : userMessageOf(history, { rules: blockRules, attachments: attached?.block ?? null }, body.content);
  } catch (err) {
    await releaseClaims();
    throw err;
  }

  // resumable-chat-turns: the turn runs on this replica's runner whatever its connection does; only its time limit, a
  // stop request, a lost lease or shutdown abort it (signal.reason says which). Its ending is the stream's last event.
  const run = async ({ signal, emit }: { signal: AbortSignal; emit: (event: StreamEvent) => void }): Promise<TurnEnding> => {
    const send = (type: string, data: unknown): void => { emit({ type, data }); };
    try {
      // Only the newest business_rules block on the path is sent in full; the stored messages keep theirs.
      const modelHistory = historyForModel(history, userMessage);
      const person = userMessage ?? modelHistory.at(-1);
      // Sent in place of the stored message only when it differs: content was read, or a regenerate's files changed.
      const expanded = attached === null || person === undefined ? null : expandedMessage(person, attached);
      // D36: the files the path's messages attach, this one's included: read_data_item reads them again beyond text items,
      // holding their bytes against the same cap as the message's (turnBytes), given back with them when the turn ends.
      const attachedRefs = new Set([...modelHistory, ...(userMessage === null ? [] : [userMessage])].flatMap((param) => attachedTo(param).map((file) => file.ref)));
      send('conversation', { id: conversationId, title, userNodeId: nodes.user?.id ?? null, replyNodeId: nodes.reply.id, parentId, turnId });
      const result = await runTurn({
        model,
        // U13A: today is the town's local date, so an evening turn is not already tomorrow.
        tools: {
          ctx, scope, conversationId, location: toolLocation, today: localDay(ctx.now(), timeZone), timeZone, role: caller.role, actor: actorOf(caller),
          // read_data_item sets readUntrusted too, once it hands back an item's text or a picture; runTurn sets both for
          // web pages.
          turn: { readUntrusted: (attached?.content.length ?? 0) > 0, readWeb: false, pictureBytes: attached?.pictureBytes ?? 0 },
          files: { attached: attachedRefs, by: filesBy, bytes: turnBytes, sent: new Map(attached?.sent) },
        },
        history: modelHistory,
        userMessage,
        expanded,
        nodes,
        signal,
        now: ctx.now,
        emit: (event: TurnEvent) => { send(event.type, event.data); },
        charge: (cost) => ctx.stores.chatUsage.add(scope, monthOf(ctx.now()), cost, ctx.now()),
        budgetSpent: async () => (await budgetOf(ctx, scope)).exhausted,
        webSearch: ctx.config.chatWebSearch,
      });
      const counts = { calls: result.calls, ...searched(result.webSearches) };
      if (result.kind !== 'done') {
        // Nothing of the turn is saved: the claim goes, and a conversation that never finished a turn is deleted.
        await ctx.stores.chatConversations.release(scope, conversationId, turnId);
        if (result.kind === 'refused') {
          ctx.logger.info({ ...ids, ...counts, stopReason: 'refusal', costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn');
          return { state: 'done', event: { type: 'done', data: { stopReason: 'refusal', costUsd: result.costMicroUsd / 1_000_000, leafId: null, sources: [] } } };
        }
        if (result.kind === 'aborted') {
          const reason = signal.reason as TurnAbortReason;
          if (reason === 'timeout') {
            ctx.logger.warn({ ...ids, ...counts, code: 'timeout', costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn_failed');
            return { state: 'failed', event: { type: 'error', data: { code: 'timeout' } } };
          }
          ctx.logger.info({ ...ids, ...counts, reason, costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn_aborted');
          // Stop ends with `stopped`; shutdown and a lost lease (the record settled or deleted) with `interrupted`.
          if (reason === 'stop') return { state: 'stopped', event: { type: 'stopped', data: {} } };
          return { state: 'interrupted', event: { type: 'error', data: { code: 'interrupted' } } };
        }
        ctx.logger.warn({
          ...ids, ...counts, code: result.code, errType: result.errType, status: result.status,
          costMicroUsd: result.costMicroUsd,
        }, 'townwise.chat_turn_failed');
        return { state: 'failed', event: { type: 'error', data: { code: result.code } } };
      }
      const saved = await ctx.stores.chatConversations.finish(scope, conversationId, turnId, {
        messages: result.messages, now: ctx.now(), leafId: result.leafId,
      });
      if (!saved) {
        // Another turn took over the claim (this one ran past 3 minutes), or the conversation was deleted.
        ctx.logger.warn({ ...ids, ...counts, costMicroUsd: result.costMicroUsd }, 'townwise.chat_turn_not_saved');
        return { state: 'failed', event: { type: 'error', data: { code: 'internal' } } };
      }
      await recordAfter(ctx, {
        ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'chat.turn_completed',
        target: { type: 'conversation', id: conversationId },
        details: {
          locationId: location.id, conversationId, model: result.model, calls: result.calls,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens, stopReason: result.stopReason,
          ...(attached === null ? {} : { attachments: checks.length }), ...searched(result.webSearches),
        },
      });
      ctx.logger.info({
        ...ids, ...counts, stopReason: result.stopReason, costMicroUsd: result.costMicroUsd,
      }, 'townwise.chat_turn');
      // D37: the pages the reply's text cites, as the conversation view lists them under it.
      return {
        state: 'done',
        event: { type: 'done', data: { stopReason: result.stopReason, costUsd: result.costMicroUsd / 1_000_000, leafId: result.leafId, sources: result.sources } },
      };
    } catch (err) {
      // A store failure while saving: nothing was saved, and the claim goes if it can.
      ctx.logger.error({ ...ids, code: 'internal', errType: err instanceof Error ? err.constructor.name : typeof err }, 'townwise.chat_turn_failed');
      await ctx.stores.chatConversations.release(scope, conversationId, turnId).catch(() => undefined);
      return { state: 'failed', event: { type: 'error', data: { code: 'internal' } } };
    } finally {
      releaseBytes();
      // Before the turn's last event, so the client's next turn never finds this one still live.
      await releaseLiveTurn();
    }
  };

  // The record goes in after both claims and before the first event; a failure (or a replica shutting down) releases
  // the claims as any failure before the stream does.
  let running: RunningTurn;
  try {
    running = await ctx.turnRunner.start({
      scope, deadline, run,
      turn: {
        locationId: location.id, conversationId, userId: caller.userId, turnId, userNodeId: nodes.user?.id ?? null,
        replyNodeId: nodes.reply.id, parentId,
        message: 'replyTo' in body || userMessage === null ? null : { text: body.content, attachments: attachedTo(userMessage) },
      },
    });
  } catch (err) {
    await releaseClaims();
    throw err;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, PING_MS);
  let unsubscribe = (): void => undefined;
  // A closed connection only stops this listener: the turn runs on, and a reader can pick it up again from its record.
  const stopListening = (): void => {
    clearInterval(ping);
    unsubscribe();
  };
  res.on('close', stopListening);
  unsubscribe = running.subscribe((event) => {
    if (res.writableEnded || res.destroyed) return;
    // Each event's number is its SSE id, so a reader that loses the stream resumes after the last one it had.
    res.write(eventFrame(event));
    if (TERMINAL_EVENTS.has(event.type)) {
      stopListening();
      res.end();
    }
  });
}
