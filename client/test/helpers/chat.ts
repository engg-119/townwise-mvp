import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions, type StreamOptions } from '../../src/api/client';

// A fake ApiClient for TownwiseAI: GETs answer from mutable fixtures, each turn is a stream the test drives event by
// event, and writes (proposal saves, notes, question answers, deletes, renames, version switches, ratings, the name) are
// recorded and answered by `respond`, which a test can replace path by path. Aborting a turn's signal rejects it as
// the real client does. Fixtures are synthetic: low-entropy ids, example.com addresses, no real figures.

const EMAIL = ['a', 'example.com'].join('@');

export const PROPOSAL = {
  kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', weekdays: null, effect: 'closed',
  expectedGuests: null, detail: 'Closed for the holidays.', title: null,
} as const;

export const PROPOSAL_ID = 'toolu_test_0001';

export const SUMMARY = {
  enabled: true,
  budget: { month: '2026-11', usedUsd: 1.25, limitUsd: 20, exhausted: false },
  conversations: [{ id: 'c1', title: 'Earlier chat', updatedAt: '2026-11-02T15:00:00.000Z', turnCount: 2 }],
};

export const SALES_STEP = {
  id: 'toolu_test_0002', name: 'get_sales_days',
  input: { from: '2025-12-01', to: '2025-12-31' },
  result: { from: '2025-12-01', to: '2025-12-31', dayCount: 31, guestsDayCount: 31, netSalesDayCount: 30 },
} as const;

/** As GET .../chat/:conversationId answers it: the tree, the leaf of the path shown, and that path's messages. */
export const CONVERSATION = {
  id: 'c1',
  title: 'Earlier chat',
  updatedAt: '2026-11-02T15:00:00.000Z',
  activeLeafId: 'a1',
  tree: [{ id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' }],
  messages: [
    { nodeId: 'u1', role: 'user', text: 'We close for the holidays.', proposals: [], parts: [], at: '2026-11-02T14:59:00.000Z' },
    {
      nodeId: 'a1',
      role: 'assistant',
      text: 'Last December you were open every day.\n\nHere is a note for that.',
      proposals: [{ ...PROPOSAL, id: PROPOSAL_ID, status: 'open', noteId: null }],
      parts: [
        { type: 'thinking', text: 'Checked December against the notes.' },
        { type: 'text', text: 'Last December you were open every day.' },
        { type: 'tool', state: 'done', ...SALES_STEP },
        { type: 'text', text: 'Here is a note for that.' },
        { type: 'proposal', proposal: { ...PROPOSAL, id: PROPOSAL_ID, status: 'open', noteId: null } },
      ],
      // Its first stored message's time, at or after the person's and at or before its end, as the server stores them.
      at: '2026-11-02T14:59:01.000Z',
      // 12 seconds after the person's message.
      endedAt: '2026-11-02T14:59:12.000Z',
    },
  ],
};

export function noteOf(content: Record<string, unknown>, id = 'n1'): Record<string, unknown> {
  return {
    ...PROPOSAL, ...content, id, createdByEmail: EMAIL, createdAt: '2026-11-02T15:01:00.000Z', updatedAt: '2026-11-02T15:01:00.000Z', canEdit: true,
  };
}

export const PANEL = {
  questions: [
    // The shapes api/README.md (Tuning chat) documents for GET .../agent.
    { id: 'weekday_1_2025-11-03_2026-11-02', kind: 'weekday', weekday: 1, from: '2025-11-03', to: '2026-11-02', noSalesCount: 41, weekdayCount: 52 },
    { id: 'gap_2026-02-01_2026-02-03', kind: 'gap', from: '2026-02-01', to: '2026-02-03', dayCount: 3 },
    // A kind this client doesn't know yet: left out.
    { id: 'later_0001', kind: 'something_later' },
  ],
  activity: [
    { at: '2026-11-03T15:00:00.000Z', kind: 'note_saved', via: 'chat', noteId: 'n1', noteKind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26' },
    { at: '2026-11-02T15:00:00.000Z', kind: 'upload_applied', firstDate: '2026-10-26', lastDate: '2026-11-01', dayCount: 7 },
    { at: '2026-11-01T15:00:00.000Z', kind: 'question_answered', questionId: 'gap_2026-01-01_2026-01-02', answer: 'open' },
    { at: '2026-10-31T15:00:00.000Z', kind: 'forecast_made', modelVersion: 'later' },
  ],
};

export interface LiveTurn {
  path: string;
  body: unknown;
  signal: AbortSignal | undefined;
  emit(event: string, data: unknown): void;
  end(): void;
  fail(error: unknown): void;
}

export interface Write { method: string; path: string; body: unknown }

export interface FakeChatApi extends ApiClient {
  summary: unknown;
  /** GET .../chat/:conversationId, and the answer to a version switch that `versions` doesn't list. */
  conversation: unknown;
  /** The view of another version, by node id: GET .../chat/:conversationId?node= and POST .../active answer it. */
  versions: Record<string, unknown>;
  /** Every GET .../chat/:conversationId path read, with its query. */
  conversationReads: string[];
  panel: unknown;
  /** GET /api/me/profile, the name TownwiseAI greets by; a PATCH stores the name sent and stops asking. */
  profile: unknown;
  /** Thrown by GET .../chat when set. */
  chatError: ApiError | null;
  /** Thrown by GET .../agent when set. */
  panelError: ApiError | null;
  /** Rejects the next turns before any event, as a refused POST does. */
  refuse: ApiError | null;
  /** Rejects one turn each, in order, before `refuse` applies (a claim the server still holds, then a stream). */
  refusals: ApiError[];
  /** The answer to a write, by path: a body, an ApiError to throw, or a promise of either. Unlisted paths get the defaults. */
  respond: Record<string, (body: unknown) => unknown>;
  /** The answer to a GET, by path, ahead of the defaults (an item card's own GET, D28). */
  reads: Record<string, () => unknown>;
  turns: LiveTurn[];
  writes: Write[];
  summaryLoads: number;
  panelLoads: number;
}

const BASE = '/api/org/locations/l1';

function defaultAnswer(api: FakeChatApi, method: string, path: string, body: unknown): unknown {
  const input = (body ?? {}) as {
    action?: string; note?: Record<string, unknown>; answer?: string; nodeId?: string; title?: string; rating?: string | null; reason?: string | null;
    displayName?: string | null;
  };
  if (method === 'PATCH' && path === '/api/me/profile') {
    api.profile = { displayName: input.displayName ?? null, askName: false };
    return api.profile;
  }
  const active = new RegExp(`^${BASE}/chat/[^/]+/active$`).exec(path);
  if (active !== null) return (input.nodeId === undefined ? undefined : api.versions[input.nodeId]) ?? api.conversation;
  const feedback = new RegExp(`^${BASE}/chat/[^/]+/feedback/([^/]+)$`).exec(path);
  if (feedback !== null) return { nodeId: feedback[1], rating: input.rating ?? null, reason: input.reason ?? null };
  const renamed = new RegExp(`^${BASE}/chat/([^/]+)$`).exec(path);
  if (method === 'PATCH' && renamed !== null) return { id: renamed[1], title: input.title };
  const proposal = new RegExp(`^${BASE}/chat/[^/]+/proposals/([^/]+)$`).exec(path);
  if (proposal !== null) {
    const save = input.action === 'save';
    return {
      proposal: { id: proposal[1], status: save ? 'saved' : 'dismissed', noteId: save ? 'n1' : null, edited: input.note !== undefined },
      note: save ? noteOf(input.note ?? {}) : null,
    };
  }
  if (path === `${BASE}/notes`) return { note: noteOf((body ?? {}) as Record<string, unknown>) };
  const question = new RegExp(`^${BASE}/agent/questions/([^/]+)$`).exec(path);
  if (question !== null) {
    const closed = input.answer === 'closed';
    const weekday = question[1]?.startsWith('weekday_') === true;
    return {
      question: { id: question[1], answer: input.answer },
      note: closed ? noteOf(weekday ? { startDate: '2025-11-03', endDate: '2026-11-02', weekdays: [1], detail: null } : { startDate: '2026-02-01', endDate: '2026-02-03', detail: null }, 'n2') : null,
    };
  }
  return new ApiError('http', 'The request was refused.', { status: 404, code: 'not_found' });
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  return schema.parse(resolved);
}

export function fakeChatApi(): FakeChatApi {
  const api: FakeChatApi = {
    summary: SUMMARY,
    conversation: CONVERSATION,
    versions: {},
    conversationReads: [],
    panel: PANEL,
    profile: { displayName: null, askName: false },
    chatError: null,
    panelError: null,
    refuse: null,
    refusals: [],
    respond: {},
    reads: {},
    turns: [],
    writes: [],
    summaryLoads: 0,
    panelLoads: 0,
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? 'GET';
      if (method !== 'GET') {
        api.writes.push({ method, path, body: opts?.body });
        const answer = api.respond[path];
        return settle(answer === undefined ? defaultAnswer(api, method, path, opts?.body) : answer(opts?.body), schema);
      }
      const read = api.reads[path];
      if (read !== undefined) return settle(read(), schema);
      if (path === `${BASE}/chat`) {
        api.summaryLoads += 1;
        if (api.chatError !== null) return Promise.reject(api.chatError);
        return settle(api.summary, schema);
      }
      if (path === '/api/me/profile') return settle(api.profile, schema);
      if (path === `${BASE}/agent`) {
        api.panelLoads += 1;
        if (api.panelError !== null) return Promise.reject(api.panelError);
        return settle(api.panel, schema);
      }
      if (path.startsWith(`${BASE}/chat/`)) {
        api.conversationReads.push(path);
        const node = /[?&]node=([^&]+)/.exec(path)?.[1];
        return settle((node === undefined ? undefined : api.versions[decodeURIComponent(node)]) ?? api.conversation, schema);
      }
      return Promise.reject(new ApiError('http', 'The request was refused.', { status: 404, code: 'not_found' }));
    },
    async request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      const method = opts?.method ?? 'GET';
      api.writes.push({ method, path, body: opts?.body });
      const answer = api.respond[path];
      const resolved: unknown = await (answer === undefined ? { ok: true, status: 204 } : answer(opts?.body));
      if (resolved instanceof ApiError) throw resolved;
      return resolved as Response;
    },
    stream(path: `/${string}`, opts: StreamOptions): Promise<void> {
      const refused = api.refusals.shift() ?? api.refuse;
      if (refused !== null) return Promise.reject(refused);
      return new Promise<void>((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => { reject(new ApiError('aborted', 'The request was stopped.')); });
        api.turns.push({
          path,
          body: opts.body,
          signal: opts.signal,
          emit: (event, data) => { opts.onEvent({ event, data: JSON.stringify(data) }); },
          end: () => { resolve(); },
          fail: (error) => { reject(error instanceof Error ? error : new Error('failed')); },
        });
      });
    },
    logout: () => Promise.resolve(),
  };
  return api;
}

export function refusal(status: number, code: string | null): ApiError {
  return new ApiError('http', 'The request was refused.', { status, code });
}
