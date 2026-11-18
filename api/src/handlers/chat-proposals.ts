// POST /api/org/locations/:locationId/chat/:conversationId/proposals/:proposalId (spec 10.12,
// docs/portal/tuning-chat.md section 2): the author saves a note TownwiseAI proposed in their conversation, as shown
// or edited first, or sets it aside. Only the author's press saves a note, and the note goes through the notes rules
// again. There are no transactions, so a save is ordered for retries: claim the proposal (tw_chat_proposals, which
// gives it its note id once), write the note with that id, then mark the proposal saved. A retry, a crash between
// the steps or a second tab pressing Save at the same time all end with one note. Note content never reaches a log.
import { objectId } from '@ckeith26/mongo';
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { nodesOf } from '../chat/tree.ts';
import { chatMessageViews, type ShownProposal } from '../chat/view.ts';
import { utcDay } from '../dates.ts';
import { TOWNWISE_STAFF } from '../people.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { ProposalKey, ProposalRecord } from '../stores/chat-proposals.ts';
import { notFound, ownerOf } from './chat.ts';
import { loadLocation, memberOf } from './locations.ts';
import { addNote, noteContent, noteView, sameNoteContent, type NoteView } from './notes.ts';

/** A tool_use block id: letters, digits, `_` and `-`. */
const proposalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const actionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), note: z.unknown().optional() }),
  z.object({ action: z.literal('dismiss') }),
]);

export interface ProposalResult {
  proposal: { id: string; status: 'saved' | 'dismissed'; noteId: string | null; edited: boolean };
  note: NoteView | null;
}

async function savedNoteView(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, row: ProposalRecord,
): Promise<NoteView | null> {
  const note = await ctx.stores.notes.find(caller.scope, location.id, row.noteId);
  // A note the author deleted since is gone; the proposal stays saved, so it is not offered again.
  return note === null ? null : noteView(note, note.byStaff ? TOWNWISE_STAFF : caller.email, caller);
}

function resultOf(row: ProposalRecord, note: NoteView | null): ProposalResult {
  const saved = row.status === 'saved';
  return {
    proposal: { id: row.proposalId, status: saved ? 'saved' : 'dismissed', noteId: saved ? row.noteId : null, edited: row.edited },
    note,
  };
}

export async function actOnProposal(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(actionBody, req.body);
  const today = utcDay(ctx.now());
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const proposalId = parseInput(proposalIdSchema, req.params.proposalId);
  const conversation = await ctx.stores.chatConversations.find(scope, ownerOf(caller, location.id), conversationId);
  if (conversation === null) throw notFound();
  // Only a proposal the owner was shown: a valid propose_note call whose result was not an error.
  const shown: ShownProposal | undefined = chatMessageViews(nodesOf(conversation.messages), today)
    .flatMap((message) => message.proposals)
    .find((proposal) => proposal.id === proposalId);
  if (shown === undefined) throw notFound();

  const proposals = ctx.stores.chatProposals;
  const key: ProposalKey = { conversationId, proposalId };
  const owner = { locationId: location.id, userId: caller.userId };
  const now = ctx.now();
  let result: ProposalResult;
  if (body.action === 'dismiss') {
    const row = await proposals.dismiss(scope, key, { ...owner, now });
    result = resultOf(row, row.status === 'saved' ? await savedNoteView(ctx, caller, location, row) : null);
  } else {
    // An edit with no `title` key (an app from before titles) keeps the proposal's title, as a note edit keeps its own.
    const content = body.note === undefined ? shown : noteContent(body.note, today, { keepTitle: shown.title });
    const claimed = await proposals.claimSave(scope, key, { ...owner, edited: !sameNoteContent(content, shown), now });
    if (claimed === null) {
      // Saved already, by an earlier press or another tab: answer with that save.
      const row = await proposals.find(scope, key);
      if (row === null) throw notFound();
      result = resultOf(row, await savedNoteView(ctx, caller, location, row));
    } else {
      const note = await addNote(ctx, caller, location, content, { id: claimed.noteId });
      await proposals.markSaved(scope, key, ctx.now());
      result = resultOf({ ...claimed, status: 'saved' }, noteView(note, note.byStaff ? TOWNWISE_STAFF : caller.email, caller));
    }
  }
  ctx.logger.info({
    orgId: scope.orgId, locationId: location.id, conversationId, status: result.proposal.status, edited: result.proposal.edited,
  }, 'townwise.chat_proposal');
  res.status(200).json(result);
}
