// The Google Calendar client (src/calendar/google.ts, openspec change connect-google-calendar: the google-calendar
// spec, design decisions 3, 5 and 7) over a fake fetch: each call's exact request, the fixed hosts, the timeout, a
// caller's signal, the 2 MB cap, the ID token's claims, every error mapping, and the revoke. Tests never call Google;
// every token, code, id and secret here is made up.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE, createGoogleCalendarClient, GOOGLE_FAILURES, GOOGLE_TIMEOUT_MS, GoogleCalendarError,
  MAX_GOOGLE_BYTES, revokeGoogleGrant, type GoogleCalendarClient, type GoogleFailure,
} from '../src/calendar/google.ts';

const CLIENT_ID = '123456789012-testclient0000000000000000000.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-client-secret-0000';
const CODE = '4/0test-authorization-code-0000';
const REFRESH = '1//0test-refresh-token-0000';
const ACCESS = 'ya29.test-access-token-0000';
const NEW_REFRESH = '1//0test-new-refresh-token-0000';
const SUBJECT = '109876543210987654321';
const SHARED_ID = 'bookings.team@group.calendar.example.test';
const SECRETS = [CLIENT_SECRET, CODE, REFRESH, ACCESS, NEW_REFRESH, SHARED_ID];

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly signal: AbortSignal | null;
}

type Step =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'response'; response: Response }
  /** Rejects as undici does when the connection fails, or on a redirect under `redirect: 'error'`. */
  | { kind: 'network' }
  /** Never answers; rejects with the signal's reason once it aborts, as fetch does. */
  | { kind: 'hang' }
  /** Answers 200 and sends part of a body, which fails once the signal aborts, as fetch's does. */
  | { kind: 'stall' };

function fakeGoogle() {
  const calls: Recorded[] = [];
  const steps: Step[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const signal = init.signal ?? null;
    calls.push({ url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : null, redirect: init.redirect, signal });
    const step = steps.shift();
    if (step === undefined) return Promise.reject(new Error('unscripted Google call'));
    // As fetch does, a signal already aborted rejects at once.
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
    switch (step.kind) {
      case 'json':
        return Promise.resolve(Response.json(step.body, { status: step.status ?? 200 }));
      case 'text':
        return Promise.resolve(new Response(step.body, { status: step.status }));
      case 'response':
        return Promise.resolve(step.response);
      case 'network':
        return Promise.reject(new TypeError('fetch failed'));
      case 'hang':
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(signal.reason as Error); }, { once: true });
        });
      case 'stall':
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items": ['));
            signal?.addEventListener('abort', () => { controller.error(signal.reason); }, { once: true });
          },
        }), { status: 200 }));
    }
  };
  return { fetch, calls, script: (...next: Step[]) => { steps.push(...next); } };
}

/** An ID token as the token endpoint sends it; its signature is not checked (design decision 3). */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'test' })}.${part(claims)}.c2lnbmF0dXJl`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: SUBJECT, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...overrides };
}

function tokenAnswer(overrides: Record<string, unknown> = {}): Step {
  return {
    kind: 'json',
    body: {
      access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: `openid ${CALENDAR_LIST_SCOPE} ${CALENDAR_EVENTS_SCOPE}`,
      token_type: 'Bearer', id_token: idToken(claims()), ...overrides,
    },
  };
}

function setup(timeoutMs?: number): { fake: ReturnType<typeof fakeGoogle>; client: GoogleCalendarClient } {
  const fake = fakeGoogle();
  const client = createGoogleCalendarClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fake.fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return { fake, client };
}

/** No error carries a code, token, secret, client id or calendar id, nor any field but its code and status. */
function expectNothingLeaks(err: GoogleCalendarError): void {
  const shown = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;
  for (const secret of [...SECRETS, CLIENT_ID]) expect(shown).not.toContain(secret);
  expect(Object.keys(err).sort()).toEqual(['code', 'name', 'status']);
}

/** The error a call failed with, checked where it is caught, so every test checks the errors it makes. */
async function failureOf(run: () => Promise<unknown>): Promise<GoogleCalendarError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof GoogleCalendarError) {
      expectNothingLeaks(err);
      return err;
    }
    throw err;
  }
  throw new Error('expected a GoogleCalendarError');
}

function formOf(body: string | null): [string, string][] {
  return [...new URLSearchParams(body ?? '').entries()];
}

function queryOf(url: string | undefined): [string, string][] {
  return [...new URL(url ?? 'https://invalid.test').searchParams.entries()];
}

afterEach(() => { vi.restoreAllMocks(); });

describe('exchangeCode', () => {
  it('posts exactly the code, the client id and secret, redirect_uri postmessage and the grant type, and answers the tokens, scopes and subject', async () => {
    const { fake, client } = setup();
    fake.script(tokenAnswer());
    expect(await client.exchangeCode(CODE)).toEqual({
      accessToken: ACCESS, refreshToken: REFRESH, scopes: ['openid', CALENDAR_LIST_SCOPE, CALENDAR_EVENTS_SCOPE], subject: SUBJECT,
    });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://oauth2.googleapis.com/token');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    expect(formOf(call?.body ?? null)).toEqual([
      ['code', CODE], ['client_id', CLIENT_ID], ['client_secret', CLIENT_SECRET], ['redirect_uri', 'postmessage'], ['grant_type', 'authorization_code'],
    ]);
    expect(call?.redirect).toBe('error');
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers a null refresh token when Google sends none, and the scopes as granted', async () => {
    const { fake, client } = setup();
    fake.script(tokenAnswer({ refresh_token: undefined, scope: `openid ${CALENDAR_LIST_SCOPE}` }));
    expect(await client.exchangeCode(CODE)).toMatchObject({ refreshToken: null, scopes: ['openid', CALENDAR_LIST_SCOPE] });
  });

  it('accepts either form of Google’s issuer and an exp within 5 seconds of tolerance', async () => {
    const { fake, client } = setup();
    fake.script(tokenAnswer({ id_token: idToken(claims({ iss: 'accounts.google.com' })) }));
    expect(await client.exchangeCode(CODE)).toMatchObject({ subject: SUBJECT });
    fake.script(tokenAnswer({ id_token: idToken(claims({ exp: Math.floor(Date.now() / 1000) - 2 })) }));
    expect(await client.exchangeCode(CODE)).toMatchObject({ subject: SUBJECT });
  });

  it('refuses an ID token for another client, from another issuer, expired, without a subject, malformed or missing as bad_response', async () => {
    const { fake, client } = setup();
    const refused: unknown[] = [
      idToken(claims({ aud: 'another-client.apps.googleusercontent.com' })),
      idToken(claims({ aud: [CLIENT_ID] })),
      idToken(claims({ iss: 'https://accounts.example.test' })),
      idToken(claims({ exp: Math.floor(Date.now() / 1000) - 10 })),
      idToken(claims({ sub: undefined })),
      idToken(claims({ sub: '' })),
      'not-a-token',
      `${idToken(claims())}.extra`,
      'e30.bm90IGpzb24.c2ln',
      undefined,
    ];
    for (const token of refused) {
      fake.script(tokenAnswer({ id_token: token }));
      const err = await failureOf(() => client.exchangeCode(CODE));
      expect([err.code, err.status]).toEqual(['bad_response', 200]);
    }
  });

  it('maps Google’s invalid_grant and invalid_client by their error, never keeping its description', async () => {
    const { fake, client } = setup();
    const description = 'Bad Request: the code was already redeemed for test-account@example.test';
    fake.script({ kind: 'json', status: 400, body: { error: 'invalid_grant', error_description: description } });
    const grant = await failureOf(() => client.exchangeCode(CODE));
    expect([grant.code, grant.status]).toEqual(['invalid_grant', 400]);
    fake.script({ kind: 'json', status: 401, body: { error: 'invalid_client', error_description: description } });
    const clientError = await failureOf(() => client.exchangeCode(CODE));
    expect([clientError.code, clientError.status]).toEqual(['invalid_client', 401]);
    // Another refusal, a rate limit, Google down, and a 2xx without an access token.
    fake.script({ kind: 'json', status: 400, body: { error: 'redirect_uri_mismatch', error_description: description } });
    expect((await failureOf(() => client.exchangeCode(CODE))).code).toBe('unavailable');
    fake.script({ kind: 'json', status: 429, body: { error: 'rate_limit_exceeded' } });
    expect((await failureOf(() => client.exchangeCode(CODE))).code).toBe('rate_limited');
    fake.script({ kind: 'text', status: 503, body: '<html>Service Unavailable</html>' });
    expect(await failureOf(() => client.exchangeCode(CODE))).toMatchObject({ code: 'unavailable', status: 503 });
    fake.script({ kind: 'json', body: { token_type: 'Bearer' } });
    expect(await failureOf(() => client.exchangeCode(CODE))).toMatchObject({ code: 'bad_response', status: 200 });
    for (const err of [grant, clientError]) {
      expect(err.message).not.toContain('redeemed');
      expect(JSON.stringify(err)).not.toContain('example.test');
      expect(Object.keys(err).sort()).toEqual(['code', 'name', 'status']);
    }
  });
});

describe('refreshAccess', () => {
  it('posts exactly the client id and secret, the refresh token and the grant type, and answers a new refresh token only when Google sends one', async () => {
    const { fake, client } = setup();
    fake.script({ kind: 'json', body: { access_token: ACCESS, expires_in: 3599, scope: CALENDAR_EVENTS_SCOPE, token_type: 'Bearer' } });
    expect(await client.refreshAccess(REFRESH)).toEqual({ accessToken: ACCESS, refreshToken: null });
    const call = fake.calls[0];
    expect(call?.url).toBe('https://oauth2.googleapis.com/token');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    expect(formOf(call?.body ?? null)).toEqual([
      ['client_id', CLIENT_ID], ['client_secret', CLIENT_SECRET], ['refresh_token', REFRESH], ['grant_type', 'refresh_token'],
    ]);
    expect(call?.redirect).toBe('error');

    fake.script({ kind: 'json', body: { access_token: ACCESS, refresh_token: NEW_REFRESH } });
    expect(await client.refreshAccess(REFRESH)).toEqual({ accessToken: ACCESS, refreshToken: NEW_REFRESH });

    fake.script({ kind: 'json', status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    expect(await failureOf(() => client.refreshAccess(REFRESH))).toMatchObject({ code: 'invalid_grant', status: 400 });
  });
});

describe('the calendar list', () => {
  it('lists with minAccessRole reader, 250 at most and the fixed fields, one page, the primary flag and the name as summaryOverride ?? summary', async () => {
    const { fake, client } = setup();
    fake.script({
      kind: 'json',
      body: {
        nextPageToken: 'next-page-0001',
        items: [
          { id: SHARED_ID, summary: 'Bookings', accessRole: 'reader' },
          { id: 'owner@example.test', summary: 'owner@example.test', summaryOverride: 'My calendar', primary: true, accessRole: 'owner' },
          { id: 'holidays@group.v.calendar.example.test', accessRole: 'freeBusyReader' },
          // No id: not a calendar Townwise can add.
          { summary: 'No id' },
        ],
      },
    });
    expect(await client.listCalendars(ACCESS)).toEqual([
      { id: SHARED_ID, name: 'Bookings', primary: false, accessRole: 'reader' },
      { id: 'owner@example.test', name: 'My calendar', primary: true, accessRole: 'owner' },
      { id: 'holidays@group.v.calendar.example.test', name: '', primary: false, accessRole: 'freeBusyReader' },
    ]);
    // One page only, though Google offered another.
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url.split('?')[0]).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    expect(queryOf(call?.url)).toEqual([
      ['minAccessRole', 'reader'], ['maxResults', '250'], ['fields', 'nextPageToken,items(id,summary,summaryOverride,primary,accessRole)'],
    ]);
    expect(call?.method).toBe('GET');
    expect(call?.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: 'application/json' });
    expect(call?.body).toBeNull();
    expect(call?.redirect).toBe('error');
  });

  it('gets one calendar by its id in the path, `primary` included, and answers Google’s real id', async () => {
    const { fake, client } = setup();
    fake.script({ kind: 'json', body: { id: 'owner@example.test', summary: 'owner@example.test', primary: true, accessRole: 'owner' } });
    expect(await client.getCalendar(ACCESS, 'primary')).toEqual({ id: 'owner@example.test', name: 'owner@example.test', primary: true, accessRole: 'owner' });
    expect(fake.calls[0]?.url).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary?fields=id%2Csummary%2CsummaryOverride%2Cprimary%2CaccessRole');
    fake.script({ kind: 'json', body: { id: SHARED_ID, summary: 'Bookings', accessRole: 'reader' } });
    await client.getCalendar(ACCESS, SHARED_ID);
    expect(fake.calls[1]?.url.split('?')[0]).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList/bookings.team%40group.calendar.example.test');
    // A path can't be escaped from.
    fake.script({ kind: 'json', body: { id: 'x' } });
    await client.getCalendar(ACCESS, '../../calendars/x?y=z#w');
    expect(fake.calls[2]?.url.split('?')[0]).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList/..%2F..%2Fcalendars%2Fx%3Fy%3Dz%23w');
    expect(fake.calls[2]?.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: 'application/json' });
  });
});

describe('the events list', () => {
  const window = { timeMin: '2026-11-14T00:00:00Z', timeMax: '2027-12-21T00:00:00Z', timeZone: 'America/New_York' };

  it('asks exactly for single events by start, no deleted, default type, the window and zone, 500 a page and the minimal fields', async () => {
    const { fake, client } = setup();
    fake.script({
      kind: 'json',
      body: {
        nextPageToken: 'page-2',
        items: [
          { id: 'evt1', status: 'confirmed', summary: 'Private party', start: { dateTime: '2026-11-20T18:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-20T22:00:00-05:00' } },
          { id: 'evt2', status: 'confirmed', start: { date: '2026-12-04' }, end: { date: '2026-12-06' } },
          { id: 'evt3' },
          // No id: skipped.
          { summary: 'No id', start: { date: '2026-12-04' } },
        ],
      },
    });
    expect(await client.listEvents(ACCESS, SHARED_ID, { ...window, pageToken: null })).toEqual({
      items: [
        { id: 'evt1', status: 'confirmed', summary: 'Private party', start: { date: null, dateTime: '2026-11-20T18:00:00-05:00' }, end: { date: null, dateTime: '2026-11-20T22:00:00-05:00' } },
        { id: 'evt2', status: 'confirmed', summary: null, start: { date: '2026-12-04', dateTime: null }, end: { date: '2026-12-06', dateTime: null } },
        { id: 'evt3', status: null, summary: null, start: null, end: null },
      ],
      nextPageToken: 'page-2',
    });
    const call = fake.calls[0];
    expect(call?.url.split('?')[0]).toBe('https://www.googleapis.com/calendar/v3/calendars/bookings.team%40group.calendar.example.test/events');
    expect(queryOf(call?.url)).toEqual([
      ['singleEvents', 'true'], ['orderBy', 'startTime'], ['showDeleted', 'false'], ['eventTypes', 'default'],
      ['timeMin', '2026-11-14T00:00:00Z'], ['timeMax', '2027-12-21T00:00:00Z'], ['timeZone', 'America/New_York'], ['maxResults', '500'],
      ['fields', 'nextPageToken,items(id,status,summary,start,end)'],
    ]);
    expect(call?.method).toBe('GET');
    expect(call?.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: 'application/json' });
    expect(call?.redirect).toBe('error');

    // The next page: the same query and the token, and the last page has no next one.
    fake.script({ kind: 'json', body: { items: [] } });
    expect(await client.listEvents(ACCESS, SHARED_ID, { ...window, pageToken: 'page-2' })).toEqual({ items: [], nextPageToken: null });
    expect(queryOf(fake.calls[1]?.url)).toEqual([...queryOf(call?.url), ['pageToken', 'page-2']]);
    // An empty answer is no events.
    fake.script({ kind: 'json', body: {} });
    expect(await client.listEvents(ACCESS, SHARED_ID, { ...window, pageToken: null })).toEqual({ items: [], nextPageToken: null });
  });

  it('answers bad_response for a 2xx that is not the expected JSON', async () => {
    const { fake, client } = setup();
    for (const step of [
      { kind: 'text', status: 200, body: '<html>Sign in</html>' },
      { kind: 'json', body: { items: 'not a list' } },
      { kind: 'json', body: [] },
      { kind: 'text', status: 200, body: '' },
    ] satisfies Step[]) {
      fake.script(step);
      expect(await failureOf(() => client.listEvents(ACCESS, SHARED_ID, { ...window, pageToken: null }))).toMatchObject({ code: 'bad_response', status: 200 });
    }
    fake.script({ kind: 'json', body: { summary: 'no id' } });
    expect(await failureOf(() => client.getCalendar(ACCESS, 'primary'))).toMatchObject({ code: 'bad_response' });
    fake.script({ kind: 'json', body: { items: 3 } });
    expect(await failureOf(() => client.listCalendars(ACCESS))).toMatchObject({ code: 'bad_response' });
  });
});

describe('Calendar API errors', () => {
  /** Google's error body, in the legacy `errors` form and the current `details` form. */
  function legacy(reason: string, domain: string): unknown {
    return { error: { code: 403, message: `Reason ${reason} for owner@example.test`, errors: [{ domain, reason, message: 'secret text' }] } };
  }
  function detailed(reason: string): unknown {
    return {
      error: {
        code: 403, status: 'PERMISSION_DENIED', message: 'Google Calendar API has not been used in project 123 before or it is disabled.',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'calendar-json.googleapis.com' } }],
      },
    };
  }

  const cases: [string, Step, GoogleFailure, number | null][] = [
    ['401', { kind: 'json', status: 401, body: { error: { code: 401, errors: [{ domain: 'global', reason: 'authError' }] } } }, 'unauthorized', 401],
    ['403 quotaExceeded', { kind: 'json', status: 403, body: legacy('quotaExceeded', 'usageLimits') }, 'rate_limited', 403],
    ['403 userRateLimitExceeded', { kind: 'json', status: 403, body: legacy('userRateLimitExceeded', 'usageLimits') }, 'rate_limited', 403],
    ['403 rateLimitExceeded', { kind: 'json', status: 403, body: legacy('rateLimitExceeded', 'usageLimits') }, 'rate_limited', 403],
    ['403 rateLimitExceeded in details', { kind: 'json', status: 403, body: detailed('rateLimitExceeded') }, 'rate_limited', 403],
    ['429', { kind: 'json', status: 429, body: legacy('rateLimitExceeded', 'usageLimits') }, 'rate_limited', 429],
    ['403 accessNotConfigured, legacy, usageLimits', { kind: 'json', status: 403, body: legacy('accessNotConfigured', 'usageLimits') }, 'api_disabled', 403],
    ['403 accessNotConfigured, legacy, global', { kind: 'json', status: 403, body: legacy('accessNotConfigured', 'global') }, 'api_disabled', 403],
    ['403 SERVICE_DISABLED detail', { kind: 'json', status: 403, body: detailed('SERVICE_DISABLED') }, 'api_disabled', 403],
    ['403 forbidden', { kind: 'json', status: 403, body: legacy('forbidden', 'global') }, 'forbidden', 403],
    ['403 with a usageLimits domain but another reason', { kind: 'json', status: 403, body: legacy('requiredAccessLevel', 'usageLimits') }, 'forbidden', 403],
    ['403 with no JSON', { kind: 'text', status: 403, body: 'Forbidden' }, 'forbidden', 403],
    ['404', { kind: 'json', status: 404, body: { error: { code: 404, errors: [{ domain: 'global', reason: 'notFound' }] } } }, 'not_found', 404],
    ['410', { kind: 'json', status: 410, body: { error: { code: 410, errors: [{ domain: 'global', reason: 'deleted' }] } } }, 'not_found', 410],
    ['500', { kind: 'json', status: 500, body: { error: { code: 500, errors: [{ domain: 'global', reason: 'backendError' }] } } }, 'unavailable', 500],
    ['503', { kind: 'text', status: 503, body: 'down' }, 'unavailable', 503],
    ['400', { kind: 'json', status: 400, body: { error: { code: 400, errors: [{ domain: 'global', reason: 'timeRangeEmpty' }] } } }, 'unavailable', 400],
    ['a redirect answered', { kind: 'response', response: new Response(null, { status: 302, headers: { location: 'https://accounts.example.test/' } }) }, 'unavailable', 302],
    ['a redirect refused by fetch', { kind: 'network' }, 'unavailable', null],
  ];

  it.each(cases)('%s', async (_name, step, code, status) => {
    const { fake, client } = setup();
    fake.script(step);
    const err = await failureOf(() => client.listEvents(ACCESS, SHARED_ID, { timeMin: 'a', timeMax: 'b', timeZone: 'UTC', pageToken: null }));
    expect([err.code, err.status]).toEqual([code, status]);
    expect(err.message).toBe(`Google Calendar call failed: ${code}`);
    expect(JSON.stringify(err)).not.toMatch(/secret text|owner@example\.test|has not been used/);
  });

  it('maps the calendar list and get the same way', async () => {
    const { fake, client } = setup();
    fake.script({ kind: 'json', status: 401, body: {} }, { kind: 'json', status: 404, body: {} }, { kind: 'json', status: 403, body: detailed('SERVICE_DISABLED') });
    expect((await failureOf(() => client.listCalendars(ACCESS))).code).toBe('unauthorized');
    expect((await failureOf(() => client.getCalendar(ACCESS, SHARED_ID))).code).toBe('not_found');
    expect((await failureOf(() => client.listCalendars(ACCESS))).code).toBe('api_disabled');
  });

  it('has a fixed list of codes', () => {
    expect(GOOGLE_FAILURES).toEqual([
      'invalid_grant', 'invalid_client', 'unauthorized', 'rate_limited', 'forbidden', 'api_disabled', 'not_found', 'unavailable', 'bad_response',
    ]);
  });
});

describe('bounds', () => {
  it('gives each call 10 seconds by default, combined with no caller signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fake, client } = setup();
    fake.script({ kind: 'json', body: { items: [] } });
    await client.listCalendars(ACCESS);
    expect(GOOGLE_TIMEOUT_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fake.calls[0]?.signal?.aborted).toBe(false);
  });

  it('ends a call that hangs when its time is up', async () => {
    const { fake, client } = setup(30);
    fake.script({ kind: 'hang' });
    expect(await failureOf(() => client.refreshAccess(REFRESH))).toMatchObject({ code: 'unavailable', status: null });
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
  });

  it('ends a call in flight when the caller’s signal aborts, and a body being read', async () => {
    const { fake, client } = setup();
    const controller = new AbortController();
    fake.script({ kind: 'hang' });
    const pending = failureOf(() => client.listEvents(ACCESS, SHARED_ID, { timeMin: 'a', timeMax: 'b', timeZone: 'UTC', pageToken: null }, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'unavailable', status: null });
    expect(fake.calls[0]?.signal?.aborted).toBe(true);

    const mid = new AbortController();
    fake.script({ kind: 'stall' });
    const reading = failureOf(() => client.listEvents(ACCESS, SHARED_ID, { timeMin: 'a', timeMax: 'b', timeZone: 'UTC', pageToken: null }, { signal: mid.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    mid.abort();
    expect(await reading).toMatchObject({ code: 'unavailable', status: 200 });

    // A signal already aborted never waits.
    fake.script({ kind: 'hang' });
    expect(await failureOf(() => client.listCalendars(ACCESS, { signal: AbortSignal.abort() }))).toMatchObject({ code: 'unavailable' });
  });

  it('reads at most 2 MB of an answer', async () => {
    expect(MAX_GOOGLE_BYTES).toBe(2 * 1024 * 1024);
    const { fake, client } = setup();
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    fake.script({ kind: 'response', response: new Response(endless, { status: 200 }) });
    expect(await failureOf(() => client.listCalendars(ACCESS))).toMatchObject({ code: 'unavailable', status: 200 });
    // Stopped soon after the cap, never reading the endless rest.
    expect(sent).toBeLessThan(MAX_GOOGLE_BYTES + 4 * chunk.byteLength);
    // A stated length over the cap is not read at all, an error answer's included.
    fake.script({ kind: 'response', response: new Response('{}', { status: 200, headers: { 'content-length': String(MAX_GOOGLE_BYTES + 1) } }) });
    expect(await failureOf(() => client.listCalendars(ACCESS))).toMatchObject({ code: 'unavailable', status: 200 });
    fake.script({ kind: 'response', response: new Response('{}', { status: 403, headers: { 'content-length': String(MAX_GOOGLE_BYTES + 1) } }) });
    expect(await failureOf(() => client.listCalendars(ACCESS))).toMatchObject({ code: 'unavailable', status: 403 });
    // Just under the cap is read.
    const padded = JSON.stringify({ items: [], pad: ' '.repeat(MAX_GOOGLE_BYTES - 100) });
    fake.script({ kind: 'text', status: 200, body: padded });
    expect(await client.listCalendars(ACCESS)).toEqual([]);
  });

  it('calls only Google’s two fixed hosts', async () => {
    const { fake, client } = setup();
    fake.script(tokenAnswer(), { kind: 'json', body: { access_token: ACCESS } }, { kind: 'json', body: {} }, { kind: 'json', body: { id: 'x' } }, { kind: 'json', body: {} });
    await client.exchangeCode(CODE);
    await client.refreshAccess(REFRESH);
    await client.listCalendars(ACCESS);
    await client.getCalendar(ACCESS, SHARED_ID);
    await client.listEvents(ACCESS, SHARED_ID, { timeMin: 'a', timeMax: 'b', timeZone: 'UTC', pageToken: null });
    expect(fake.calls.map((call) => new URL(call.url).origin)).toEqual([
      'https://oauth2.googleapis.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com', 'https://www.googleapis.com', 'https://www.googleapis.com',
    ]);
    expect(fake.calls.every((call) => call.redirect === 'error')).toBe(true);
  });
});

describe('revokeGoogleGrant', () => {
  it('posts the token alone in a form body to the revoke endpoint, with no query string and no client id or secret', async () => {
    const fake = fakeGoogle();
    fake.script({ kind: 'json', body: {} });
    await revokeGoogleGrant(REFRESH, { fetch: fake.fetch });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URL(call?.url ?? '').search).toBe('');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    expect(formOf(call?.body ?? null)).toEqual([['token', REFRESH]]);
    expect(call?.body).not.toContain(CLIENT_ID);
    expect(call?.body).not.toContain(CLIENT_SECRET);
    expect(call?.redirect).toBe('error');
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('counts a 200 and a 400 invalid_token as done, and throws for anything else', async () => {
    const fake = fakeGoogle();
    fake.script({ kind: 'text', status: 200, body: '' }, { kind: 'json', status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } });
    await expect(revokeGoogleGrant(REFRESH, { fetch: fake.fetch })).resolves.toBeUndefined();
    await expect(revokeGoogleGrant(REFRESH, { fetch: fake.fetch })).resolves.toBeUndefined();
    fake.script({ kind: 'json', status: 400, body: { error: 'invalid_request' } }, { kind: 'text', status: 503, body: 'down' }, { kind: 'network' });
    expect(await failureOf(() => revokeGoogleGrant(REFRESH, { fetch: fake.fetch }))).toMatchObject({ code: 'unavailable', status: 400 });
    expect(await failureOf(() => revokeGoogleGrant(REFRESH, { fetch: fake.fetch }))).toMatchObject({ code: 'unavailable', status: 503 });
    expect(await failureOf(() => revokeGoogleGrant(REFRESH, { fetch: fake.fetch }))).toMatchObject({ code: 'unavailable', status: null });
  });

  it('gives up when its time is up or the caller’s signal aborts', async () => {
    const fake = fakeGoogle();
    fake.script({ kind: 'hang' });
    expect(await failureOf(() => revokeGoogleGrant(REFRESH, { fetch: fake.fetch, timeoutMs: 30 }))).toMatchObject({ code: 'unavailable' });
    const controller = new AbortController();
    fake.script({ kind: 'hang' });
    const pending = failureOf(() => revokeGoogleGrant(REFRESH, { fetch: fake.fetch, signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'unavailable' });
    expect(fake.calls[1]?.signal?.aborted).toBe(true);
  });
});

describe('what leaves the client', () => {
  it('no error carries a code, token, secret or calendar id, and no URL carries a code, token or secret', async () => {
    const { fake, client } = setup();
    // Each call failing with Google's answer quoting a code, token or id; failureOf checks every error any test makes.
    fake.script(
      { kind: 'json', status: 400, body: { error: 'invalid_grant', error_description: `code ${CODE} for ${SHARED_ID}` } },
      { kind: 'json', status: 400, body: { error: 'invalid_grant', error_description: `token ${REFRESH}` } },
      { kind: 'json', status: 403, body: { error: { message: `no access to ${SHARED_ID}`, errors: [{ reason: 'forbidden' }] } } },
      { kind: 'json', status: 404, body: { error: { message: `${SHARED_ID} not found` } } },
      { kind: 'text', status: 500, body: `${ACCESS} ${SHARED_ID}` },
    );
    const errors = [
      await failureOf(() => client.exchangeCode(CODE)),
      await failureOf(() => client.refreshAccess(REFRESH)),
      await failureOf(() => client.listCalendars(ACCESS)),
      await failureOf(() => client.getCalendar(ACCESS, SHARED_ID)),
      await failureOf(() => client.listEvents(ACCESS, SHARED_ID, { timeMin: 'a', timeMax: 'b', timeZone: 'UTC', pageToken: null })),
    ];
    expect(errors.map((err) => err.code)).toEqual(['invalid_grant', 'invalid_grant', 'forbidden', 'not_found', 'unavailable']);
    expect(fake.calls).toHaveLength(5);
    for (const call of fake.calls) {
      for (const secret of [CLIENT_SECRET, CODE, REFRESH, ACCESS, NEW_REFRESH]) expect(call.url).not.toContain(secret);
      expect(call.url).not.toContain('token=');
    }
  });
});
