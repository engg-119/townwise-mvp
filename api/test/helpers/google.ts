// A scriptable fake of calendar/google.ts's GoogleCalendarClient and revokeGoogleGrant for the integration tests
// (openspec change connect-google-calendar, task 2.1). Nothing reaches the network. Every call is recorded with its
// method and arguments, so a test can assert which Google calls were made, and that none was. Each method answers from
// `fake.state` unless a test scripts it with `fake.on(method, handler)`; a handler that throws a GoogleCalendarError
// fails that call as Google's refusal would. The tokens below are made up: no answer, row, audit event or log line may
// hold them in plain text. addGoogleConnection and addGoogleCalendar write rows straight to the collections, for the
// states no request leaves behind (a row left by a crash, a connection in another organization).
import type { KeyObject } from 'node:crypto';

import { Types } from 'mongoose';

import type { TownwiseTestServer } from './server.ts';
import {
  CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE, GoogleCalendarError,
  type GoogleCalendarClient, type GoogleCalendarEntry, type GoogleEventItem, type GoogleFailure, type revokeGoogleGrant,
} from '../../src/calendar/google.ts';
import { seal } from '../../src/calendar/secret.ts';
import { CHECK_INTERVAL_MS } from '../../src/stores/google-connections.ts';

/** A web client id in Google's format, for the config and the list's `google.clientId`. */
export const GOOGLE_CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
export const ALL_SCOPES: readonly string[] = ['openid', CALENDAR_LIST_SCOPE, CALENDAR_EVENTS_SCOPE];
/** What an exchange answers by default; each is a secret. */
export const ACCESS_TOKEN = 'ya29.fake-access-token-4d1e';
export const REFRESH_TOKEN = '1//fake-refresh-token-9b2c';
/** A code the browser posts; a secret too. */
export const AUTH_CODE = '4/0Afake-authorization-code-77aa';

export type GoogleMethod = 'exchangeCode' | 'refreshAccess' | 'listCalendars' | 'getCalendar' | 'listEvents' | 'revoke';

export interface GoogleCall {
  readonly method: GoogleMethod;
  readonly args: readonly unknown[];
}

export interface FakeGoogleState {
  /** The ID token's `sub` an exchange answers. */
  subject: string;
  /** The refresh token an exchange answers; null for none. */
  refreshToken: string | null;
  scopes: readonly string[];
  /** A new refresh token refreshAccess answers; null sends none. */
  rotatedRefreshToken: string | null;
  /** The person's calendar list, in Google's order. */
  calendars: GoogleCalendarEntry[];
  /** Each calendar's single events, by its real id. */
  events: Record<string, GoogleEventItem[]>;
}

interface Handlers {
  exchangeCode: GoogleCalendarClient['exchangeCode'];
  refreshAccess: GoogleCalendarClient['refreshAccess'];
  listCalendars: GoogleCalendarClient['listCalendars'];
  getCalendar: GoogleCalendarClient['getCalendar'];
  listEvents: GoogleCalendarClient['listEvents'];
  revoke: typeof revokeGoogleGrant;
}

export interface FakeGoogle {
  readonly client: GoogleCalendarClient;
  readonly revoke: typeof revokeGoogleGrant;
  readonly calls: GoogleCall[];
  state: FakeGoogleState;
  /** Scripts one method until reset(). */
  on<M extends GoogleMethod>(method: M, handler: Handlers[M]): void;
  /** Every call to one method, in order. */
  callsOf(method: GoogleMethod): GoogleCall[];
  /** The default state and answers again, and no calls recorded. */
  reset(): void;
}

export const PRIMARY_ID = 'owner@example.test';
export const SHARED_ID = 'c_bookings0001@group.calendar.google.com';

function defaultState(): FakeGoogleState {
  return {
    subject: 'google-subject-0001',
    refreshToken: REFRESH_TOKEN,
    scopes: ALL_SCOPES,
    rotatedRefreshToken: null,
    calendars: [
      { id: SHARED_ID, name: 'Front desk bookings', primary: false, accessRole: 'reader' },
      { id: PRIMARY_ID, name: PRIMARY_ID, primary: true, accessRole: 'owner' },
    ],
    events: {},
  };
}

/** A failure as the client throws it. */
export function googleError(code: GoogleFailure, status: number | null = null): GoogleCalendarError {
  return new GoogleCalendarError(code, status);
}

/** An all-day item on `date` (its end the next day, exclusive, as Google answers). */
export function allDay(id: string, summary: string, date: string): GoogleEventItem {
  const end = new Date(`${date}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { id, status: 'confirmed', summary, start: { date, dateTime: null }, end: { date: end.toISOString().slice(0, 10), dateTime: null } };
}

/** Whether an item overlaps a window: its start before timeMax and its end after timeMin (Google's rule). */
function inWindow(item: GoogleEventItem, timeMin: string, timeMax: string): boolean {
  const start = item.start?.dateTime ?? item.start?.date ?? '';
  const end = item.end?.dateTime ?? item.end?.date ?? start;
  return start < timeMax && end > timeMin;
}

export function createFakeGoogle(): FakeGoogle {
  const calls: GoogleCall[] = [];
  const fake: { state: FakeGoogleState } = { state: defaultState() };
  const defaults = (): Handlers => ({
    exchangeCode: () => Promise.resolve({
      accessToken: ACCESS_TOKEN, refreshToken: fake.state.refreshToken, scopes: fake.state.scopes, subject: fake.state.subject,
    }),
    refreshAccess: () => Promise.resolve({ accessToken: ACCESS_TOKEN, refreshToken: fake.state.rotatedRefreshToken }),
    listCalendars: () => Promise.resolve([...fake.state.calendars]),
    getCalendar: (_token, calendarId) => {
      const found = fake.state.calendars.find((entry) => (calendarId === 'primary' ? entry.primary : entry.id === calendarId));
      return found === undefined ? Promise.reject(googleError('not_found', 404)) : Promise.resolve(found);
    },
    listEvents: (_token, calendarId, query) => Promise.resolve({
      items: (fake.state.events[calendarId] ?? []).filter((item) => inWindow(item, query.timeMin, query.timeMax)), nextPageToken: null,
    }),
    revoke: () => Promise.resolve(),
  });
  let handlers = defaults();
  const record = (method: GoogleMethod, args: readonly unknown[]): void => { calls.push({ method, args }); };
  const client: GoogleCalendarClient = {
    exchangeCode: (...args) => { record('exchangeCode', args); return handlers.exchangeCode(...args); },
    refreshAccess: (...args) => { record('refreshAccess', args); return handlers.refreshAccess(...args); },
    listCalendars: (...args) => { record('listCalendars', args); return handlers.listCalendars(...args); },
    getCalendar: (...args) => { record('getCalendar', args); return handlers.getCalendar(...args); },
    listEvents: (...args) => { record('listEvents', args); return handlers.listEvents(...args); },
  };
  return {
    client,
    revoke: (...args) => { record('revoke', args); return handlers.revoke(...args); },
    calls,
    get state() { return fake.state; },
    set state(next: FakeGoogleState) { fake.state = next; },
    on(method, handler) {
      handlers = { ...handlers, [method]: handler };
    },
    callsOf(method) {
      return calls.filter((call) => call.method === method);
    },
    reset() {
      calls.length = 0;
      fake.state = defaultState();
      handlers = defaults();
    },
  };
}

/** Links a kit user to a Google account, as signing in with Google would. */
export async function linkGoogle(server: Pick<TownwiseTestServer, 'authStores'>, userId: string, subject: string): Promise<void> {
  if ((await server.authStores.users.linkGoogleSubject({ id: userId, subject })) === null) throw new Error('user already linked');
}

type Server = Pick<TownwiseTestServer, 'connection' | 'clock'>;

/** A tw_google_connections row as a connect leaves it: the token sealed under `key`, the next check 24 hours on. */
export async function addGoogleConnection(
  server: Server, opts: { orgId: string; userId: string; key: KeyObject; refreshToken?: string },
): Promise<string> {
  const _id = new Types.ObjectId();
  const at = server.clock.now();
  await server.connection.collection('tw_google_connections').insertOne({
    _id, orgId: new Types.ObjectId(opts.orgId), userId: opts.userId, sealedRefreshToken: seal(opts.key, opts.refreshToken ?? REFRESH_TOKEN),
    scopes: [...ALL_SCOPES], agreedAt: at, connectedAt: at, updatedAt: at, revokedAt: null, checkAt: new Date(at.getTime() + CHECK_INTERVAL_MS),
    leaseUntil: null,
  });
  return _id.toHexString();
}

/** A Google calendar in `slot` read through `connectionId`, its Google calendar id sealed, with one all-day event titled `title`. */
export async function addGoogleCalendar(
  server: Server,
  opts: { orgId: string; locationId: string; connectionId: string; key: KeyObject; googleCalendarId: string; slot?: number; label?: string; title?: string },
): Promise<string> {
  const _id = new Types.ObjectId();
  const orgId = new Types.ObjectId(opts.orgId);
  const locationId = new Types.ObjectId(opts.locationId);
  const at = server.clock.now();
  await server.connection.collection('tw_calendar_sources').insertOne({
    _id, orgId, locationId, slot: opts.slot ?? 0, kind: 'google', label: opts.label ?? 'Google calendar',
    sealedAddress: seal(opts.key, opts.googleCalendarId), host: null, googleConnectionId: new Types.ObjectId(opts.connectionId), generation: 1,
    reservedGeneration: 1, eventCount: 1, skippedRepeating: 0, status: 'ok', lastSuccessAt: at, lastAttemptAt: at,
    nextRefreshAt: new Date(at.getTime() + 6 * 60 * 60_000), leaseUntil: null, consecutiveFailures: 0, lastManualRefreshAt: null,
    createdBy: 'fixture', createdAt: at,
  });
  await server.connection.collection('tw_calendar_events').insertOne({
    orgId, locationId, sourceId: _id, generation: 1, uid: `${_id.toHexString()}@google.test`, title: opts.title ?? 'Private dinner',
    startDate: '2026-06-05', endDate: '2026-06-05', startTime: null, endTime: null,
  });
  return _id.toHexString();
}
