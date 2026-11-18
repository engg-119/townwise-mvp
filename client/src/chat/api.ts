import { z } from 'zod';

import type { ApiClient } from '../api/client';
import { withOrgId } from '../portal/api';
import { dataItemSchema, type DataItem } from '../portal/data/api';
import { createNote, NOTE_EFFECTS, NOTE_KINDS, noteSchema, type Note } from '../portal/locations/api';
import { knownRuleSuggestions, ruleScheduleSchema, ruleSchema, type Rule, type RuleSuggestion } from '../portal/rules/api';
import type { SseEvent } from '../api/sse';
import type { SourceLink } from './tools';
import type { TreeNode } from './tree';
import { visualSchema, type Visual } from './visuals/schema';

// TownwiseAI's API (docs/portal/tuning-chat.md, sections 2 and 3; spec 10.12) and its side panel (GET and POST
// .../agent, spec P25). Schemas strip unknown keys; an event whose data does not match is dropped, so a stream that
// loses its `done` reads as cut off. A tool view is dates, counts and source links only, never a figure. Every field
// the redesign added (trees, ratings, visuals, next questions) reads with a default, so an answer without it loads.

/** Exactly the body of POST /api/org/locations/:locationId/notes. */
const noteProposalSchema = z.object({
  kind: z.enum(['closure', 'private_event', 'opening', 'other']),
  startDate: z.string(),
  endDate: z.string(),
  weekdays: z.array(z.number().int()).nullish(),
  effect: z.enum(['closed', 'more_guests', 'fewer_guests', 'unknown']),
  expectedGuests: z.number().int().nullish(),
  detail: z.string().nullish(),
});

export interface NoteProposal {
  kind: 'closure' | 'private_event' | 'opening' | 'other';
  startDate: string;
  endDate: string;
  weekdays: number[] | null;
  effect: 'closed' | 'more_guests' | 'fewer_guests' | 'unknown';
  expectedGuests: number | null;
  detail: string | null;
}

function proposalOf(raw: z.infer<typeof noteProposalSchema>): NoteProposal {
  return {
    kind: raw.kind,
    startDate: raw.startDate,
    endDate: raw.endDate,
    weekdays: raw.weekdays ?? null,
    effect: raw.effect,
    expectedGuests: raw.expectedGuests ?? null,
    detail: raw.detail ?? null,
  };
}

/** What a tool card shows of a call's input or result: the server's view, read field by field (src/chat/tools.ts). */
export type ToolView = Record<string, unknown>;
const viewSchema = z.record(z.string(), z.unknown()).nullable();

const proposalStatusSchema = z.enum(['open', 'saved', 'dismissed']);
const proposalViewSchema = noteProposalSchema.extend({ id: z.string(), status: proposalStatusSchema, noteId: z.string().nullable() });

const partSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool'), id: z.string(), name: z.string(), state: z.enum(['done', 'error']), input: viewSchema, result: viewSchema,
  }),
  z.object({ type: z.literal('proposal'), proposal: proposalViewSchema }),
  // Read on its own (visualSchema), so a visual this client can't draw is left out and the rest of the reply loads.
  z.object({ type: z.literal('visual'), id: z.string(), visual: z.unknown() }),
]);

const feedbackReasonSchema = z.enum(['wrong_figures', 'made_up', 'missed_context', 'not_helpful', 'too_long', 'other']);
/** Why a reply was Not helpful: one of six fixed reasons, never free text (tuning-chat.md 5). */
export type FeedbackReason = z.infer<typeof feedbackReasonSchema>;
export interface Feedback { rating: 'up' | 'down'; reason: FeedbackReason | null }
const feedbackSchema = z.object({ rating: z.enum(['up', 'down']), reason: feedbackReasonSchema.nullable() });

const treeNodeSchema = z.object({ id: z.string(), parentId: z.string().nullable(), role: z.enum(['user', 'assistant']) });

/** What a file attached to a message is (D36), in the server's words; a kind this client doesn't know reads as `file`. */
export const ATTACHMENT_KINDS = ['text', 'picture', 'pdf', 'word', 'excel', 'zip', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * A file a person's message carries (D36): its Your data ref and kind, its name (null under view-as and once the file
 * is gone), and whether it is on, turned off or gone from Your data now.
 */
export interface MessageAttachment { ref: string; kind: AttachmentKind; name: string | null; state: 'on' | 'off' | 'gone' }

// Read one by one (as the panel's items): an entry without a ref is left out, an unknown kind is a file, and an
// unknown state is gone, so the chip never links to a page that may not be there.
const attachmentSchema = z.object({
  ref: z.string(),
  kind: z.enum(ATTACHMENT_KINDS).catch('file'),
  name: z.string().nullable().catch(null),
  state: z.enum(['on', 'off', 'gone']).catch('gone'),
});

// A reply's sources (D37): the pages its text cites from its web searches. Read one by one, keeping only an https
// link; a list that is absent (an API before D37) or not a list reads as none, so it never drops a `done` or a load.
const sourceSchema = z.object({ host: z.string(), url: z.string().startsWith('https://') });
const sourcesSchema = z.array(z.unknown()).catch([]);

function sourceLinks(raw: readonly unknown[]): SourceLink[] {
  return known(raw, sourceSchema);
}

const budgetSchema = z.object({ month: z.string(), usedUsd: z.number(), limitUsd: z.number(), exhausted: z.boolean() });
/** `running` (spec P25 build note, 2026-11-18): TownwiseAI is still replying in it; false from an API before it. */
const conversationSummarySchema = z.object({
  id: z.string(), title: z.string(), updatedAt: z.string(), turnCount: z.number(), running: z.boolean().catch(false).default(false),
});
/** resumable-chat-turns: the caller's running turn at the location, which the page opens on load; null for none. */
const runningTurnSchema = z.object({ conversationId: z.string(), turnId: z.string() });
const chatSummarySchema = z.object({
  enabled: z.boolean(),
  budget: budgetSchema,
  conversations: z.array(conversationSummarySchema),
  // Absent from an API before resumable turns; one that does not parse reads as none, so the chat still loads.
  liveTurn: runningTurnSchema.nullable().catch(null).default(null),
});
const messageSchema = z.object({
  nodeId: z.string().nullable().default(null),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  proposals: z.array(proposalViewSchema),
  parts: z.array(partSchema).default([]),
  at: z.string(),
  // Absent from a server that predates it: the entry's own `at`.
  endedAt: z.string().optional(),
  feedback: feedbackSchema.nullable().default(null),
  next: z.array(z.string()).nullable().default(null),
  attachments: z.array(z.unknown()).default([]),
  sources: sourcesSchema,
});

/**
 * resumable-chat-turns: the conversation's turn while it runs, or once it was interrupted, until its record goes (15
 * minutes after it ended) or a newer turn ends. `message` is the person's message, null for a regenerate.
 */
const liveTurnSchema = z.object({
  turnId: z.string(),
  state: z.enum(['running', 'interrupted']),
  startedAt: z.string(),
  userNodeId: z.string().nullable(),
  replyNodeId: z.string().nullable(),
  parentId: z.string().nullable(),
  message: messageSchema.nullable(),
});

/**
 * GET .../chat/:conversationId, and POST .../active: the tree and the path to `activeLeafId`, the leaf shown. While a
 * turn is live (and no `?node=` is asked for), the path ends at the node the turn hangs under.
 */
const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  activeLeafId: z.string().nullable().default(null),
  tree: z.array(treeNodeSchema).default([]),
  messages: z.array(messageSchema),
  // Absent from an API before resumable turns; one that does not parse reads as none, so the conversation still loads.
  liveTurn: liveTurnSchema.nullable().catch(null).default(null),
});

export type Budget = z.infer<typeof budgetSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;

/** A proposal as GET .../chat/:conversationId shows it: the note, the call's id, and what the author did with it. */
export interface ProposalView extends NoteProposal {
  id: string;
  status: 'open' | 'saved' | 'dismissed';
  noteId: string | null;
}

export type StoredPart =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'done' | 'error'; input: ToolView | null; result: ToolView | null }
  | { type: 'proposal'; proposal: ProposalView }
  | { type: 'visual'; id: string; visual: Visual };

export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  parts: StoredPart[];
  /** When its first message was stored, and its last (a reply's end), in ms since the epoch; null when unreadable. */
  at: number | null;
  endedAt: number | null;
  /** Its node in the tree; null from a server without trees. */
  nodeId: string | null;
  /** The author's rating of a reply; null for none and for the person's messages. */
  feedback: Feedback | null;
  /** The three questions suggested after a reply; null for none and for the person's messages. */
  next: string[] | null;
  /** The files the person's message carries, in order (D36); [] for a reply. */
  attachments: MessageAttachment[];
  /** The pages a reply cites from its web searches, in order (D37); [] for none and for the person's messages. */
  sources: SourceLink[];
}

/** A conversation's live turn (resumable-chat-turns): running, or interrupted and not yet gone. */
export interface LiveTurnLoad {
  turnId: string;
  state: 'running' | 'interrupted';
  /** When the turn started, in ms since the epoch; null when unreadable. */
  startedAt: number | null;
  /** The turn's new nodes and the node they hang under, as its `conversation` event names them. */
  userNodeId: string | null;
  replyNodeId: string | null;
  parentId: string | null;
  /** The person's message as they wrote it; null for a regenerate. */
  message: StoredMessage | null;
}

/**
 * A conversation as the server shows it: the messages of one path, every node, that path's leaf, and the turn
 * running in it (null for none).
 */
export interface ConversationLoad { messages: StoredMessage[]; tree: TreeNode[]; activeLeafId: string | null; liveTurn: LiveTurnLoad | null }

export type ChatEvent =
  /**
   * The turn's conversation and its new nodes: the person's message (null for a regenerate) and the reply, and the
   * node the first of them hangs under. Null from a server without trees. `turnId` (resumable-chat-turns): what its
   * events are read back and stopped by; null from a server before it.
   */
  | {
    type: 'conversation'; id: string; title: string; userNodeId: string | null; replyNodeId: string | null; parentId: string | null;
    turnId: string | null;
  }
  | { type: 'text'; delta: string }
  /** A piece of the reply's thinking summary. */
  | { type: 'thinking'; delta: string }
  /** The text streamed since the last tool call was written ahead of work, not as the answer: it joins the thinking. */
  | { type: 'aside' }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'done' | 'error'; input: ToolView | null; result: ToolView | null }
  | { type: 'proposal'; id: string; proposal: NoteProposal }
  | { type: 'visual'; id: string; visual: Visual }
  | { type: 'suggestions'; id: string; prompts: string[] }
  /**
   * `leafId`: the conversation's leaf after the turn (the last node it saved, else the node it hung under); null for a
   * refusal, or from a server without trees. `sources`: the pages the reply cites from its web searches (D37).
   */
  | { type: 'done'; stopReason: string; leafId: string | null; sources: SourceLink[] }
  /** `interrupted` (TURN_INTERRUPTED): the replica running the turn stopped; nothing of it was saved. */
  | { type: 'error'; code: string }
  /** A stopped turn's last event (resumable-chat-turns): it saved nothing but its cost. */
  | { type: 'stopped' };

/** The error code of a turn whose replica stopped mid-turn (a crash, a deploy): it is not continued. */
export const TURN_INTERRUPTED = 'interrupted';

/** Whether a turn's stream ends after this event: `done`, `error` or `stopped`. */
export function endsTurn(event: ChatEvent): boolean {
  return event.type === 'done' || event.type === 'error' || event.type === 'stopped';
}

const nodeIdOrNull = z.string().nullable().default(null);

const eventSchemas = {
  conversation: z.object({
    id: z.string(), title: z.string(), userNodeId: nodeIdOrNull, replyNodeId: nodeIdOrNull, parentId: nodeIdOrNull, turnId: z.string().nullable().default(null),
  }),
  text: z.object({ delta: z.string() }),
  thinking: z.object({ delta: z.string() }),
  tool: z.object({
    id: z.string(), name: z.string(), state: z.enum(['running', 'done', 'error']), input: viewSchema.default(null), result: viewSchema.default(null),
  }),
  proposal: z.object({ id: z.string(), proposal: noteProposalSchema }),
  visual: z.object({ id: z.string(), visual: visualSchema }),
  suggestions: z.object({ id: z.string(), prompts: z.array(z.string()) }),
  done: z.object({ stopReason: z.string(), leafId: nodeIdOrNull, sources: sourcesSchema }),
  error: z.object({ code: z.string() }),
  stopped: z.object({}),
};

/** A stream event as the chat reads it, or null for an unknown event or data that does not match. */
export function chatEventOf(sse: SseEvent): ChatEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(sse.data);
  } catch {
    return null;
  }
  switch (sse.event) {
    case 'conversation': {
      const parsed = eventSchemas.conversation.safeParse(data);
      return parsed.success ? { type: 'conversation', ...parsed.data } : null;
    }
    case 'text': {
      const parsed = eventSchemas.text.safeParse(data);
      return parsed.success ? { type: 'text', ...parsed.data } : null;
    }
    case 'thinking': {
      const parsed = eventSchemas.thinking.safeParse(data);
      return parsed.success ? { type: 'thinking', ...parsed.data } : null;
    }
    case 'aside':
      return { type: 'aside' };
    case 'tool': {
      const parsed = eventSchemas.tool.safeParse(data);
      return parsed.success ? { type: 'tool', ...parsed.data } : null;
    }
    case 'proposal': {
      const parsed = eventSchemas.proposal.safeParse(data);
      return parsed.success ? { type: 'proposal', id: parsed.data.id, proposal: proposalOf(parsed.data.proposal) } : null;
    }
    case 'visual': {
      const parsed = eventSchemas.visual.safeParse(data);
      return parsed.success ? { type: 'visual', ...parsed.data } : null;
    }
    case 'suggestions': {
      const parsed = eventSchemas.suggestions.safeParse(data);
      return parsed.success ? { type: 'suggestions', ...parsed.data } : null;
    }
    case 'done': {
      const parsed = eventSchemas.done.safeParse(data);
      return parsed.success ? { type: 'done', ...parsed.data, sources: sourceLinks(parsed.data.sources) } : null;
    }
    case 'error': {
      const parsed = eventSchemas.error.safeParse(data);
      return parsed.success ? { type: 'error', ...parsed.data } : null;
    }
    case 'stopped':
      return eventSchemas.stopped.safeParse(data).success ? { type: 'stopped' } : null;
    default:
      return null;
  }
}

/** An event's number in its turn (its SSE id, from 1), or null when it has none (a server before resumable turns). */
export function seqOf(sse: SseEvent): number | null {
  return sse.id !== undefined && /^[1-9]\d{0,8}$/.test(sse.id) ? Number(sse.id) : null;
}

/** A turn's events as the chat reads them, each with its number; an unknown event or data that does not match is dropped. */
export type TurnListener = (event: ChatEvent, seq: number | null) => void;

function chatEvents(onEvent: TurnListener): (sse: SseEvent) => void {
  return (sse) => {
    const event = chatEventOf(sse);
    if (event !== null) onEvent(event, seqOf(sse));
  };
}

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

function conversationPath(locationId: string, conversationId: string): `/${string}` {
  return `${locationPath(locationId)}/chat/${encodeURIComponent(conversationId)}`;
}

export function loadChat(api: ApiClient, locationId: string): Promise<ChatSummary> {
  return api.json(`${locationPath(locationId)}/chat`, chatSummarySchema);
}

function proposalViewOf(raw: z.infer<typeof proposalViewSchema>): ProposalView {
  return { ...proposalOf(raw), id: raw.id, status: raw.status, noteId: raw.noteId };
}

function partOf(part: z.infer<typeof partSchema>): StoredPart[] {
  if (part.type === 'proposal') return [{ type: 'proposal', proposal: proposalViewOf(part.proposal) }];
  if (part.type !== 'visual') return [part];
  const visual = visualSchema.safeParse(part.visual);
  return visual.success ? [{ type: 'visual', id: part.id, visual: visual.data }] : [];
}

function millis(value: string): number | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function storedOf(message: z.infer<typeof messageSchema>): StoredMessage {
  return {
    role: message.role,
    text: message.text,
    parts: message.parts.flatMap(partOf),
    at: millis(message.at),
    endedAt: millis(message.endedAt ?? message.at),
    nodeId: message.nodeId,
    feedback: message.feedback,
    next: message.next,
    attachments: message.role === 'user' ? known(message.attachments, attachmentSchema) : [],
    sources: message.role === 'assistant' ? sourceLinks(message.sources) : [],
  };
}

function conversationOf(conversation: z.infer<typeof conversationSchema>): ConversationLoad {
  const live = conversation.liveTurn;
  return {
    activeLeafId: conversation.activeLeafId,
    tree: conversation.tree,
    messages: conversation.messages.map(storedOf),
    liveTurn: live === null ? null : {
      turnId: live.turnId, state: live.state, startedAt: millis(live.startedAt), userNodeId: live.userNodeId, replyNodeId: live.replyNodeId,
      parentId: live.parentId, message: live.message === null ? null : storedOf(live.message),
    },
  };
}

/** The path to the stored leaf, or with `node` the newest version under that node, read without storing it (view-as). */
export async function loadConversation(api: ApiClient, locationId: string, conversationId: string, node?: string): Promise<ConversationLoad> {
  const query = node === undefined ? '' : `?node=${encodeURIComponent(node)}`;
  return conversationOf(await api.json(`${conversationPath(locationId, conversationId)}${query}`, conversationSchema));
}

/** Shows another version: stores the newest leaf under `nodeId` as the one shown, and answers its path. */
export async function setActiveVersion(api: ApiClient, locationId: string, conversationId: string, nodeId: string): Promise<ConversationLoad> {
  return conversationOf(await api.json(`${conversationPath(locationId, conversationId)}/active`, conversationSchema, {
    method: 'POST', body: { nodeId },
  }));
}

const renamedSchema = z.object({ id: z.string(), title: z.string() });

/** The title as the server keeps it (trimmed, 1 to 60 characters); a title it refuses is a 400. */
export function renameConversation(api: ApiClient, locationId: string, conversationId: string, title: string): Promise<{ id: string; title: string }> {
  return api.json(conversationPath(locationId, conversationId), renamedSchema, { method: 'PATCH', body: { title } });
}

const ratedSchema = z.object({ nodeId: z.string(), rating: z.enum(['up', 'down']).nullable(), reason: feedbackReasonSchema.nullable() });

/** Rates a reply, or clears its rating with null. A reason goes only with Not helpful. Answers the rating stored. */
export async function rateReply(
  api: ApiClient, locationId: string, conversationId: string, nodeId: string, rating: 'up' | 'down' | null, reason: FeedbackReason | null,
): Promise<Feedback | null> {
  const body = rating === 'down' && reason !== null ? { rating, reason } : { rating };
  const rated = await api.json(`${conversationPath(locationId, conversationId)}/feedback/${encodeURIComponent(nodeId)}`, ratedSchema, {
    method: 'POST', body,
  });
  return rated.rating === null ? null : { rating: rated.rating, reason: rated.reason };
}

/** 204. The conversation's proposal records go with it; notes saved from it stay. */
export async function deleteConversation(api: ApiClient, locationId: string, conversationId: string): Promise<void> {
  await api.request(conversationPath(locationId, conversationId), { method: 'DELETE' });
}

/**
 * A turn: a message, or a regenerate of the reply to the person's message `replyTo`. A message's `parentId` is the
 * node it hangs under (an edit names the edited message's parent; null starts a second root); left out, the server
 * appends to the leaf it has stored. No `conversationId` starts a new conversation, with no `parentId`. A message's
 * `attachments` (D36) are 1 to 5 `f_` refs of Your data, sent only when there are any; a regenerate never carries
 * them (the server reads its stored message's files again).
 */
export type TurnRequest =
  | { conversationId: string | null; content: string; parentId?: string | null; attachments?: readonly string[] }
  | { conversationId: string; replyTo: string };

function turnBody(turn: TurnRequest): Record<string, unknown> {
  if ('replyTo' in turn) return { conversationId: turn.conversationId, replyTo: turn.replyTo };
  const body: Record<string, unknown> = turn.conversationId === null ? { content: turn.content } : { conversationId: turn.conversationId, content: turn.content };
  if (turn.conversationId !== null && turn.parentId !== undefined) body.parentId = turn.parentId;
  if (turn.attachments !== undefined && turn.attachments.length > 0) body.attachments = [...turn.attachments];
  return body;
}

/** One turn. Resolves when the stream ends; closing it (`signal`) does not stop the turn on the server. */
export function sendTurn(api: ApiClient, locationId: string, turn: TurnRequest, signal: AbortSignal, onEvent: TurnListener): Promise<void> {
  return api.stream(`${locationPath(locationId)}/chat/turns`, { body: turnBody(turn), signal, onEvent: chatEvents(onEvent) });
}

function turnPath(locationId: string, conversationId: string, turnId: string): `/${string}` {
  return `${conversationPath(locationId, conversationId)}/turns/${encodeURIComponent(turnId)}`;
}

/**
 * A running turn's events numbered above `after` (0 for all of them), then each new one until its last (resumable-chat-
 * turns). Resolves when the stream ends: after the turn's last event, at once for a turn that ended at or before
 * `after`, or after 200 seconds without one, when the reader reconnects with its cursor. 404 for a turn that is gone.
 */
export function followTurn(
  api: ApiClient, locationId: string, ids: { conversationId: string; turnId: string }, after: number, signal: AbortSignal, onEvent: TurnListener,
): Promise<void> {
  return api.stream(`${turnPath(locationId, ids.conversationId, ids.turnId)}?after=${String(after)}`, {
    method: 'GET', signal, onEvent: chatEvents(onEvent),
  });
}

const stoppedSchema = z.object({ state: z.string() });

/**
 * Asks the author's running turn to stop: `running` while it still runs (its streams then end with `stopped`, within
 * about a second), or the state it already ended in. 404 for a turn that is not the caller's.
 */
export async function stopTurn(api: ApiClient, locationId: string, ids: { conversationId: string; turnId: string }): Promise<string> {
  const body = await api.json(`${turnPath(locationId, ids.conversationId, ids.turnId)}/stop`, stoppedSchema, { method: 'POST', body: {} });
  return body.state;
}

const proposalResultSchema = z.object({
  proposal: z.object({ id: z.string(), status: z.enum(['saved', 'dismissed']), noteId: z.string().nullable(), edited: z.boolean() }),
  note: noteSchema.nullable(),
});
export type ProposalResult = z.infer<typeof proposalResultSchema>;

/**
 * Saves a stored proposal as shown, or as the author edited it (`note`), through the proposal route (spec 10.12):
 * the notes rules and audit apply, and a retry or a second tab ends with the same one note.
 */
export function saveProposal(
  api: ApiClient, locationId: string, ids: { conversationId: string; proposalId: string }, note?: NoteProposal,
): Promise<ProposalResult> {
  const body = note === undefined ? { action: 'save' } : { action: 'save', note };
  return api.json(`${conversationPath(locationId, ids.conversationId)}/proposals/${encodeURIComponent(ids.proposalId)}`, proposalResultSchema, {
    method: 'POST', body,
  });
}

/** Not now: recorded, so a reload keeps it set aside; it can still be saved. A saved proposal answers saved. */
export function dismissProposal(api: ApiClient, locationId: string, ids: { conversationId: string; proposalId: string }): Promise<ProposalResult> {
  return api.json(`${conversationPath(locationId, ids.conversationId)}/proposals/${encodeURIComponent(ids.proposalId)}`, proposalResultSchema, {
    method: 'POST', body: { action: 'dismiss' },
  });
}

// A proposal to keep text on Your data (D28): a propose_data_item call, read and acted on through its own route once
// its turn is stored. The title and the text come only from the stored call.
const itemProposalSchema = z.object({
  proposal: z.object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    status: proposalStatusSchema,
    /** The kept item; null when it is not kept, or was deleted since. */
    item: dataItemSchema.nullable(),
  }),
});

export interface ItemProposal { id: string; title: string; text: string; status: 'open' | 'saved' | 'dismissed'; item: DataItem | null }

function itemProposalPath(locationId: string, ids: { conversationId: string; proposalId: string }): `/${string}` {
  return `${conversationPath(locationId, ids.conversationId)}/item-proposals/${encodeURIComponent(ids.proposalId)}`;
}

export async function loadItemProposal(api: ApiClient, locationId: string, ids: { conversationId: string; proposalId: string }): Promise<ItemProposal> {
  const body = await api.json(itemProposalPath(locationId, ids), itemProposalSchema);
  return body.proposal;
}

/** Keep (`save`) writes exactly the stored call's text as an item on Your data; Not now (`dismiss`) sets it aside. */
export async function actOnItemProposal(
  api: ApiClient, locationId: string, ids: { conversationId: string; proposalId: string }, action: 'save' | 'dismiss',
): Promise<ItemProposal> {
  const body = await api.json(itemProposalPath(locationId, ids), itemProposalSchema, { method: 'POST', body: { action } });
  return body.proposal;
}

/** A proposal from a turn the server never kept: the notes route, as the person. */
export function addNote(api: ApiClient, locationId: string, note: NoteProposal): Promise<Note> {
  return createNote(api, locationId, note);
}

// The side panel (spec P25). Questions and activity are ids, dates and counts; the words are the client's.

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// The shapes api/README.md (Tuning chat) and docs/portal/tuning-chat.md section 8 document.
// D46: the weekday question became a suggested closure rule (`ruleSuggestions`), so a weekday question from an older
// API is a kind this client no longer reads, and is left out.
const questionSchema = z.discriminatedUnion('kind', [
  /**
   * A run of `dayCount` days with no sales and no note, asked only when one of its days is usually busy; the typical
   * guests (spec D32), lowest and highest, of those usually busy days. An API from before them sends neither, and the
   * card then says only that there are no sales.
   */
  z.object({
    id: z.string(), kind: z.literal('gap'), from: dateSchema, to: dateSchema, dayCount: z.number().int(),
    typicalGuestsLow: z.number().int().optional(), typicalGuestsHigh: z.number().int().optional(),
  }),
  /** A usually busy day with almost no guests recorded (spec D32's likely closed): its `guests` and `typicalGuests`. */
  z.object({
    id: z.string(), kind: z.literal('likely_closed'), date: dateSchema, guests: z.number().int().min(0), typicalGuests: z.number().int(),
  }),
]);
export type Question = z.infer<typeof questionSchema>;

const activitySchema = z.discriminatedUnion('kind', [
  z.object({ at: z.string(), kind: z.literal('upload_applied'), firstDate: dateSchema, lastDate: dateSchema, dayCount: z.number().int() }),
  z.object({
    at: z.string(), kind: z.literal('note_saved'), via: z.enum(['chat', 'question']), noteId: z.string(),
    noteKind: noteProposalSchema.shape.kind, startDate: dateSchema, endDate: dateSchema,
  }),
  z.object({ at: z.string(), kind: z.literal('question_answered'), questionId: z.string(), answer: z.enum(['open', 'not_sure', 'other']) }),
  /** F3: a stored file Townwise read, and what it added. Never the file's name. */
  z.object({
    at: z.string(), kind: z.literal('file_processed'), fileId: z.string(), firstDate: dateSchema, lastDate: dateSchema, dayCount: z.number().int(),
  }),
]);
export type ActivityItem = z.infer<typeof activitySchema>;

/** A calendar entry a weekly suggestion rests on: public town calendar data. */
const suggestionCalendarSchema = z.object({ id: z.string(), title: z.string(), start: dateSchema, end: dateSchema });

/** A suggested note: every field of the notes route's body, hours included. */
const suggestedNoteSchema = z.object({
  kind: z.enum(NOTE_KINDS), startDate: dateSchema, endDate: dateSchema, weekdays: z.array(z.number().int()).nullable(),
  effect: z.enum(NOTE_EFFECTS), expectedGuests: z.number().int().nullable(), detail: z.string().nullable(),
  startTime: z.string().nullable(), endTime: z.string().nullable(),
});

/**
 * A weekly suggestion (openspec change weekly-forecast-suggestions): a note, or a business rule with its words and
 * schedule, with TownwiseAI's one-sentence why and the calendar entries it names. It changes nothing until an org admin
 * accepts it.
 */
const suggestionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(), why: z.string(), calendar: z.array(suggestionCalendarSchema), createdAt: z.string(),
    type: z.literal('note'), note: suggestedNoteSchema,
  }),
  z.object({
    id: z.string(), why: z.string(), calendar: z.array(suggestionCalendarSchema), createdAt: z.string(),
    type: z.literal('rule'), text: z.string(), schedule: ruleScheduleSchema, scheduleSummary: z.string(),
  }),
]);
export type Suggestion = z.infer<typeof suggestionSchema>;

/**
 * The organization's switch: `on` unless an org admin turned it off, `available` while the server can run passes (its
 * switch and TownwiseAI on), `canChange` for an org admin outside view-as.
 */
const weeklySuggestionsSchema = z.object({ on: z.boolean(), available: z.boolean(), canChange: z.boolean() });
export type WeeklySuggestions = z.infer<typeof weeklySuggestionsSchema>;

// Items are read one by one: a question, an activity kind or a suggestion this client doesn't know yet is left out,
// never shown as a placeholder. An API from before weekly suggestions sends neither of their keys.
const panelSchema = z.object({
  questions: z.array(z.unknown()), activity: z.array(z.unknown()), suggestions: z.array(z.unknown()).optional(),
  weeklySuggestions: z.unknown().optional(), ruleSuggestions: z.array(z.unknown()).optional(),
});

export interface AgentPanel {
  questions: Question[]; activity: ActivityItem[];
  /** Open weekly suggestions, soonest first. */
  suggestions: Suggestion[];
  /** Null from an API before weekly suggestions. */
  weeklySuggestions: WeeklySuggestions | null;
  /** D46: the open suggested closure rules from files and the sales history; none from an API before them. */
  ruleSuggestions: RuleSuggestion[];
}

function known<T>(items: readonly unknown[], schema: z.ZodType<T>): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function loadAgentPanel(api: ApiClient, locationId: string): Promise<AgentPanel> {
  const panel = await api.json(`${locationPath(locationId)}/agent`, panelSchema);
  const weekly = weeklySuggestionsSchema.safeParse(panel.weeklySuggestions);
  return {
    questions: known(panel.questions, questionSchema), activity: known(panel.activity, activitySchema),
    suggestions: known(panel.suggestions ?? [], suggestionSchema), weeklySuggestions: weekly.success ? weekly.data : null,
    ruleSuggestions: knownRuleSuggestions(panel.ruleSuggestions ?? []),
  };
}

export type QuestionAnswer = 'closed' | 'open' | 'not_sure' | 'other';

const answerResultSchema = z.object({
  question: z.object({ id: z.string(), answer: z.enum(['closed', 'open', 'not_sure', 'other']) }),
  note: noteSchema.nullable(),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;

/**
 * `closed` saves a closure note over the question's days, and `open` on a likely-closed question the note that it was
 * open with few guests; every answer stops the question being asked again. The body is the answer alone: `other`
 * (Something else…) carries no words, which go to the chat as a message.
 */
export function answerQuestion(api: ApiClient, locationId: string, questionId: string, answer: QuestionAnswer): Promise<AnswerResult> {
  return api.json(`${locationPath(locationId)}/agent/questions/${encodeURIComponent(questionId)}`, answerResultSchema, {
    method: 'POST', body: { answer },
  });
}

const decideResultSchema = z.object({
  suggestion: z.object({ id: z.string(), status: z.enum(['accepted', 'dismissed']) }),
  note: noteSchema.nullable(),
  rule: ruleSchema.nullable(),
});
export interface DecideResult {
  suggestion: { id: string; status: 'accepted' | 'dismissed' };
  /** What an accepted suggestion wrote (null when dismissed, or deleted since). */
  note: Note | null;
  rule: Rule | null;
}

/**
 * Accept writes the suggestion's note or rule, as written by the org admin; Dismiss writes nothing. The body is empty.
 * 404 when it is gone (dismissed, accepted elsewhere as dismissed, or its first date has come).
 */
export function decideSuggestion(
  api: ApiClient, locationId: string, suggestionId: string, decision: 'accept' | 'dismiss',
): Promise<DecideResult> {
  return api.json(`${locationPath(locationId)}/agent/suggestions/${encodeURIComponent(suggestionId)}/${decision}`, decideResultSchema, {
    method: 'POST', body: {},
  });
}

const switchedSchema = z.object({ weeklySuggestions: z.object({ on: z.boolean() }) });

/** PATCH /api/org/weekly-suggestions { on, orgId? } (orgId from openAsAdminOrgId): the organization's switch. */
export async function setWeeklySuggestions(api: ApiClient, on: boolean, orgId: string | null): Promise<boolean> {
  const body = await api.json('/api/org/weekly-suggestions', switchedSchema, { method: 'PATCH', body: withOrgId({ on }, orgId) });
  return body.weeklySuggestions.on;
}
