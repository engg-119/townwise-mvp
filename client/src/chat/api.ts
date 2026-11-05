import { z } from 'zod';

import type { ApiClient } from '../api/client';
import type { SseEvent } from '../api/sse';

// The tuning chat's API (docs/portal/tuning-chat.md, sections 2 and 3). Schemas strip unknown keys; an event
// whose data does not match is dropped, so a stream that loses its `done` reads as cut off.

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

const budgetSchema = z.object({ month: z.string(), usedUsd: z.number(), limitUsd: z.number(), exhausted: z.boolean() });
const conversationSummarySchema = z.object({ id: z.string(), title: z.string(), updatedAt: z.string(), turnCount: z.number() });
const chatSummarySchema = z.object({
  enabled: z.boolean(),
  budget: budgetSchema,
  conversations: z.array(conversationSummarySchema),
});
const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    proposals: z.array(noteProposalSchema),
    at: z.string(),
  })),
});

export type Budget = z.infer<typeof budgetSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export interface StoredMessage { role: 'user' | 'assistant'; text: string; proposals: NoteProposal[] }

export type ChatEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; state: 'running' | 'done' | 'error' }
  | { type: 'proposal'; proposal: NoteProposal }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; code: string };

const eventSchemas = {
  conversation: z.object({ id: z.string(), title: z.string() }),
  text: z.object({ delta: z.string() }),
  tool: z.object({ name: z.string(), state: z.enum(['running', 'done', 'error']) }),
  proposal: z.object({ proposal: noteProposalSchema }),
  done: z.object({ stopReason: z.string() }),
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
    case 'tool': {
      const parsed = eventSchemas.tool.safeParse(data);
      return parsed.success ? { type: 'tool', ...parsed.data } : null;
    }
    case 'proposal': {
      const parsed = eventSchemas.proposal.safeParse(data);
      return parsed.success ? { type: 'proposal', proposal: proposalOf(parsed.data.proposal) } : null;
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

export function loadChat(api: ApiClient, locationId: string): Promise<ChatSummary> {
  return api.json(`${locationPath(locationId)}/chat`, chatSummarySchema);
}

export async function loadConversation(api: ApiClient, locationId: string, conversationId: string): Promise<StoredMessage[]> {
  const conversation = await api.json(`${locationPath(locationId)}/chat/${encodeURIComponent(conversationId)}`, conversationSchema);
  return conversation.messages.map((message) => ({
    role: message.role,
    text: message.text,
    proposals: message.proposals.map(proposalOf),
  }));
}

/** One turn. No `conversationId` starts a new conversation. Resolves when the stream ends. */
export function sendTurn(
  api: ApiClient,
  locationId: string,
  turn: { conversationId: string | null; content: string },
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const body = turn.conversationId === null ? { content: turn.content } : { conversationId: turn.conversationId, content: turn.content };
  return api.stream(`${locationPath(locationId)}/chat/turns`, {
    body,
    signal,
    onEvent: (sse) => {
      const event = chatEventOf(sse);
      if (event !== null) onEvent(event);
    },
  });
}

/** Posts a proposal to the notes route as the person: the server's validation and audit apply. */
export async function addNote(api: ApiClient, locationId: string, proposal: NoteProposal): Promise<void> {
  await api.request(`${locationPath(locationId)}/notes`, { method: 'POST', body: proposal });
}
