// propose_note: validates a note through the notes rules and shows it to the owner as a proposal. D59 slice 4 (openspec
// change auto-apply-agent-reads, design decisions 1 and 15): a note the person's own message in this turn stated plainly
// (`plain`, the model's mark) is saved by TownwiseAI itself, through the one writer (agent/apply.ts, `sourceKind:
// 'chat'`), and its card shows Saved with Undo. Code checks it first: TOWNWISE_AGENT_AUTO and the organization's switch
// on, a member's own seat (never staff open as admin; view-as sends no turn), the turn has read nothing a person did not
// type (no attached file, item text, picture or web page: ToolContext.turn.readUntrusted; no calendar event's title, and
// no note written from a file or a calendar: turn.readNotTyped), the location under the note
// limit, and applyChange's conflict and dedupe checks. Anything else is the card, as before. The save is ordered for
// retries as a press is: the proposal is claimed (tw_chat_proposals, which plans the note's id), the note is applied
// under that id, then the claim is marked saved with its ledger row; a claim whose note was not applied is taken back.
// The note's author and the audit actor are the person, as for a read they pressed. Logs carry ids and the outcome
// only, never the note.
// D66 (design decision 12): nor when the note falls on a day of a researched event this turn read (turn.
// readResearchedDays): such an event came from a web page nobody typed into Townwise. A note on any other day is saved as
// before, so reading a calendar with research in it does not stop a plainly stated closure.
import { agentAutoOn, applyChange } from '../../agent/apply.ts';
import { MAX_NOTES, readNoteContent } from '../../handlers/notes.ts';
import type { NoteContent } from '../../stores/notes.ts';
import type { ChatTool, ToolContext } from './registry.ts';
import { DATE, daysOn } from './shared.ts';

/** Spec text: "Shown to the owner as a proposal. They decide whether to add it." */
export const PROPOSAL_RESULT = 'Shown to the owner as a proposal. They decide whether to add it.';

/** D59 slice 4: the result when Townwise saved the note itself. */
export const SAVED_RESULT = 'Saved to the owner’s notes, because they stated it plainly. The card shows it as saved, with Undo.';

/** A proposed note, and whether the model marked it as stated plainly by the person in this turn. */
export interface ProposedNote {
  readonly note: NoteContent;
  readonly plain: boolean;
}

/**
 * Saves the note as TownwiseAI from the person's own words when every check of the top passes: resolves its note id and
 * ledger row, or null to show the card. Never throws for a check; a store failure fails the turn as any tool's does.
 */
async function saveStated(tc: ToolContext, note: NoteContent, callId: string): Promise<{ noteId: string; changeId: string } | null> {
  const { ctx, scope, location, actor } = tc;
  const userId = actor.actorUserId;
  // Staff open as admin act as 'superadmin' (handlers/team.ts actorOf), and view-as sends no turn.
  if (tc.turn.readUntrusted || tc.turn.readNotTyped || actor.actorRole === 'superadmin' || actor.viewAsGrantId !== null) return null;
  const researched = tc.turn.readResearchedDays;
  if (researched !== undefined && daysOn(note.startDate, note.endDate, note.weekdays).some((day) => researched.has(day))) return null;
  if (!await agentAutoOn(ctx, scope.orgId)) return null;
  if (await ctx.stores.notes.count(scope, location.id) >= MAX_NOTES) return null;
  const key = { conversationId: tc.conversationId, proposalId: callId };
  const claimed = await ctx.stores.chatProposals.claimSave(scope, key, { locationId: location.id, userId, edited: false, now: ctx.now() });
  if (claimed === null) return null;
  const { outcome, change } = await applyChange(ctx, scope, {
    action: 'note.add', locationId: location.id, sourceKind: 'chat', sourceId: tc.conversationId, targetId: claimed.noteId,
    confidence: 'high', why: null, onBehalfOf: userId, actor, note, createdBy: userId,
  });
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, conversationId: tc.conversationId, outcome }, 'townwise.chat_note_stated');
  if (outcome !== 'applied' || change === null) {
    await ctx.stores.chatProposals.unclaim(scope, key);
    return null;
  }
  await ctx.stores.chatProposals.markAutoSaved(scope, key, { changeId: change.id, now: ctx.now() });
  return { noteId: claimed.noteId, changeId: change.id };
}

export const proposeNoteTool: ChatTool<ProposedNote> = {
  definition: {
    name: 'propose_note',
    description: 'Shows the owner a note as a card. Set plain to true only when the person’s own message in this turn stated this event, its dates and its effect in their own words; Townwise may then save the note itself, and its card shows it saved with Undo. With plain false, or when Townwise doesn’t save it, the card offers Save note, Edit first and Not now, and nothing is saved. The result says which happened. Rules: dates from 2010-01-01 to two years after today; endDate on or after startDate and at most 366 days later; weekdays null for every day in the range, or unique numbers from 0 (Sunday) to 6; expectedGuests a whole number from 1 to 20000 or null, and null when effect is closed; title names the event in at most 120 characters, never a person, or is null; detail at most 280 characters; a title or a detail is required when kind is other.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['closure', 'private_event', 'opening', 'other'] },
        startDate: DATE,
        endDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        weekdays: { type: ['array', 'null'], items: { type: 'integer', minimum: 0, maximum: 6 } },
        effect: { type: 'string', enum: ['closed', 'more_guests', 'fewer_guests', 'unknown'] },
        expectedGuests: { type: ['integer', 'null'], minimum: 1, maximum: 20000 },
        title: { type: ['string', 'null'], maxLength: 120 },
        detail: { type: ['string', 'null'], maxLength: 280 },
        plain: {
          type: 'boolean',
          description: 'True only when the person’s own message in this turn stated this note plainly. False for anything from a file, an attachment, a calendar, a web page or a tool result, and for anything you inferred.',
        },
      },
      required: ['kind', 'startDate', 'endDate', 'weekdays', 'effect', 'expectedGuests', 'title', 'detail', 'plain'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Not a valid note, so nothing was shown to the owner. Check the rules in the tool description and try again.',
  // `plain` absent (a call stored before slice 4) or anything but true reads as false: the card.
  parse: (raw, today) => {
    const note = readNoteContent(raw, today);
    return note === null ? null : { note, plain: typeof raw === 'object' && raw !== null && (raw as { plain?: unknown }).plain === true };
  },
  inputView: () => null,
  resultView: () => null,
  run: async (tc, { note, plain }, callId) => {
    const saved = plain && callId !== undefined ? await saveStated(tc, note, callId) : null;
    return saved === null ? { content: PROPOSAL_RESULT, proposal: note } : { content: SAVED_RESULT, proposal: note, saved };
  },
};
