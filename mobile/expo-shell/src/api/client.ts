import type { z } from 'zod';

import { errorBodySchema, nativeGrantSchema, PATHS } from '../auth/contract';
import type { TokenStore } from '../auth/tokens';

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'signed_out' | 'invalid_response' | 'storage';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    init?: { status?: number; code?: string | null; retryAfterSeconds?: number | null; cause?: unknown },
  ) {
    super(message, init?.cause === undefined ? undefined : { cause: init.cause });
    this.kind = kind;
    this.status = init?.status ?? 0;
    this.code = init?.code ?? null;
    this.retryAfterSeconds = init?.retryAfterSeconds ?? null;
  }
}

export type Session = { kind: 'cookie' } | { kind: 'bearer'; tokens: TokenStore };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
}

export interface ApiClient {
  request(path: `/${string}`, opts?: RequestOptions): Promise<Response>;
  json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T>;
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
  fetch?: FetchLike;
}): ApiClient {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
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

  async function send(url: string, opts: RequestOptions, accessToken: string | null, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
    if (deps.session.kind === 'bearer' && accessToken !== null) headers.set('Authorization', `Bearer ${accessToken}`);
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
      credentials: deps.session.kind === 'cookie' ? 'include' : 'omit',
      signal: controller.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError('timeout', 'The request timed out.', { cause: error });
      throw new ApiError('network', 'The network request failed.', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function toApiError(res: Response): Promise<ApiError> {
    if (res.status >= 500) return new ApiError('http', SERVER_ERROR, { status: res.status });
    let code: string | null = null;
    try {
      const parsed = errorBodySchema.safeParse(await res.json());
      if (parsed.success && parsed.data.error !== undefined) code = parsed.data.error;
    } catch {
      // Non-JSON bodies, including a WAF page, carry no machine code.
    }
    return new ApiError('http', 'The request was refused.', {
      status: res.status,
      code,
      retryAfterSeconds: res.status === 429 ? retryAfterSeconds(res) : null,
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

  async function request(path: `/${string}`, opts: RequestOptions = {}): Promise<Response> {
    const url = urlFor(path);
    if (opts.auth === false) return checked(await send(url, opts, null, REQUEST_TIMEOUT_MS));
    const session = deps.session;
    if (session.kind === 'bearer') {
      let sent = session.tokens.getAccess();
      if (sent === null) {
        if ((await refreshOnce()) === 'ended') throw signedOut();
        sent = session.tokens.getAccess();
      }
      let res = await send(url, opts, sent, REQUEST_TIMEOUT_MS);
      if (res.status === 401) {
        if (session.tokens.getAccess() === sent) {
          if ((await refreshOnce()) === 'ended') throw signedOut();
        }
        res = await send(url, opts, session.tokens.getAccess(), REQUEST_TIMEOUT_MS);
      }
      return checked(res);
    }
    let res = await send(url, opts, null, REQUEST_TIMEOUT_MS);
    if (res.status === 401) {
      if ((await refreshOnce()) === 'ended') throw signedOut();
      res = await send(url, opts, null, REQUEST_TIMEOUT_MS);
    }
    return checked(res);
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
    logout,
  };
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
