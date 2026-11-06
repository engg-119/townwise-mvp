import type { z } from 'zod';

import { errorBodySchema, nativeGrantSchema, PATHS } from '../auth/contract';
import type { TokenStore } from '../auth/tokens';
import { createSseParser, type SseEvent } from './sse';
import { streamFetch } from './streamFetch';

/** `aborted`: the caller's signal stopped a stream (Stop), never a timeout. */
export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'signed_out' | 'invalid_response' | 'storage' | 'aborted';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  /** A 4xx body's other fields (`{ maxBytes }`, `{ fileId }`); never the message, never from a 5xx. */
  readonly detail: Readonly<Record<string, unknown>> | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    init?: {
      status?: number; code?: string | null; retryAfterSeconds?: number | null; detail?: Record<string, unknown> | null; cause?: unknown;
    },
  ) {
    super(message, init?.cause === undefined ? undefined : { cause: init.cause });
    this.kind = kind;
    this.status = init?.status ?? 0;
    this.code = init?.code ?? null;
    this.retryAfterSeconds = init?.retryAfterSeconds ?? null;
    this.detail = init?.detail ?? null;
  }
}

export type Session = { kind: 'cookie' } | { kind: 'bearer'; tokens: TokenStore };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  /** Stops the request: before the headers, or a body still being read. Ends as ApiError kind `aborted`. */
  signal?: AbortSignal;
  /** The timeout until the headers arrive (until the whole answer, for an upload); 30 s by default. */
  timeoutMs?: number;
  /**
   * A raw body sent as `application/octet-stream` instead of `body`, through XMLHttpRequest so the bytes sent can
   * be reported. Web only (D20): a bearer (native) session answers ApiError code `unsupported` without a request.
   */
  upload?: { body: Blob; onProgress?: (loaded: number) => void };
}

export interface StreamOptions {
  body?: unknown;
  /** Stop: aborts the request before the headers arrive, or the read after them. */
  signal?: AbortSignal;
  onEvent: (event: SseEvent) => void;
}

export interface ApiClient {
  request(path: `/${string}`, opts?: RequestOptions): Promise<Response>;
  json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T>;
  /**
   * POSTs and reads a `text/event-stream` reply, calling `onEvent` for each event; resolves when the stream ends.
   * Auth, the shared refresh and the error mapping are the same as `request`. A 401 is refreshed and retried only
   * before the stream starts. The request timeout runs until the headers arrive; the read has none.
   */
  stream(path: `/${string}`, opts: StreamOptions): Promise<void>;
  logout(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 15_000;
const SIGNOUT_TIMEOUT_MS = 10_000;
const SERVER_ERROR = 'The server could not complete the request.';

/** A refresh ends the session only for 401 session_ended. Every other response keeps it. */
export function endsSession(status: number, code: string | null): boolean {
  return status === 401 && code === 'session_ended';
}

export function platformOf(session: Session): 'web' | 'native' {
  return session.kind === 'cookie' ? 'web' : 'native';
}

type FetchLike = typeof globalThis.fetch;

export function createApiClient(deps: {
  baseUrl: string;
  session: Session;
  onSessionEnded: () => void;
  /** Replaces both transports (JSON and streams); tests pass one fake. */
  fetch?: FetchLike;
  /** Replaces XMLHttpRequest for uploads; tests pass a fake. */
  xhr?: () => XhrLike;
}): ApiClient {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // expo/fetch on native, the browser's fetch on web (src/api/streamFetch).
  const streamImpl: (url: string, init: RequestInit) => Promise<Response> = deps.fetch ?? streamFetch;
  const makeXhr: () => XhrLike = deps.xhr ?? (() => new XMLHttpRequest());
  const base = new URL(deps.baseUrl);
  const prefix = base.pathname === '/' ? '/' : `${base.pathname}/`;
  let inflight: Promise<'refreshed' | 'ended'> | null = null;

  function urlFor(path: `/${string}`): string {
    const url = new URL(deps.baseUrl + path);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw new Error(`path leaves apiUrl: ${path}`);
    return url.href;
  }

  function signedOut(): ApiError {
    return new ApiError('signed_out', 'Your session ended.');
  }

  function stopped(cause?: unknown): ApiError {
    return new ApiError('aborted', 'The request was stopped.', cause === undefined ? undefined : { cause });
  }

  /**
   * `stream` set: the request asks for an event stream and goes through the stream transport, and the caller's
   * signal stays wired to it after the headers arrive, so Stop also ends the read. The timer stops at the headers.
   */
  async function send(
    url: string, opts: RequestOptions, accessToken: string | null, timeoutMs: number, stream?: { signal: AbortSignal | undefined },
  ): Promise<Response> {
    const outer = stream?.signal ?? opts.signal;
    if (aborted(outer)) throw stopped();
    if (opts.upload !== undefined && deps.session.kind !== 'cookie') {
      throw new ApiError('http', 'Uploads work in a web browser.', { code: 'unsupported' });
    }
    const controller = new AbortController();
    const relay = (): void => { controller.abort(); };
    outer?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => { controller.abort(); }, opts.timeoutMs ?? timeoutMs);
    const headers = new Headers();
    headers.set('Accept', stream === undefined ? 'application/json' : 'text/event-stream');
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
    if (opts.upload !== undefined) headers.set('Content-Type', 'application/octet-stream');
    if (deps.session.kind === 'bearer' && accessToken !== null) headers.set('Authorization', `Bearer ${accessToken}`);
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
      credentials: deps.session.kind === 'cookie' ? 'include' : 'omit',
      signal: controller.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    try {
      if (opts.upload !== undefined) return await xhrSend(makeXhr, url, init, controller.signal, opts.upload);
      return await (stream === undefined ? fetchImpl : streamImpl)(url, init);
    } catch (error) {
      outer?.removeEventListener('abort', relay);
      if (aborted(outer)) throw stopped(error);
      if (controller.signal.aborted) throw new ApiError('timeout', 'The request timed out.', { cause: error });
      throw new ApiError('network', 'The network request failed.', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The machine code is read from every error body, a 5xx's included (503 `uploads_busy` and `files_unavailable`
   * need different handling). A 5xx keeps the generic message and nothing else from its body.
   */
  async function toApiError(res: Response): Promise<ApiError> {
    let code: string | null = null;
    let detail: Record<string, unknown> | null = null;
    try {
      const body: unknown = await res.json();
      const parsed = errorBodySchema.safeParse(body);
      if (parsed.success && parsed.data.error !== undefined) code = parsed.data.error;
      if (res.status < 500 && typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const rest = Object.entries(body).filter(([key]) => key !== 'error' && key !== 'message' && key !== 'retryAfterSeconds');
        if (rest.length > 0) detail = Object.fromEntries(rest);
      }
    } catch {
      // Non-JSON bodies, including a WAF page, carry no machine code.
    }
    return new ApiError('http', res.status >= 500 ? SERVER_ERROR : 'The request was refused.', {
      status: res.status,
      code,
      retryAfterSeconds: res.status === 429 || res.status === 503 ? retryAfterSeconds(res) : null,
      detail,
    });
  }

  async function parseBody<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    let data: unknown;
    try {
      data = await res.json();
    } catch (error) {
      throw new ApiError('invalid_response', 'The server response was not valid.', { cause: error });
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new ApiError('invalid_response', 'The server response was not valid.');
    return parsed.data;
  }

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const locks = readLocks();
    return deps.session.kind === 'cookie' && locks !== undefined ? locks.request('kit-auth-refresh', fn) : fn();
  };

  async function end(): Promise<'ended'> {
    if (deps.session.kind === 'bearer') await deps.session.tokens.clear();
    deps.onSessionEnded();
    return 'ended';
  }

  async function doRefresh(): Promise<'refreshed' | 'ended'> {
    let body: unknown = { platform: 'web' };
    let generation = 0;
    if (deps.session.kind === 'bearer') {
      generation = deps.session.tokens.generation();
      const refreshToken = await deps.session.tokens.getRefresh();
      if (refreshToken === null) return end();
      body = { platform: 'native', refreshToken };
    }
    const res = await send(urlFor(PATHS.refresh), { method: 'POST', body }, null, REFRESH_TIMEOUT_MS);
    if (res.ok) {
      if (deps.session.kind === 'bearer') {
        const grant = await parseBody(res, nativeGrantSchema);
        if (!(await deps.session.tokens.save(grant, generation))) return 'ended';
      }
      return 'refreshed';
    }
    const err = await toApiError(res);
    if (endsSession(res.status, err.code)) return end();
    throw err;
  }

  function refreshOnce(): Promise<'refreshed' | 'ended'> {
    inflight ??= serialize(doRefresh).finally(() => { inflight = null; });
    return inflight;
  }

  /** One send with the session's credentials; a 401 refreshes once and sends again. Never reads a 2xx body. */
  async function authorized(url: string, opts: RequestOptions, stream?: { signal: AbortSignal | undefined }): Promise<Response> {
    if (opts.auth === false) return send(url, opts, null, REQUEST_TIMEOUT_MS, stream);
    const session = deps.session;
    if (session.kind === 'bearer') {
      let sent = session.tokens.getAccess();
      if (sent === null) {
        if ((await refreshOnce()) === 'ended') throw signedOut();
        sent = session.tokens.getAccess();
      }
      let res = await send(url, opts, sent, REQUEST_TIMEOUT_MS, stream);
      if (res.status === 401) {
        if (session.tokens.getAccess() === sent) {
          if ((await refreshOnce()) === 'ended') throw signedOut();
        }
        res = await send(url, opts, session.tokens.getAccess(), REQUEST_TIMEOUT_MS, stream);
      }
      return res;
    }
    let res = await send(url, opts, null, REQUEST_TIMEOUT_MS, stream);
    if (res.status === 401) {
      if ((await refreshOnce()) === 'ended') throw signedOut();
      res = await send(url, opts, null, REQUEST_TIMEOUT_MS, stream);
    }
    return res;
  }

  async function request(path: `/${string}`, opts: RequestOptions = {}): Promise<Response> {
    return checked(await authorized(urlFor(path), opts));
  }

  async function stream(path: `/${string}`, opts: StreamOptions): Promise<void> {
    const { signal } = opts;
    const res = await checked(await authorized(urlFor(path), { method: 'POST', body: opts.body }, { signal }));
    const body = res.body;
    if (body === null || !(res.headers.get('Content-Type') ?? '').startsWith('text/event-stream')) {
      void body?.cancel().catch(() => undefined);
      throw new ApiError('invalid_response', 'The server response was not valid.');
    }
    const reader = body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    if (aborted(signal)) {
      cancel();
      throw stopped();
    }
    signal?.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder();
    const parser = createSseParser();
    let finished = false;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (aborted(signal)) throw stopped(error);
          throw new ApiError('network', 'The connection closed before the reply finished.', { cause: error });
        }
        // A cancel on Stop ends the read as done.
        if (aborted(signal)) throw stopped();
        if (chunk.done) break;
        for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) opts.onEvent(event);
      }
      finished = true;
      for (const event of [...parser.push(decoder.decode()), ...parser.end()]) opts.onEvent(event);
    } finally {
      signal?.removeEventListener('abort', cancel);
      // Any early exit, including a throwing onEvent, closes the connection rather than leaving it open.
      if (!finished) cancel();
    }
  }

  async function checked(res: Response): Promise<Response> {
    if (res.ok) return res;
    throw await toApiError(res);
  }

  async function logout(): Promise<void> {
    if (deps.session.kind === 'cookie') {
      const res = await serialize(() => send(urlFor(PATHS.logout), { method: 'POST', body: { platform: 'web' } }, null, SIGNOUT_TIMEOUT_MS));
      if (!res.ok) throw await toApiError(res);
      return;
    }
    const { tokens } = deps.session;
    const refreshToken = await tokens.getRefresh().catch(() => null);
    const access = tokens.getAccess();
    await tokens.clear();
    const body = refreshToken === null ? { platform: 'native' } : { platform: 'native', refreshToken };
    void send(urlFor(PATHS.logout), { method: 'POST', body }, access, SIGNOUT_TIMEOUT_MS).catch(() => undefined);
  }

  return {
    request,
    async json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      return parseBody(await request(path, opts), schema);
    },
    stream,
    logout,
  };
}

/** The parts of XMLHttpRequest an upload uses. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  withCredentials: boolean;
  readonly upload: { addEventListener(type: 'progress', listener: (event: { loaded: number }) => void): void };
  addEventListener(type: 'load' | 'error' | 'abort', listener: () => void): void;
  readonly status: number;
  readonly responseText: string;
  getAllResponseHeaders(): string;
  send(body: Blob): void;
  abort(): void;
}

/**
 * An XMLHttpRequest's answer as the parts of a fetch Response the client reads (`ok`, `status`, `headers`,
 * `json`, `text`), built by hand: an upload answer is a small JSON body, and not every runtime has `Response`.
 */
function responseOf(xhr: XhrLike): Response {
  const text = xhr.responseText;
  const answer = {
    ok: xhr.status >= 200 && xhr.status < 300,
    status: xhr.status,
    headers: headersOf(xhr),
    text: () => Promise.resolve(text),
    json: (): Promise<unknown> => {
      try {
        return Promise.resolve(JSON.parse(text) as unknown);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('invalid json'));
      }
    },
  };
  return answer as unknown as Response;
}

/** One upload through XMLHttpRequest, answered as a Response so the same error mapping applies. */
function xhrSend(
  make: () => XhrLike, url: string, init: RequestInit, signal: AbortSignal, upload: NonNullable<RequestOptions['upload']>,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const xhr = make();
    const onAbort = (): void => { xhr.abort(); };
    const done = (): void => { signal.removeEventListener('abort', onAbort); };
    xhr.open(init.method ?? 'PUT', url);
    new Headers(init.headers).forEach((value, name) => { xhr.setRequestHeader(name, value); });
    xhr.withCredentials = init.credentials === 'include';
    const { onProgress } = upload;
    if (onProgress !== undefined) xhr.upload.addEventListener('progress', (event) => { onProgress(event.loaded); });
    xhr.addEventListener('load', () => {
      done();
      if (xhr.status < 200 || xhr.status > 599) {
        reject(new Error('no status'));
        return;
      }
      resolve(responseOf(xhr));
    });
    xhr.addEventListener('error', () => { done(); reject(new Error('network')); });
    xhr.addEventListener('abort', () => { done(); reject(new Error('aborted')); });
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.send(upload.body);
  });
}

function headersOf(xhr: XhrLike): Headers {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

/**
 * PUTs a raw body (an upload chunk) with progress: `onProgress` gets the bytes sent so far, from 0 again if a 401
 * resends it. The timeout covers the whole request, 200 s by default (under the API ingress's 240 s).
 */
export function upload(
  api: ApiClient, path: `/${string}`, body: Blob, opts: { signal?: AbortSignal; onProgress?: (loaded: number) => void; timeoutMs?: number } = {},
): Promise<Response> {
  const request: RequestOptions = {
    method: 'PUT',
    upload: opts.onProgress === undefined ? { body } : { body, onProgress: opts.onProgress },
    timeoutMs: opts.timeoutMs ?? 200_000,
  };
  if (opts.signal !== undefined) request.signal = opts.signal;
  return api.request(path, request);
}

/** GETs a file as a Blob. The 30 s timeout runs until the headers arrive; the signal can stop the read after them. */
export async function download(api: ApiClient, path: `/${string}`, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  const res = await api.request(path, opts.signal === undefined ? {} : { signal: opts.signal });
  try {
    return await res.blob();
  } catch (error) {
    if (aborted(opts.signal)) throw new ApiError('aborted', 'The request was stopped.', { cause: error });
    throw new ApiError('network', 'The download stopped before it finished.', { cause: error });
  }
}

// A function, not an inline check: TypeScript would keep `signal.aborted` narrowed to false across awaits.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function readLocks(): { request: <T>(name: string, fn: () => Promise<T>) => Promise<T> } | undefined {
  const nav = globalThis.navigator as { locks?: { request: <T>(name: string, fn: () => Promise<T>) => Promise<T> } } | undefined;
  return nav?.locks;
}
