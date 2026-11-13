// /api/org/locations/:locationId/chat/:conversationId/item-proposals/:proposalId (Your data, D28, design call 19): GET
// shows one card where TownwiseAI proposed keeping text (a propose_data_item call) and what became of it; POST keeps it
// or sets it aside. Only the conversation's author reaches it, and Keep saves exactly the text of the stored call,
// never text from the request. There are no transactions, so a Keep is ordered for retries: claim the proposal
// (tw_chat_proposals, which reserves the kept file's id once), write the item with that id, then mark the proposal
// saved. A retry, a crash between the steps or a second tab pressing Keep at the same time all end with one item.
// The title and the text never reach a log line or an audit event.
import { objectId } from '@ckeith26/mongo';
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { shownToolCall } from '../chat/shown-call.ts';
import { ITEM_PROPOSAL_RESULT, proposeDataTool, type ProposeDataInput } from '../chat/tools/propose-data.ts';
import { loadDataItem } from '../data/library.ts';
import type { FileBlobs } from '../files/blobs.ts';
import type { ProposalKey, ProposalRecord } from '../stores/chat-proposals.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { notFound, ownerOf } from './chat.ts';
import { itemView, type DataItemView } from './data.ts';
import { keepTextItem } from './files.ts';
import { loadLocation, memberOf } from './locations.ts';
import { filesUnavailable } from './sales.ts';

export interface ItemProposalView {
  id: string;
  title: string;
  text: string;
  status: 'open' | 'saved' | 'dismissed';
  /** The kept item; null when it is not kept, or was deleted since. */
  item: DataItemView | null;
}

/** A tool_use block id: letters, digits, `_` and `-` (as handlers/chat-proposals.ts reads one). */
const proposalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Keep or Not now, and nothing else: the text comes from the stored call. */
const actionBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save') }),
  z.strictObject({ action: z.literal('dismiss') }),
]);

interface Shown {
  readonly location: LocationRecord;
  readonly key: ProposalKey;
  readonly input: ProposeDataInput;
}

/**
 * The proposal the path names: a propose_data_item call in the caller's own conversation at the location that the
 * owner was shown, its result the proposal (not an error, and not "can't keep items yet"). Anything else is 404.
 */
async function loadShown(ctx: TownwiseContext, caller: MemberPrincipal, req: Request): Promise<Shown> {
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const proposalId = parseInput(proposalIdSchema, req.params.proposalId);
  const conversation = await ctx.stores.chatConversations.find(caller.scope, ownerOf(caller, location.id), conversationId);
  if (conversation === null) throw notFound();
  const call = shownToolCall(conversation.messages, proposeDataTool.definition.name, proposalId);
  const input = call?.content === ITEM_PROPOSAL_RESULT ? proposeDataTool.parse(call.input, '') : null;
  if (input === null) throw notFound();
  return { location, key: { conversationId, proposalId }, input };
}

async function viewOf(ctx: TownwiseContext, caller: MemberPrincipal, shown: Shown, row: ProposalRecord | null): Promise<ItemProposalView> {
  // A Keep that has not finished reads as open: pressing Keep again finishes the same item.
  const status = row === null || row.status === 'saving' ? 'open' : row.status;
  let item: DataItemView | null = null;
  if (row !== null && status === 'saved') {
    const kept = await loadDataItem(ctx, caller.scope, shown.location.id, { type: 'file', id: row.noteId }, caller.userId);
    item = kept === null ? null : await itemView(ctx, caller, kept);
  }
  return { id: shown.key.proposalId, title: shown.input.title, text: shown.input.text, status, item };
}

/** GET: the card's title and text, and whether it was kept. A read: it writes nothing and logs nothing. */
export async function getItemProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const shown = await loadShown(ctx, caller, req);
  const row = await ctx.stores.chatProposals.find(caller.scope, shown.key);
  res.status(200).json({ proposal: await viewOf(ctx, caller, shown, row) });
}

/** Claims the proposal, writes the item with the claimed id, then marks it saved. Null when the item was refused (409). */
async function keep(ctx: TownwiseContext, res: Response, caller: MemberPrincipal, blobs: FileBlobs, shown: Shown): Promise<ProposalRecord | null> {
  const proposals = ctx.stores.chatProposals;
  const { scope } = caller;
  const claimed = await proposals.claimSave(scope, shown.key, {
    locationId: shown.location.id, userId: caller.userId, kind: 'item', edited: false, now: ctx.now(),
  });
  if (claimed === null) {
    // Kept already, by an earlier press or another tab: answer with that save.
    const row = await proposals.find(scope, shown.key);
    if (row === null) throw notFound();
    return row;
  }
  const saved = await keepTextItem(ctx, res, caller, blobs, shown.location.id, {
    id: claimed.noteId, title: shown.input.title, text: shown.input.text, addedVia: 'townwise_ai',
  });
  // Refused: the proposal stays claimed, which reads as open, so Keep can be pressed again.
  if (saved === null) return null;
  await proposals.markSaved(scope, shown.key, ctx.now());
  return { ...claimed, status: 'saved' };
}

/**
 * POST { action: 'save' } keeps the text as a .txt reference item, saved from TownwiseAI; { action: 'dismiss' } sets it
 * aside, unless it is kept. Keep stores bytes, so it answers 503 files_unavailable while stored files are off, before
 * anything is looked up; Not now stores none.
 */
export async function actOnItemProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(actionBody, req.body);
  const blobs = ctx.files;
  if (body.action === 'save' && blobs === null) throw filesUnavailable();
  const shown = await loadShown(ctx, caller, req);
  const row = body.action === 'save' && blobs !== null
    ? await keep(ctx, res, caller, blobs, shown)
    : await ctx.stores.chatProposals.dismiss(scope, shown.key, {
      locationId: shown.location.id, userId: caller.userId, kind: 'item', now: ctx.now(),
    });
  if (row === null) return;
  const proposal = await viewOf(ctx, caller, shown, row);
  ctx.logger.info({
    orgId: scope.orgId, locationId: shown.location.id, conversationId: shown.key.conversationId, status: proposal.status, edited: false,
  }, 'townwise.chat_proposal');
  res.status(200).json({ proposal });
}
