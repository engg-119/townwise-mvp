// tw_calendar_sources and tw_calendar_events (openspec change connect-owner-calendar: the owner-calendar and
// calendar-subscription specs, design decisions 1 and 2): a location's own calendars, each an imported .ics file, a
// subscription link or a Google calendar (openspec change connect-google-calendar, design decision 6), and their single
// events. An event keeps its UID, title, dates and hours only (calendar/ics.ts, calendar/google-events.ts).
// A link's address is a credential: it is stored only as the opaque string calendar/secret.ts seals, read back only by
// sealedAddress() for server code, and never part of a record; its host is kept in plain text for display. A Google
// calendar's sealedAddress holds its Google calendar id sealed the same way (a primary or shared calendar's id is an
// email address), read back only through googleSource() and googleSources(), never sealedAddress(), with the
// googleConnectionId of the tw_google_connections row whose access reads it; its host is null. Titles name customers:
// nothing here logs, and no label, host, address, calendar id or title belongs in a log line or an audit event.
//
// At most 5 calendars per location, safe against concurrent adds without a transaction: each calendar holds one of 5
// slots under a unique index on (orgId, locationId, slot), and an add inserts into a slot it saw free, trying the next
// free one if another add took it first. Two adds racing for the last slot both insert, and the index refuses the
// second, which a count followed by an insert could not do. Removing a calendar frees its slot.
//
// Events are replaced by generation, with no transaction (writes ordered so a retry completes them): a replace reserves
// a generation number of its own on the calendar ($inc, so two writers never share one; with no crash or race it is the
// current generation + 1), writes the new events under it, switches the calendar to it with a compare-and-set on the
// generation it started from, recording the counts, and then deletes the older generations' events. Reads filter on
// each calendar's current generation, so a reader sees the old events or the new ones, never a mix. A crash (or a lost
// compare-and-set) before the switch leaves rows of an unused generation that no read returns; the next replace or the
// removal deletes them. Removal deletes the events, then the calendar, then the events again (removeWhere). "Refresh
// now" is held to one per calendar per 5 minutes by a compare-and-set on lastManualRefreshAt, so two requests at once
// cannot both pass, for a link or a Google calendar alike. The refresh loop claims a due link across organizations
// (stores/cross-tenant.ts claimDueCalendar, by nextRefreshAt) with a lease, and ends its refresh here: releaseRefresh
// sets the next refresh and lets the lease go only while the lease is still the one it took. A Google calendar is due
// as a link is. Removing a connection's calendars (removeForConnection) deletes the events, then those calendars, then
// their events again, as removeWhere does; a calendar added for the connection meanwhile is not among them, and its
// add checks the connection again after storing. Ids are checked by the caller.
//
// Stable keys (openspec change calendar-event-suggestions, design decisions 1 and 12): each row keeps `keyed`, whether
// its uid survives a refresh (calendar/ics.ts); a row written before that field reads as not keyed. findEvent and
// eventsByUid read the current generation for a note's link and its follow-up (calendar/follow-up.ts), and a replace
// that switched answers how many keyed uids of the generation it replaced it kept, read before it writes (the generation
// it switches from is current until its switch, so no one deletes those rows meanwhile). keyedEventsBetween reads a
// range's keyed events for TownwiseAI's weekly call (lab/suggestions.ts), with each calendar's kind and Google
// connection, never its label.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { MAX_EVENTS, MAX_TITLE_CHARS, type IcsEvent } from '../calendar/ics.ts';

export const CALENDAR_SOURCES_COLLECTION = 'tw_calendar_sources';
export const CALENDAR_EVENTS_COLLECTION = 'tw_calendar_events';

/** At most this many calendars per location. [CONFIRM: 5 calendars per location] */
export const MAX_CALENDARS = 5;
/** The owner's name for a calendar. [CONFIRM: a 60 character name] */
export const MAX_LABEL_CHARS = 60;
/** A link is fetched again this long after it was added or last refreshed. [CONFIRM: 6 hour refresh] */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
/** "Refresh now" runs at most once per calendar in this long (the calendar-subscription spec). */
export const MANUAL_REFRESH_INTERVAL_MS = 5 * 60_000;

export type CalendarKind = 'file' | 'link' | 'google';

/**
 * `ok`, or the code of the last failed refresh (design decisions 4 and 5). `bad_link` is a redirect to an address that
 * is not https on port 443. The `google_` codes are a Google calendar's (connect-google-calendar, design decision 7);
 * `key_mismatch` is also a Google token or calendar id the key no longer opens.
 */
export const CALENDAR_STATUSES = [
  'ok', 'bad_link', 'blocked_address', 'unreachable', 'timeout', 'too_large', 'http_error', 'not_calendar', 'key_mismatch',
  'google_revoked', 'google_not_found', 'google_forbidden', 'google_rate_limited', 'google_unavailable',
] as const;
export type CalendarStatus = typeof CALENDAR_STATUSES[number];
export type CalendarFailure = Exclude<CalendarStatus, 'ok'>;

interface SourceFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  /** 0 to MAX_CALENDARS - 1, unique per location: what holds the limit. */
  slot: number;
  kind: CalendarKind;
  label: string;
  /** A link's address, or a Google calendar's id, as calendar/secret.ts sealed it; null for a file. */
  sealedAddress: string | null;
  /** A link's host, in plain text; null for a file or a Google calendar. */
  host: string | null;
  /** The tw_google_connections row that reads a Google calendar; null for a file or a link. */
  googleConnectionId: Types.ObjectId | null;
  /** The generation reads return; 0 before the first events are written. */
  generation: number;
  /** The highest generation handed to a replace. */
  reservedGeneration: number;
  eventCount: number;
  skippedRepeating: number;
  status: CalendarStatus;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  /** When the refresh loop next reads a link or a Google calendar; null for a file, which is never fetched. */
  nextRefreshAt: Date | null;
  /** A refresh's claim on the calendar, until this time. */
  leaseUntil: Date | null;
  consecutiveFailures: number;
  /** The last "Refresh now", for its one per 5 minutes. */
  lastManualRefreshAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

interface EventFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  sourceId: Types.ObjectId;
  generation: number;
  uid: string;
  title: string;
  startDate: string;
  /** Inclusive. */
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  /** Whether `uid` survives a refresh; absent on rows written before it was kept, which read as false. */
  keyed?: boolean;
}

function sourceSchema(): Schema<SourceFields> {
  const schema = new Schema<SourceFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    slot: { type: Number, required: true, min: 0, max: MAX_CALENDARS - 1 },
    kind: { type: String, required: true, enum: ['file', 'link', 'google'] },
    label: { type: String, required: true, maxlength: MAX_LABEL_CHARS },
    sealedAddress: { type: String, default: null },
    host: { type: String, default: null },
    googleConnectionId: { type: Schema.Types.ObjectId, default: null },
    generation: { type: Number, required: true },
    reservedGeneration: { type: Number, required: true },
    eventCount: { type: Number, required: true },
    skippedRepeating: { type: Number, required: true },
    status: { type: String, required: true, enum: CALENDAR_STATUSES },
    lastSuccessAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    nextRefreshAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    consecutiveFailures: { type: Number, required: true },
    lastManualRefreshAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, slot: 1 }, { unique: true });
  // The refresh loop's claim of a due link, across organizations (stores/cross-tenant.ts); a file's is null.
  schema.index({ nextRefreshAt: 1 });
  return schema;
}

function eventSchema(): Schema<EventFields> {
  const schema = new Schema<EventFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    generation: { type: Number, required: true },
    uid: { type: String, required: true },
    title: { type: String, required: true, maxlength: MAX_TITLE_CHARS },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    keyed: { type: Boolean },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  // A calendar's generation by date (reads), and every row of an organization or a calendar (deletion) by its prefix.
  schema.index({ orgId: 1, sourceId: 1, generation: 1, startDate: 1 });
  return schema;
}

/** Registers TwCalendarSource (tw_calendar_sources) on first call. */
export function calendarSourceModel(connection: Connection): Model<SourceFields> {
  const existing = connection.models.TwCalendarSource as Model<SourceFields> | undefined;
  return existing ?? connection.model<SourceFields>('TwCalendarSource', sourceSchema(), CALENDAR_SOURCES_COLLECTION);
}

/** Registers TwCalendarEvent (tw_calendar_events) on first call. */
export function calendarEventModel(connection: Connection): Model<EventFields> {
  const existing = connection.models.TwCalendarEvent as Model<EventFields> | undefined;
  return existing ?? connection.model<EventFields>('TwCalendarEvent', eventSchema(), CALENDAR_EVENTS_COLLECTION);
}

/** A calendar as the API shows it: never its address. */
export interface OwnerCalendarRecord {
  readonly id: string;
  readonly locationId: string;
  readonly kind: CalendarKind;
  readonly label: string;
  /** A link's host (`calendar.google.com`); null for a file or a Google calendar. */
  readonly host: string | null;
  readonly eventCount: number;
  readonly skippedRepeating: number;
  readonly status: CalendarStatus;
  readonly lastSuccessAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly nextRefreshAt: Date | null;
  readonly leaseUntil: Date | null;
  readonly consecutiveFailures: number;
  readonly lastManualRefreshAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A stored event with its calendar's name. */
export interface OwnerCalendarEvent {
  readonly calendarId: string;
  /** The calendar's label. */
  readonly calendar: string;
  readonly uid: string;
  readonly title: string;
  readonly startDate: string;
  /** Inclusive. */
  readonly endDate: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
}

/** One event of a calendar's current generation, for server code (a note's link and its follow-up). */
export interface StoredEvent {
  readonly uid: string;
  readonly title: string;
  readonly startDate: string;
  /** Inclusive. */
  readonly endDate: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  /** Whether `uid` survives a refresh (calendar/ics.ts); only a keyed event is ever linked to a note. */
  readonly keyed: boolean;
}

/**
 * What a replace did. A switched one also answers the generation it switched to and, of the generation it replaced,
 * how many keyed uids that generation held (`hadKeys`) and how many of them the new events keep (`keptKeys`).
 */
export type ReplaceResult =
  | { readonly switched: false }
  | { readonly switched: true; readonly generation: number; readonly keptKeys: number; readonly hadKeys: number };

/**
 * An add's replace: a new calendar's first generation (its reservedGeneration starts at 0, and no one else knows its id
 * until the add answers), with no generation before it.
 */
export const ADDED_REPLACE = { switched: true, generation: 1, keptKeys: 0, hadKeys: 0 } as const satisfies ReplaceResult;

/**
 * A keyed event for the weekly suggestions call (lab/suggestions.ts): with its calendar's id, kind and, for a Google
 * calendar, the connection that reads it, so the call can leave out a Google calendar under an older agreement. Never the
 * calendar's label.
 */
export interface KeyedOwnerEvent extends StoredEvent {
  readonly calendarId: string;
  readonly kind: CalendarKind;
  /** The tw_google_connections row of a Google calendar; null for a file or a link. */
  readonly connectionId: string | null;
}

/** The keyed events eventsByUid found, read at one generation. */
export interface EventsByUid {
  readonly generation: number;
  /** How many events that generation holds. */
  readonly eventCount: number;
  readonly events: readonly StoredEvent[];
}

/**
 * A calendar to add: a link carries its sealed address and its host; a Google calendar its sealed Google calendar id
 * and the connection that reads it.
 */
export type NewCalendar =
  | { readonly kind: 'file'; readonly label: string }
  | { readonly kind: 'link'; readonly label: string; readonly sealedAddress: string; readonly host: string }
  | { readonly kind: 'google'; readonly label: string; readonly sealedAddress: string; readonly googleConnectionId: string };

/** A Google calendar as server code reads it: its sealed Google calendar id and its connection. Never answered. */
export interface GoogleSource {
  readonly calendarId: string;
  readonly connectionId: string;
  readonly sealedCalendarId: string;
}

/** What calendar/ics.ts parsed: the single events by start, and the repeating ones it counted. */
export interface ParsedCalendar {
  readonly events: readonly IcsEvent[];
  readonly skippedRepeating: number;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface OwnerCalendarStore {
  /** The location's calendars, oldest first. */
  list(scope: OrgScope, locationId: string): Promise<OwnerCalendarRecord[]>;
  /** One calendar of this location, else null (another location's or organization's id included). */
  find(scope: OrgScope, locationId: string, calendarId: string): Promise<OwnerCalendarRecord | null>;
  /**
   * A link calendar's sealed address, for server code only (the refresh); null for a file, a Google calendar or a
   * missing calendar.
   */
  sealedAddress(scope: OrgScope, locationId: string, calendarId: string): Promise<string | null>;
  /** One Google calendar of this location, for server code only (a refresh); null for any other kind or a missing one. */
  googleSource(scope: OrgScope, locationId: string, calendarId: string): Promise<GoogleSource | null>;
  /** The location's Google calendars, oldest first, for server code only (the duplicate check, the picker, deletion). */
  googleSources(scope: OrgScope, locationId: string): Promise<GoogleSource[]>;
  /** How many Google calendars of the organization the connection reads. */
  countForConnection(scope: OrgScope, connectionId: string): Promise<number>;
  /**
   * Every Google calendar of the organization the connection reads, with their events (events, then calendars, then
   * events). Resolves the number of calendars deleted.
   */
  removeForConnection(scope: OrgScope, connectionId: string): Promise<number>;
  /** The connection's Google calendars in the organization are due at `now` (a reconnect heals them). Resolves how many. */
  markDueForConnection(scope: OrgScope, connectionId: string, now: Date): Promise<number>;
  /**
   * Stores the calendar, then its events (the first 2,000), as one replace. 'calendar_limit' when the location already
   * has 5, and nothing is stored. When the events are not switched in, the calendar is removed and the add throws.
   */
  add(scope: OrgScope, locationId: string, calendar: NewCalendar, parsed: ParsedCalendar, input: { createdBy: string; now: Date }): Promise<OwnerCalendarRecord | 'calendar_limit'>;
  /**
   * Replaces the calendar's events by generation (the first 2,000) and records the counts and the success. Not switched
   * when the calendar is gone, or when another replace switched it first: this one's rows are then deleted.
   */
  replaceEvents(scope: OrgScope, locationId: string, calendarId: string, parsed: ParsedCalendar, now: Date): Promise<ReplaceResult>;
  /**
   * "Refresh now"'s one per 5 minutes, safe against concurrent requests: one compare-and-set sets lastManualRefreshAt to
   * `now` on a link or a Google calendar whose last one is at least 5 minutes old, or that has none. False when another
   * request took it first, or the calendar is gone or a file.
   */
  claimManualRefresh(scope: OrgScope, locationId: string, calendarId: string, now: Date): Promise<boolean>;
  /** A failed refresh: its code and the attempt, counted. The events stay. False when the calendar is gone. */
  recordFailure(scope: OrgScope, locationId: string, calendarId: string, code: CalendarFailure, now: Date): Promise<boolean>;
  /**
   * The end of a refresh the loop claimed with the lease `leaseUntil`: the link is next due at `nextRefreshAt`, and the
   * lease is let go. False when the calendar is gone, or another claim holds it now (that refresh ends it instead).
   */
  releaseRefresh(scope: OrgScope, locationId: string, calendarId: string, input: { leaseUntil: Date; nextRefreshAt: Date }): Promise<boolean>;
  /** The calendar's events, then the calendar. False when it was not there. */
  remove(scope: OrgScope, locationId: string, calendarId: string): Promise<boolean>;
  /** One event of this location's calendar, by its stored uid, in the current generation; else null. */
  findEvent(scope: OrgScope, locationId: string, calendarId: string, uid: string): Promise<StoredEvent | null>;
  /**
   * The keyed events among `uids` of this location's calendar, in its current generation. Null when the calendar is
   * gone, or when a replace switched it while this read (the rows read may then be part deleted).
   */
  eventsByUid(scope: OrgScope, locationId: string, calendarId: string, uids: readonly string[]): Promise<EventsByUid | null>;
  /** The location's events overlapping [from, to] (inclusive dates), each calendar's current generation, by start. */
  eventsBetween(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<OwnerCalendarEvent[]>;
  /** As eventsBetween, the keyed events only, each with its calendar's kind and Google connection: never its label. */
  keyedEventsBetween(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<KeyedOwnerEvent[]>;
  /** Location deletion. Resolves the number of calendars deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number of calendars deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type SourceDoc = SourceFields & { _id: Types.ObjectId };

/** What googleSource and googleSources read: nothing a record shows. */
const SECRET_FIELDS = { _id: 1, googleConnectionId: 1, sealedAddress: 1 } as const;

function toCalendar(doc: SourceDoc): OwnerCalendarRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    kind: doc.kind,
    label: doc.label,
    host: doc.host,
    eventCount: doc.eventCount,
    skippedRepeating: doc.skippedRepeating,
    status: doc.status,
    lastSuccessAt: doc.lastSuccessAt,
    lastAttemptAt: doc.lastAttemptAt,
    nextRefreshAt: doc.nextRefreshAt,
    leaseUntil: doc.leaseUntil,
    consecutiveFailures: doc.consecutiveFailures,
    lastManualRefreshAt: doc.lastManualRefreshAt,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
  };
}

function storedEvent(row: EventFields): StoredEvent {
  return {
    uid: row.uid, title: row.title, startDate: row.startDate, endDate: row.endDate, startTime: row.startTime, endTime: row.endTime,
    keyed: row.keyed === true,
  };
}

function startKey(event: Pick<OwnerCalendarEvent, 'startDate' | 'startTime'>): string {
  return `${event.startDate} ${event.startTime ?? ''}`;
}

/** By start, stable: events starting together keep their calendars' order. */
function byStart<T extends Pick<OwnerCalendarEvent, 'startDate' | 'startTime'>>(events: T[]): T[] {
  return events.sort((a, b) => (startKey(a) < startKey(b) ? -1 : startKey(a) > startKey(b) ? 1 : 0));
}

export function createOwnerCalendarStore(connection: Connection): OwnerCalendarStore {
  const Source = calendarSourceModel(connection);
  const Event = calendarEventModel(connection);
  const ofLocation = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });
  const ofCalendar = (scope: OrgScope, locationId: string, calendarId: string) => ({
    ...ofLocation(scope, locationId), _id: new Types.ObjectId(calendarId),
  });
  const ofConnection = (scope: OrgScope, connectionId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), kind: 'google' as const, googleConnectionId: new Types.ObjectId(connectionId),
  });
  const googleSourceOf = (doc: Pick<SourceDoc, '_id' | 'googleConnectionId' | 'sealedAddress'>): GoogleSource | null =>
    doc.googleConnectionId === null || doc.sealedAddress === null ? null : {
      calendarId: doc._id.toHexString(), connectionId: doc.googleConnectionId.toHexString(), sealedCalendarId: doc.sealedAddress,
    };

  /**
   * Events, then calendars, then events again. A replace that switched before its calendar went had written all its
   * rows first, so the second pass deletes them; one that tries to switch later finds no calendar and deletes its own.
   */
  async function removeWhere(events: Record<string, unknown>, sources: Record<string, unknown>): Promise<number> {
    await Event.deleteMany(events);
    const { deletedCount } = await Source.deleteMany(sources);
    await Event.deleteMany(events);
    return deletedCount;
  }

  async function replaceEvents(scope: OrgScope, locationId: string, calendarId: string, parsed: ParsedCalendar, now: Date): Promise<ReplaceResult> {
    const key = ofCalendar(scope, locationId, calendarId);
    const reserved = await Source.findOneAndUpdate(key, { $inc: { reservedGeneration: 1 } }, { returnDocument: 'after' }).lean();
    if (reserved === null) return { switched: false };
    const previous = reserved.generation;
    const generation = reserved.reservedGeneration;
    const events = parsed.events.slice(0, MAX_EVENTS);
    const mine = { orgId: key.orgId, sourceId: key._id, generation };
    // The keyed uids of the generation this replace switches from, read before anything is written or deleted. If this
    // replace switches, that generation was still current, so its rows were all there.
    const hadUids = new Set(previous === 0 ? [] : (await Event.find(
      { orgId: key.orgId, sourceId: key._id, generation: previous, keyed: true }, { uid: 1 },
    ).lean()).map((row) => row.uid));
    if (events.length > 0) {
      await Event.insertMany(events.map((event) => ({
        ...mine, locationId: key.locationId, uid: event.uid, title: event.title, startDate: event.startDate,
        endDate: event.endDate, startTime: event.startTime, endTime: event.endTime, keyed: event.keyed,
      })));
    }
    const switched = await Source.updateOne({ ...key, generation: previous }, {
      $set: {
        generation, eventCount: events.length, skippedRepeating: parsed.skippedRepeating, status: 'ok', lastSuccessAt: now,
        lastAttemptAt: now, consecutiveFailures: 0,
      },
    });
    if (switched.modifiedCount !== 1) {
      await Event.deleteMany(mine);
      return { switched: false };
    }
    // Older only: a later replace may already be writing a newer generation.
    await Event.deleteMany({ orgId: key.orgId, sourceId: key._id, generation: trusted({ $lt: generation }) });
    const keptKeys = events.filter((event) => event.keyed && hadUids.has(event.uid)).length;
    return { switched: true, generation, keptKeys, hadKeys: hadUids.size };
  }

  /**
   * Each calendar of the location with its current generation's events overlapping the range (keyed ones only when
   * `keyed`). A replace that switched meanwhile may have deleted part of the generation just read: read again at its new one.
   */
  async function readBetween(scope: OrgScope, locationId: string, range: { from: string; to: string }, keyed: boolean) {
    const location = ofLocation(scope, locationId);
    const current = () => Source.find(location, { label: 1, kind: 1, googleConnectionId: 1, generation: 1 }).sort({ createdAt: 1, _id: 1 }).lean();
    const read = (sources: Awaited<ReturnType<typeof current>>) => Promise.all(sources.map((source) => Event.find({
      orgId: location.orgId, sourceId: source._id, generation: source.generation,
      startDate: trusted({ $lte: range.to }), endDate: trusted({ $gte: range.from }), ...(keyed ? { keyed: true } : {}),
    }).sort({ startDate: 1, _id: 1 }).lean()));
    let sources = await current();
    let rows = await read(sources);
    for (let attempt = 1; attempt < 3; attempt += 1) {
      const after = await current();
      const unchanged = sources.every((source) => after.some((each) => each._id.equals(source._id) && each.generation === source.generation));
      if (unchanged) break;
      sources = after;
      rows = await read(sources);
    }
    return sources.map((source, index) => ({ source, rows: rows[index] ?? [] }));
  }

  async function remove(scope: OrgScope, locationId: string, calendarId: string): Promise<boolean> {
    const key = ofCalendar(scope, locationId, calendarId);
    const events = { orgId: key.orgId, locationId: key.locationId, sourceId: key._id };
    return (await removeWhere(events, key)) === 1;
  }

  return {
    async list(scope, locationId) {
      const docs = await Source.find(ofLocation(scope, locationId)).sort({ createdAt: 1, _id: 1 }).lean();
      return docs.map(toCalendar);
    },
    async find(scope, locationId, calendarId) {
      const doc = await Source.findOne(ofCalendar(scope, locationId, calendarId)).lean();
      return doc === null ? null : toCalendar(doc);
    },
    async sealedAddress(scope, locationId, calendarId) {
      const doc = await Source.findOne({ ...ofCalendar(scope, locationId, calendarId), kind: 'link' }).lean();
      return doc?.sealedAddress ?? null;
    },
    async googleSource(scope, locationId, calendarId) {
      const doc = await Source.findOne({ ...ofCalendar(scope, locationId, calendarId), kind: 'google' }, SECRET_FIELDS).lean();
      return doc === null ? null : googleSourceOf(doc);
    },
    async googleSources(scope, locationId) {
      const docs = await Source.find({ ...ofLocation(scope, locationId), kind: 'google' }, SECRET_FIELDS).sort({ createdAt: 1, _id: 1 }).lean();
      return docs.flatMap((doc) => googleSourceOf(doc) ?? []);
    },
    countForConnection(scope, connectionId) {
      return Source.countDocuments(ofConnection(scope, connectionId));
    },
    async removeForConnection(scope, connectionId) {
      // Only the calendars found here go, each after its events, so no calendar leaves rows behind.
      const ids = (await Source.find(ofConnection(scope, connectionId), { _id: 1 }).lean()).map((doc) => doc._id);
      if (ids.length === 0) return 0;
      const orgId = new Types.ObjectId(scope.orgId);
      return removeWhere({ orgId, sourceId: trusted({ $in: ids }) }, { ...ofConnection(scope, connectionId), _id: trusted({ $in: ids }) });
    },
    async markDueForConnection(scope, connectionId, now) {
      return (await Source.updateMany(ofConnection(scope, connectionId), { $set: { nextRefreshAt: now } })).matchedCount;
    },
    async add(scope, locationId, calendar, parsed, input) {
      const location = ofLocation(scope, locationId);
      const taken = new Set(await Source.distinct('slot', location));
      const free = Array.from({ length: MAX_CALENDARS }, (_, slot) => slot).filter((slot) => !taken.has(slot));
      const fields: Omit<SourceDoc, 'slot'> = {
        _id: new Types.ObjectId(), ...location, kind: calendar.kind, label: calendar.label,
        sealedAddress: calendar.kind === 'file' ? null : calendar.sealedAddress,
        host: calendar.kind === 'link' ? calendar.host : null,
        googleConnectionId: calendar.kind === 'google' ? new Types.ObjectId(calendar.googleConnectionId) : null,
        generation: 0, reservedGeneration: 0, eventCount: 0, skippedRepeating: 0, status: 'ok',
        lastSuccessAt: null, lastAttemptAt: input.now,
        nextRefreshAt: calendar.kind === 'file' ? null : new Date(input.now.getTime() + REFRESH_INTERVAL_MS),
        leaseUntil: null, consecutiveFailures: 0, lastManualRefreshAt: null, createdBy: input.createdBy, createdAt: input.now,
      };
      let added: SourceDoc | null = null;
      for (const slot of free) {
        try {
          added = (await Source.create({ ...fields, slot })).toObject();
          break;
        } catch (err) {
          // Another add took this slot after it was read: try the next free one.
          if (!isDuplicateKeyError(err)) throw err;
        }
      }
      if (added === null) return 'calendar_limit';
      // If the events are not switched in (an error, or the calendar removed or refreshed meanwhile), the calendar goes
      // with every row written and the add fails, so it holds no slot and a retry adds it once. Only a crash before
      // that removal leaves the calendar empty, with no lastSuccessAt: removing it, or a link's next refresh, completes
      // the work.
      const calendarId = added._id.toHexString();
      let replaced = false;
      try {
        replaced = (await replaceEvents(scope, locationId, calendarId, parsed, input.now)).switched;
      } finally {
        if (!replaced) await remove(scope, locationId, calendarId);
      }
      if (!replaced) throw new Error('the calendar was removed or refreshed before its events were stored');
      return toCalendar({
        ...added, eventCount: Math.min(parsed.events.length, MAX_EVENTS), skippedRepeating: parsed.skippedRepeating, lastSuccessAt: input.now,
      });
    },
    replaceEvents,
    async claimManualRefresh(scope, locationId, calendarId, now) {
      const due = new Date(now.getTime() - MANUAL_REFRESH_INTERVAL_MS);
      const claimed = await Source.updateOne({
        ...ofCalendar(scope, locationId, calendarId), kind: trusted({ $in: ['link', 'google'] }),
        $or: [{ lastManualRefreshAt: null }, { lastManualRefreshAt: trusted({ $lte: due }) }],
      }, { $set: { lastManualRefreshAt: now } });
      return claimed.matchedCount === 1;
    },
    async recordFailure(scope, locationId, calendarId, code, now) {
      const recorded = await Source.updateOne(ofCalendar(scope, locationId, calendarId), {
        $set: { status: code, lastAttemptAt: now }, $inc: { consecutiveFailures: 1 },
      });
      return recorded.matchedCount === 1;
    },
    async releaseRefresh(scope, locationId, calendarId, input) {
      const released = await Source.updateOne({ ...ofCalendar(scope, locationId, calendarId), leaseUntil: input.leaseUntil }, {
        $set: { nextRefreshAt: input.nextRefreshAt, leaseUntil: null },
      });
      return released.matchedCount === 1;
    },
    remove,
    async findEvent(scope, locationId, calendarId, uid) {
      const key = ofCalendar(scope, locationId, calendarId);
      const source = await Source.findOne(key, { generation: 1 }).lean();
      if (source === null) return null;
      const row = await Event.findOne({ orgId: key.orgId, sourceId: key._id, generation: source.generation, uid }).lean();
      return row === null ? null : storedEvent(row);
    },
    async eventsByUid(scope, locationId, calendarId, uids) {
      const key = ofCalendar(scope, locationId, calendarId);
      const source = await Source.findOne(key, { generation: 1, eventCount: 1 }).lean();
      if (source === null) return null;
      const rows = uids.length === 0 ? [] : await Event.find({
        orgId: key.orgId, sourceId: key._id, generation: source.generation, keyed: true, uid: trusted({ $in: [...uids] }),
      }).lean();
      // A replace that switched meanwhile may have deleted part of what was just read.
      const after = await Source.findOne(key, { generation: 1 }).lean();
      if (after?.generation !== source.generation) return null;
      return { generation: source.generation, eventCount: source.eventCount, events: rows.map(storedEvent) };
    },
    async eventsBetween(scope, locationId, range) {
      const read = await readBetween(scope, locationId, range, false);
      return byStart(read.flatMap(({ source, rows }) => rows.map((row): OwnerCalendarEvent => ({
        calendarId: source._id.toHexString(), calendar: source.label, uid: row.uid, title: row.title, startDate: row.startDate,
        endDate: row.endDate, startTime: row.startTime, endTime: row.endTime,
      }))));
    },
    async keyedEventsBetween(scope, locationId, range) {
      const read = await readBetween(scope, locationId, range, true);
      return byStart(read.flatMap(({ source, rows }) => rows.map((row): KeyedOwnerEvent => ({
        ...storedEvent(row), calendarId: source._id.toHexString(), kind: source.kind,
        connectionId: source.googleConnectionId === null ? null : source.googleConnectionId.toHexString(),
      }))));
    },
    removeForLocation(scope, locationId) {
      const location = ofLocation(scope, locationId);
      return removeWhere(location, location);
    },
    removeForOrg(scope) {
      const org = { orgId: new Types.ObjectId(scope.orgId) };
      return removeWhere(org, org);
    },
  };
}
