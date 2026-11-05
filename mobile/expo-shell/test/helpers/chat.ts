import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions, type StreamOptions } from '../../src/api/client';

// A fake ApiClient for the tuning chat: GETs answer from mutable fixtures, and each turn is a stream the
// test drives event by event. Aborting a turn's signal rejects it as the real client does.

export const PROPOSAL = {
  kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', weekdays: null, effect: 'closed',
  expectedGuests: null, detail: 'Closed for the holidays.',
} as const;

export const SUMMARY = {
  enabled: true,
  budget: { month: '2026-11', usedUsd: 1.25, limitUsd: 20, exhausted: false },
  conversations: [{ id: 'c1', title: 'Earlier chat', updatedAt: '2026-11-02T15:00:00.000Z', turnCount: 2 }],
};

export const ORG = {
  org: { id: 'o1', name: 'Test Group' },
  role: 'member',
  locations: [
    { id: 'l1', name: 'Main Street Bar', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } },
    { id: 'l2', name: 'River Grill', town: { townId: null, name: 'Norwich', state: 'VT' } },
  ],
  requestedLocationCount: null,
};

export const CONVERSATION = {
  id: 'c1',
  title: 'Earlier chat',
  updatedAt: '2026-11-02T15:00:00.000Z',
  messages: [
    { role: 'user', text: 'We close for the holidays.', proposals: [], at: '2026-11-02T14:59:00.000Z' },
    { role: 'assistant', text: 'Here is a note for that.', proposals: [PROPOSAL], at: '2026-11-02T15:00:00.000Z' },
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

export interface FakeChatApi extends ApiClient {
  summary: unknown;
  /** The body of GET /api/org, or the error it answers with. */
  org: unknown;
  conversation: unknown;
  /** Thrown by GET .../chat when set. */
  chatError: ApiError | null;
  /** Rejects the next turns before any event, as a refused POST does. */
  refuse: ApiError | null;
  /** The result of POST .../notes. */
  noteResult: () => Promise<Response>;
  turns: LiveTurn[];
  requests: { path: string; opts: RequestOptions | undefined }[];
  summaryLoads: number;
}

export function fakeChatApi(): FakeChatApi {
  const api: FakeChatApi = {
    summary: SUMMARY,
    org: ORG,
    conversation: CONVERSATION,
    chatError: null,
    refuse: null,
    noteResult: () => Promise.resolve({ ok: true, status: 201 } as Response),
    turns: [],
    requests: [],
    summaryLoads: 0,
    json<T>(path: `/${string}`, schema: z.ZodType<T>): Promise<T> {
      if (path === '/api/org') return api.org instanceof ApiError ? Promise.reject(api.org) : Promise.resolve(schema.parse(api.org));
      if (path === '/api/org/locations/l1/chat') {
        api.summaryLoads += 1;
        if (api.chatError !== null) return Promise.reject(api.chatError);
        return Promise.resolve(schema.parse(api.summary));
      }
      if (path.startsWith('/api/org/locations/l1/chat/')) return Promise.resolve(schema.parse(api.conversation));
      return Promise.reject(new ApiError('http', 'The request was refused.', { status: 404, code: 'not_found' }));
    },
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      api.requests.push({ path, opts });
      return api.noteResult();
    },
    stream(path: `/${string}`, opts: StreamOptions): Promise<void> {
      if (api.refuse !== null) return Promise.reject(api.refuse);
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
