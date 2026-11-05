import type { SecureStoreLike } from '../../src/auth/tokens';
import type { InstallMarker } from '../../src/auth/tokens';
import type { Auth } from '../../src/auth/auth';
import type { AuthState } from '../../src/auth/store';
import { createAuthStore } from '../../src/auth/store';

const EMAIL = ['a', 'example.com'].join('@');

export function fakeSecureStore(opts?: {
  items?: Record<string, string>;
  failReads?: boolean;
  failWrites?: boolean;
  holdWrites?: boolean;
}): SecureStoreLike & {
  items: Map<string, string>;
  calls: { op: 'get' | 'set' | 'delete'; key: string; options: unknown }[];
  release(): void;
} {
  const items = new Map(Object.entries(opts?.items ?? {}));
  const calls: { op: 'get' | 'set' | 'delete'; key: string; options: unknown }[] = [];
  let hold = opts?.holdWrites === true;
  let waiters: (() => void)[] = [];
  return {
    items,
    calls,
    release() {
      hold = false;
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
    getItemAsync(key, options) {
      calls.push({ op: 'get', key, options });
      if (opts?.failReads === true) return Promise.reject(new Error('read failed'));
      return Promise.resolve(items.get(key) ?? null);
    },
    async setItemAsync(key, value, options) {
      calls.push({ op: 'set', key, options });
      if (opts?.failWrites === true) throw new Error('write failed');
      if (hold) await new Promise<void>((resolve) => { waiters.push(resolve); });
      items.set(key, value);
    },
    deleteItemAsync(key, options) {
      calls.push({ op: 'delete', key, options });
      if (opts?.failWrites === true) return Promise.reject(new Error('write failed'));
      items.delete(key);
      return Promise.resolve();
    },
  };
}

export function memoryMarker(exists: boolean, opts?: { failCreate?: boolean }): InstallMarker & { created: number } {
  let present = exists;
  const marker = {
    created: 0,
    exists: (): boolean => present,
    create(): void {
      if (opts?.failCreate === true) throw new Error('marker create failed');
      present = true;
      marker.created += 1;
    },
  };
  return marker;
}

export function requestText(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new Error('expected a string body');
  return body;
}

export function jsonResponse(status: number, body?: unknown, headers?: Readonly<Record<string, string>>): Response {
  const headerMap = new Map<string, string>();
  for (const [key, value] of Object.entries(headers ?? {})) headerMap.set(key.toLowerCase(), value);
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: () => body === undefined ? Promise.reject(new SyntaxError('unexpected end of json')) : Promise.resolve(body),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

export interface FakeEventStream {
  response: Response;
  /** Queues a chunk for the next read: text (encoded as UTF-8) or raw bytes. */
  push(chunk: string | Uint8Array): void;
  close(): void;
  /** The next read rejects, as a dropped connection does. */
  fail(error: unknown): void;
  readonly cancelled: boolean;
}

/** A 2xx `text/event-stream` response whose body the test feeds; reads wait until something is pushed. */
export function fakeEventStream(opts?: { contentType?: string }): FakeEventStream {
  const queue: Uint8Array[] = [];
  let waiter: { resolve: (result: ReadableStreamReadResult<Uint8Array>) => void; reject: (error: unknown) => void } | null = null;
  let closed = false;
  let cancelled = false;
  let failure: { error: unknown } | null = null;
  const encoder = new TextEncoder();

  function settle(): void {
    if (waiter === null) return;
    const pending = waiter;
    const next = queue.shift();
    if (next !== undefined) {
      waiter = null;
      pending.resolve({ done: false, value: next });
    } else if (failure !== null) {
      waiter = null;
      pending.reject(failure.error);
    } else if (closed || cancelled) {
      waiter = null;
      pending.resolve({ done: true, value: undefined });
    }
  }

  const reader = {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        settle();
      });
    },
    cancel(): Promise<void> {
      cancelled = true;
      settle();
      return Promise.resolve();
    },
    releaseLock(): void { return undefined; },
  };
  const headers = new Map([['content-type', opts?.contentType ?? 'text/event-stream; charset=utf-8']]);
  const response = {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: { getReader: () => reader, cancel: () => reader.cancel() },
    json: () => Promise.reject(new SyntaxError('not json')),
  } as unknown as Response;

  return {
    response,
    push(chunk) {
      queue.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      settle();
    },
    close() {
      closed = true;
      settle();
    },
    fail(error) {
      failure = { error };
      settle();
    },
    get cancelled() { return cancelled; },
  };
}

export function sseText(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function fakeFetch(
  handler: (call: { url: string; init: RequestInit }) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const recorded = { url, init: init ?? {} };
    calls.push(recorded);
    const signal = init?.signal;
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => { reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => handler(recorded))
        .then(resolve, reject)
        .finally(() => { signal?.removeEventListener('abort', onAbort); });
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export function fakeAuth(state: AuthState, overrides?: Partial<Auth>): Auth {
  const store = createAuthStore(state);
  const base: Auth = {
    store,
    config: { apiUrl: 'https://api.example.com', webUrl: 'https://app.example.com', google: null },
    api: {
      request: () => Promise.reject(new Error('stub')),
      json: <T,>() => Promise.reject<T>(new Error('stub')),
      stream: () => Promise.reject(new Error('stub')),
      logout: () => Promise.reject(new Error('stub')),
    },
    restore: () => Promise.resolve(),
    signInWithGoogle: () => Promise.resolve(),
    requestMagicLink: () => Promise.resolve(),
    redeemMagicLink: () => Promise.resolve(),
    verifyMfa: () => Promise.resolve(),
    cancelMfa: () => { store.set({ status: 'signedOut' }); },
    loadMe: () => Promise.resolve({
      user: { id: 'u1', email: EMAIL },
      totp: { enabled: false, recoveryCodesRemaining: 0 },
    }),
    beginTotpEnrollment: () => Promise.resolve({
      secret: 'S',
      otpauthUri: 'otpauth://totp/x',
      expiresAt: '2026-01-01T00:00:00Z',
      qrPngDataUrl: 'data:image/png;base64,AAAA',
    }),
    confirmTotpEnrollment: () => Promise.resolve({
      recoveryCodes: Array.from({ length: 10 }, (_, index) => String(index).padStart(20, '0')),
    }),
    signOut: () => Promise.resolve(),
  };
  return { ...base, ...overrides, store: overrides?.store ?? store };
}
