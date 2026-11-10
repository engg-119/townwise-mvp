import { z } from 'zod';

import type { ApiClient } from '../api/client';
import { dataItemSchema, type DataItem } from '../portal/data/api';
import { createNote, noteSchema, type Note } from '../portal/locations/api';
import type { SseEvent } from '../api/sse';
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

const budgetSchema = z.object({ month: z.string(), usedUsd: z.number(), limitUsd: z.number(), exhausted: z.boolean() });
const conversationSummarySchema = z.object({ id: z.string(), title: z.string(), updatedAt: z.string(), turnCount: z.number() });
const chatSummarySchema = z.object({
  enabled: z.boolean(),
  budget: budgetSchema,
  conversations: z.array(conversationSummarySchema),
});
/** GET .../chat/:conversationId, and POST .../active: the tree and the path to `activeLeafId`, the leaf shown. */
const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  activeLeafId: z.string().nullable().default(null),
  tree: z.array(treeNodeSchema).default([]),
  messages: z.array(z.object({
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
  })),
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
}

/** A conversation as the server shows it: the messages of one path, every node, and that path's leaf. */
export interface ConversationLoad { messages: StoredMessage[]; tree: TreeNode[]; activeLeafId: string | null }

export type ChatEvent =
  /**
   * The turn's conversation and its new nodes: the person's message (null for a regenerate) and the reply, and the
   * node the first of them hangs under. Null from a server without trees.
   */
  | { type: 'conversation'; id: string; title: string; userNodeId: string | null; replyNodeId: string | null; parentId: string | null }
  | { type: 'text'; delta: string }
  /** A piece of the reply's thinking summary. */
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'done' | 'error'; input: ToolView | null; result: ToolView | null }
  | { type: 'proposal'; id: string; proposal: NoteProposal }
  | { type: 'visual'; id: string; visual: Visual }
  | { type: 'suggestions'; id: string; prompts: string[] }
  /**
   * `leafId`: the conversation's leaf after the turn (the last node it saved, else the node it hung under); null for a
   * refusal, or from a server without trees.
   */
  | { type: 'done'; stopReason: string; leafId: string | null }
  | { type: 'error'; code: string };

const nodeIdOrNull = z.string().nullable().default(null);

const eventSchemas = {
  conversation: z.object({ id: z.string(), title: z.string(), userNodeId: nodeIdOrNull, replyNodeId: nodeIdOrNull, parentId: nodeIdOrNull }),
  text: z.object({ delta: z.string() }),
  thinking: z.object({ delta: z.string() }),
  tool: z.object({
    id: z.string(), name: z.string(), state: z.enum(['running', 'done', 'error']), input: viewSchema.default(null), result: viewSchema.default(null),
  }),
  proposal: z.object({ id: z.string(), proposal: noteProposalSchema }),
  visual: z.object({ id: z.string(), visual: visualSchema }),
  suggestions: z.object({ id: z.string(), prompts: z.array(z.string()) }),
  done: z.object({ stopReason: z.string(), leafId: nodeIdOrNull }),
  error: z.object({ code: z.string() }),
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
      return parsed.success ? { type: 'done', ...parsed.data } : null;
    }
    case 'error': {
      const parsed = eventSchemas.error.safeParse(data);
      return parsed.success ? { type: 'error', ...parsed.data } : null;
    }
    default:
      return null;
  }
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

function conversationOf(conversation: z.infer<typeof conversationSchema>): ConversationLoad {
  return {
    activeLeafId: conversation.activeLeafId,
    tree: conversation.tree,
    messages: conversation.messages.map((message) => ({
      role: message.role,
      text: message.text,
      parts: message.parts.flatMap(partOf),
      at: millis(message.at),
      endedAt: millis(message.endedAt ?? message.at),
      nodeId: message.nodeId,
      feedback: message.feedback,
      next: message.next,
    })),
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
 * appends to the leaf it has stored. No `conversationId` starts a new conversation, with no `parentId`.
 */
export type TurnRequest = { conversationId: string | null; content: string; parentId?: string | null } | { conversationId: string; replyTo: string };

function turnBody(turn: TurnRequest): Record<string, unknown> {
  if ('replyTo' in turn) return { conversationId: turn.conversationId, replyTo: turn.replyTo };
  if (turn.conversationId === null) return { content: turn.content };
  const body: Record<string, unknown> = { conversationId: turn.conversationId, content: turn.content };
  if (turn.parentId !== undefined) body.parentId = turn.parentId;
  return body;
}

/** One turn. Resolves when the stream ends. */
export function sendTurn(
  api: ApiClient,
  locationId: string,
  turn: TurnRequest,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const body = turnBody(turn);
  return api.stream(`${locationPath(locationId)}/chat/turns`, {
    body,
    signal,
    onEvent: (sse) => {
      const event = chatEventOf(sse);
      if (event !== null) onEvent(event);
    },
  });
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
const questionSchema = z.discriminatedUnion('kind', [
  /**
   * A weekday with no sales on most of its counted days, from `from` (the first day with sales in the window) to `to`:
   * `noSalesCount` of the `weekdayCount` days of that weekday in weeks with sales on other days.
   */
  z.object({
    id: z.string(), kind: z.literal('weekday'), weekday: z.number().int().min(0).max(6), from: dateSchema, to: dateSchema,
    noSalesCount: z.number().int(), weekdayCount: z.number().int(),
  }),
  /** A run of `dayCount` days with no sales and no note. */
  z.object({ id: z.string(), kind: z.literal('gap'), from: dateSchema, to: dateSchema, dayCount: z.number().int() }),
]);
export type Question = z.infer<typeof questionSchema>;

const activitySchema = z.discriminatedUnion('kind', [
  z.object({ at: z.string(), kind: z.literal('upload_applied'), firstDate: dateSchema, lastDate: dateSchema, dayCount: z.number().int() }),
  z.object({
    at: z.string(), kind: z.literal('note_saved'), via: z.enum(['chat', 'question']), noteId: z.string(),
    noteKind: noteProposalSchema.shape.kind, startDate: dateSchema, endDate: dateSchema,
  }),
  z.object({ at: z.string(), kind: z.literal('question_answered'), questionId: z.string(), answer: z.enum(['open', 'not_sure']) }),
  /** F3: a stored file Townwise read, and what it added. Never the file's name. */
  z.object({
    at: z.string(), kind: z.literal('file_processed'), fileId: z.string(), firstDate: dateSchema, lastDate: dateSchema, dayCount: z.number().int(),
  }),
]);
export type ActivityItem = z.infer<typeof activitySchema>;

// Items are read one by one: a question or an activity kind this client doesn't know yet is left out, never shown
// as a placeholder.
const panelSchema = z.object({ questions: z.array(z.unknown()), activity: z.array(z.unknown()) });

export interface AgentPanel { questions: Question[]; activity: ActivityItem[] }

function known<T>(items: readonly unknown[], schema: z.ZodType<T>): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function loadAgentPanel(api: ApiClient, locationId: string): Promise<AgentPanel> {
  const panel = await api.json(`${locationPath(locationId)}/agent`, panelSchema);
  return { questions: known(panel.questions, questionSchema), activity: known(panel.activity, activitySchema) };
}

export type QuestionAnswer = 'closed' | 'open' | 'not_sure';

const answerResultSchema = z.object({
  question: z.object({ id: z.string(), answer: z.enum(['closed', 'open', 'not_sure']) }),
  note: noteSchema.nullable(),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;

/** `closed` saves a closure note over the question's days; every answer stops the question being asked again. */
export function answerQuestion(api: ApiClient, locationId: string, questionId: string, answer: QuestionAnswer): Promise<AnswerResult> {
  return api.json(`${locationPath(locationId)}/agent/questions/${encodeURIComponent(questionId)}`, answerResultSchema, {
    method: 'POST', body: { answer },
  });
}
