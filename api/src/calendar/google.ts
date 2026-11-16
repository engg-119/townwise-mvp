// Google's token, calendar list and events endpoints, as a port (openspec change connect-google-calendar: the
// google-calendar spec, design decisions 3, 5 and 7), shaped like places/google.ts. main.ts builds the client when
// Google calendars are on; tests build it over a fake fetch. The hosts are the constants below and nothing configures
// them, so no caller can point a token at another host, and the guarded fetcher (calendar/fetch.ts) is not needed.
// What is sent: an authorization code, a refresh token or an access token, the OAuth client's id and secret (token
// calls only), a calendar id in a path through encodeURIComponent, the events window and time zone, and fixed fields.
// A revoke (revokeGoogleGrant) sends the token alone, in a form body, never in a URL. Every call has 10 seconds,
// refuses redirects, reads at most 2 MB, and can be ended by a caller's signal.
// What leaves the file: the return values, and on failure a GoogleCalendarError carrying a code from a fixed list and
// Google's HTTP status, never Google's message, `error_description` or body. Google's 401 is read here to pick a code;
// no Townwise answer is ever 401 because of it. Nothing here logs.
import { z } from 'zod';

const GOOGLE_OAUTH = 'https://oauth2.googleapis.com';
const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3';
/** Each call to Google, from the request to the last byte of the answer. */
export const GOOGLE_TIMEOUT_MS = 10_000;
/** An answer over this many bytes is not read further. */
export const MAX_GOOGLE_BYTES = 2 * 1024 * 1024;
/** The code model's popup exchange (design decision 3); the runbook check confirms Google accepts it. */
export const POPUP_REDIRECT_URI = 'postmessage';
/** The two calendar scopes connecting asks for, beside `openid` (design decision 2). */
export const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
/** The calendar list's first page only. [CONFIRM: the picker lists a person's first 250 Google calendars] */
const CALENDAR_LIST_MAX = 250;
const CALENDAR_LIST_FIELDS = 'nextPageToken,items(id,summary,summaryOverride,primary,accessRole)';
const CALENDAR_FIELDS = 'id,summary,summaryOverride,primary,accessRole';
/** Only an event's id, status, title, start and end: never its description, location, attendees or organizer. */
const EVENTS_FIELDS = 'nextPageToken,items(id,status,summary,start,end)';
const EVENTS_PAGE_SIZE = 500;
/** An ID token from the token endpoint names Google as its issuer in one of these forms. */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Clock skew allowed on an ID token's `exp`. */
const EXP_TOLERANCE_MS = 5_000;
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
/** The Calendar API not enabled in the project: a setup fault, not a refusal of one calendar. */
const API_DISABLED_REASONS: ReadonlySet<string> = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);

/**
 * `invalid_grant`: the code or refresh token is refused (used, expired or revoked). `invalid_client`: the client id or
 * secret is refused. `unauthorized`: an access token refused (401). `rate_limited`: a 429, or a 403 for a usage limit.
 * `forbidden`: any other 403. `api_disabled`: the Calendar API is not enabled. `not_found`: a 404 or 410.
 * `unavailable`: a 5xx or any other status, a network failure, a timeout, an aborted call, or an answer over 2 MB.
 * `bad_response`: a 2xx that is not the expected JSON, or an ID token whose claims fail.
 */
export const GOOGLE_FAILURES = [
  'invalid_grant', 'invalid_client', 'unauthorized', 'rate_limited', 'forbidden', 'api_disabled', 'not_found', 'unavailable',
  'bad_response',
] as const;
export type GoogleFailure = typeof GOOGLE_FAILURES[number];

export class GoogleCalendarError extends Error {
  readonly code: GoogleFailure;
  /** Google's HTTP status, or null when no answer was read. */
  readonly status: number | null;

  constructor(code: GoogleFailure, status: number | null = null) {
    super(`Google Calendar call failed: ${code}`);
    this.name = 'GoogleCalendarError';
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleCallOptions {
  /** Ends the call at once when it aborts (the refresh loop's close). */
  readonly signal?: AbortSignal | undefined;
}

/** The token endpoint's answer to a code: the ID token's `sub`, checked, is its subject. */
export interface GoogleCodeExchange {
  readonly accessToken: string;
  /** Google returns one only on a grant's first authorization. */
  readonly refreshToken: string | null;
  /** The scopes granted, which may be fewer than asked for. */
  readonly scopes: readonly string[];
  readonly subject: string;
}

export interface GoogleAccess {
  readonly accessToken: string;
  /** A new refresh token, when Google sends one; it replaces the stored one. */
  readonly refreshToken: string | null;
}

/** A calendar in the person's calendar list. `name` is `summaryOverride ?? summary`. */
export interface GoogleCalendarEntry {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
  /** `freeBusyReader`, `reader`, `writer` or `owner`. */
  readonly accessRole: string;
}

export interface GoogleEventTime {
  /** An all-day event's date, its end exclusive. */
  readonly date: string | null;
  /** A timed event's instant, RFC 3339. */
  readonly dateTime: string | null;
}

export interface GoogleEventItem {
  readonly id: string;
  readonly status: string | null;
  readonly summary: string | null;
  readonly start: GoogleEventTime | null;
  readonly end: GoogleEventTime | null;
}

/** One events window: `timeMin` bounds an event's end, `timeMax` its start (both exclusive, Google's rule). */
export interface GoogleEventsQuery {
  readonly timeMin: string;
  readonly timeMax: string;
  readonly timeZone: string;
  readonly pageToken: string | null;
}

export interface GoogleEventsPage {
  readonly items: readonly GoogleEventItem[];
  readonly nextPageToken: string | null;
}

export interface GoogleCalendarClient {
  /** Exchanges a popup code (POPUP_REDIRECT_URI) and checks the ID token's claims. */
  exchangeCode(code: string, opts?: GoogleCallOptions): Promise<GoogleCodeExchange>;
  /** An access token for one use. */
  refreshAccess(refreshToken: string, opts?: GoogleCallOptions): Promise<GoogleAccess>;
  /** The calendars the person can read (`minAccessRole=reader`), the first 250 in Google's order. */
  listCalendars(accessToken: string, opts?: GoogleCallOptions): Promise<GoogleCalendarEntry[]>;
  /** One calendar of the person's list; `primary` is allowed, and the answer carries Google's real id. */
  getCalendar(accessToken: string, calendarId: string, opts?: GoogleCallOptions): Promise<GoogleCalendarEntry>;
  /** One page of a calendar's single events in a window, with the fixed minimal fields. */
  listEvents(accessToken: string, calendarId: string, query: GoogleEventsQuery, opts?: GoogleCallOptions): Promise<GoogleEventsPage>;
}

export interface GoogleCalendarClientDeps {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Absent, the global fetch. Tests pass a fake. */
  readonly fetch?: FetchLike;
  /** Absent, GOOGLE_TIMEOUT_MS; tests shorten it. */
  readonly timeoutMs?: number;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
const tokenErrorSchema = z.object({ error: z.string() });
const claimsSchema = z.object({ iss: z.string(), aud: z.string(), exp: z.number(), sub: z.string().min(1) });
const calendarSchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  summaryOverride: z.string().optional(),
  primary: z.boolean().optional(),
  accessRole: z.string().optional(),
});
const calendarListSchema = z.object({ items: z.array(z.unknown()).optional() });
const eventTimeSchema = z.object({ date: z.string().optional(), dateTime: z.string().optional() });
const eventSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  start: eventTimeSchema.optional(),
  end: eventTimeSchema.optional(),
});
const eventsSchema = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().min(1).optional() });
const calendarErrorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

interface Answer {
  readonly status: number;
  /** The parsed JSON, or undefined for an empty or non-JSON body. */
  readonly json: unknown;
}

/** The body as text, at most MAX_GOOGLE_BYTES; a larger one is not read further and fails `unavailable`. */
async function textOf(res: Response): Promise<string> {
  const tooLarge = new GoogleCalendarError('unavailable', res.status);
  if (Number(res.headers.get('content-length')) > MAX_GOOGLE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge;
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_GOOGLE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One request, with the timeout and the caller's signal. Any failure before an answer is read is `unavailable`. */
async function send(fetchFn: FetchLike, timeoutMs: number, url: string, init: RequestInit, opts: GoogleCallOptions | undefined): Promise<Answer> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(opts?.signal === undefined ? [] : [opts.signal])];
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  } catch {
    throw new GoogleCalendarError('unavailable');
  }
  let text: string;
  try {
    text = await textOf(res);
  } catch (err) {
    throw err instanceof GoogleCalendarError ? err : new GoogleCalendarError('unavailable', res.status);
  }
  let json: unknown;
  try {
    json = text === '' ? undefined : JSON.parse(text) as unknown;
  } catch {
    // A parse error's message quotes the body, so it never travels on.
    json = undefined;
  }
  return { status: res.status, json };
}

function isOk(answer: Answer): boolean {
  return answer.status >= 200 && answer.status <= 299;
}

/** A token or revoke endpoint's refusal, by its `error` only. */
function tokenFailure(answer: Answer): GoogleCalendarError {
  const error = tokenErrorSchema.safeParse(answer.json).data?.error;
  if (error === 'invalid_grant') return new GoogleCalendarError('invalid_grant', answer.status);
  if (error === 'invalid_client') return new GoogleCalendarError('invalid_client', answer.status);
  if (answer.status === 429) return new GoogleCalendarError('rate_limited', answer.status);
  return new GoogleCalendarError('unavailable', answer.status);
}

/** The reasons in a Calendar API error, legacy (`error.errors[].reason`) and current (`error.details[].reason`). */
function reasonsOf(json: unknown): string[] {
  const parsed = calendarErrorSchema.safeParse(json);
  if (!parsed.success) return [];
  return [...(parsed.data.error.errors ?? []), ...(parsed.data.error.details ?? [])].flatMap((each) => (each.reason === undefined ? [] : [each.reason]));
}

/** A Calendar API refusal. A 403 is read by its reason, never its domain alone (decision 7). */
function calendarFailure(answer: Answer): GoogleCalendarError {
  const { status } = answer;
  if (status === 401) return new GoogleCalendarError('unauthorized', status);
  if (status === 429) return new GoogleCalendarError('rate_limited', status);
  if (status === 403) {
    const reasons = reasonsOf(answer.json);
    if (reasons.some((reason) => API_DISABLED_REASONS.has(reason))) return new GoogleCalendarError('api_disabled', status);
    if (reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))) return new GoogleCalendarError('rate_limited', status);
    return new GoogleCalendarError('forbidden', status);
  }
  if (status === 404 || status === 410) return new GoogleCalendarError('not_found', status);
  return new GoogleCalendarError('unavailable', status);
}

/**
 * The ID token's subject. It comes straight from the token endpoint over TLS, so its claims are checked without its
 * signature (OpenID Connect Core 1.0, 3.1.3.7, item 6): Google's issuer, this client as the audience, not expired
 * (5 seconds of tolerance), and a subject. Anything else is `bad_response`.
 */
function subjectOf(idToken: string | undefined, clientId: string, status: number): string {
  const bad = new GoogleCalendarError('bad_response', status);
  const [, payload, , ...rest] = (idToken ?? '').split('.');
  if (payload === undefined || rest.length > 0) throw bad;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw bad;
  }
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) throw bad;
  const { iss, aud, exp, sub } = parsed.data;
  if (!GOOGLE_ISSUERS.has(iss) || aud !== clientId || exp * 1000 + EXP_TOLERANCE_MS <= Date.now()) throw bad;
  return sub;
}

function entryOf(raw: z.infer<typeof calendarSchema>): GoogleCalendarEntry {
  return { id: raw.id, name: raw.summaryOverride ?? raw.summary ?? '', primary: raw.primary === true, accessRole: raw.accessRole ?? '' };
}

function timeOf(raw: z.infer<typeof eventTimeSchema> | undefined): GoogleEventTime | null {
  return raw === undefined ? null : { date: raw.date ?? null, dateTime: raw.dateTime ?? null };
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } as const;

export function createGoogleCalendarClient(deps: GoogleCalendarClientDeps): GoogleCalendarClient {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? GOOGLE_TIMEOUT_MS;

  const token = async (form: Record<string, string>, opts: GoogleCallOptions | undefined): Promise<{ answer: Answer; body: z.infer<typeof tokenSchema> }> => {
    const answer = await send(fetchFn, timeoutMs, `${GOOGLE_OAUTH}/token`, {
      method: 'POST', headers: FORM, body: new URLSearchParams(form).toString(),
    }, opts);
    if (!isOk(answer)) throw tokenFailure(answer);
    const parsed = tokenSchema.safeParse(answer.json);
    if (!parsed.success) throw new GoogleCalendarError('bad_response', answer.status);
    return { answer, body: parsed.data };
  };

  const read = async (url: string, accessToken: string, opts: GoogleCallOptions | undefined): Promise<Answer> => {
    const answer = await send(fetchFn, timeoutMs, url, {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, opts);
    if (!isOk(answer)) throw calendarFailure(answer);
    return answer;
  };

  return {
    async exchangeCode(code, opts) {
      const { answer, body } = await token({
        code, client_id: deps.clientId, client_secret: deps.clientSecret, redirect_uri: POPUP_REDIRECT_URI, grant_type: 'authorization_code',
      }, opts);
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        scopes: (body.scope ?? '').split(/\s+/).filter((scope) => scope !== ''),
        subject: subjectOf(body.id_token, deps.clientId, answer.status),
      };
    },

    async refreshAccess(refreshToken, opts) {
      const { body } = await token({
        client_id: deps.clientId, client_secret: deps.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
      }, opts);
      return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null };
    },

    async listCalendars(accessToken, opts) {
      const query = new URLSearchParams({ minAccessRole: 'reader', maxResults: String(CALENDAR_LIST_MAX), fields: CALENDAR_LIST_FIELDS });
      const answer = await read(`${GOOGLE_CALENDAR}/users/me/calendarList?${query.toString()}`, accessToken, opts);
      const parsed = calendarListSchema.safeParse(answer.json);
      if (!parsed.success) throw new GoogleCalendarError('bad_response', answer.status);
      return (parsed.data.items ?? []).flatMap((item) => {
        const entry = calendarSchema.safeParse(item);
        return entry.success ? [entryOf(entry.data)] : [];
      });
    },

    async getCalendar(accessToken, calendarId, opts) {
      const query = new URLSearchParams({ fields: CALENDAR_FIELDS });
      const answer = await read(`${GOOGLE_CALENDAR}/users/me/calendarList/${encodeURIComponent(calendarId)}?${query.toString()}`, accessToken, opts);
      const parsed = calendarSchema.safeParse(answer.json);
      if (!parsed.success) throw new GoogleCalendarError('bad_response', answer.status);
      return entryOf(parsed.data);
    },

    async listEvents(accessToken, calendarId, range, opts) {
      const query = new URLSearchParams({
        singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', eventTypes: 'default', timeMin: range.timeMin,
        timeMax: range.timeMax, timeZone: range.timeZone, maxResults: String(EVENTS_PAGE_SIZE), fields: EVENTS_FIELDS,
      });
      if (range.pageToken !== null) query.set('pageToken', range.pageToken);
      const answer = await read(`${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`, accessToken, opts);
      const parsed = eventsSchema.safeParse(answer.json);
      if (!parsed.success) throw new GoogleCalendarError('bad_response', answer.status);
      const items = (parsed.data.items ?? []).flatMap((item): GoogleEventItem[] => {
        const event = eventSchema.safeParse(item);
        if (!event.success) return [];
        const { id, status, summary, start, end } = event.data;
        return [{ id, status: status ?? null, summary: summary ?? null, start: timeOf(start), end: timeOf(end) }];
      });
      return { items, nextPageToken: parsed.data.nextPageToken ?? null };
    },
  };
}

/**
 * Revokes the grant behind a refresh token at Google, which ends every scope the account gave the project. It needs no
 * client id or secret, so it works with Google calendars switched off. The token goes only in the form body. A 200,
 * and a 400 `invalid_token` (already revoked), both count as done; anything else throws GoogleCalendarError.
 */
export async function revokeGoogleGrant(token: string, opts: { readonly fetch?: FetchLike; readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number } = {}): Promise<void> {
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const answer = await send(fetchFn, opts.timeoutMs ?? GOOGLE_TIMEOUT_MS, `${GOOGLE_OAUTH}/revoke`, {
    method: 'POST', headers: FORM, body: new URLSearchParams({ token }).toString(),
  }, { signal: opts.signal });
  if (isOk(answer)) return;
  if (answer.status === 400 && tokenErrorSchema.safeParse(answer.json).data?.error === 'invalid_token') return;
  throw tokenFailure(answer);
}
