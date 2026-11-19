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
// range's keyed events for TownwiseAI's weekly call (lab/suggestions.ts), with each calendar's kind, Google connection
// and whether a file's or link's add showed the weekly notice (`titlesNotice`), never its label.
//
// Booking labels (openspec change learn-from-calendar-bookings, D58, design decisions 6, 7 and 9): a file calendar keeps
// its `format` (`csv`, or `ics` when absent) and, once sorted, labeled or confirmed, `bookings` (its state, when it was
// sorted, and when and by whom it was confirmed); each of its rows may keep a `booking` label with who set it (`ai` or
// `person`) and when. A file is never re-read, so its rows are never replaced and its labels last. setLabels writes the
// AI's only on rows no one has labeled (a person's label, a cleared one included, is never overwritten), setLabel a
// person's, and confirmBookings marks the calendar confirmed by compare-and-set. bookingsBetween reads the confirmed
// calendars' buyout and party rows as dates and label only, never a title or uid, for the lab input (lab/input.ts). A
// label is not a customer's data but sits on a row whose title is, so it follows the title's rules: never logged.
//
// A calendar file kept in Your data (D60) is imported as a file calendar that keeps `fromFileId`, the tw_files row it
// came from, under a unique index on (orgId, fromFileId): the same stored file is never imported twice, also when two
// imports race (the second insert is refused, and its add answers 'file_imported'). Removing the calendar leaves the
// file, and deleting the file leaves the calendar, whose fromFileId then names no file.
//
// Sorting on import (D59 slice 2, openspec change auto-apply-agent-reads design decisions 3 and 10): a file calendar
// imported while TownwiseAI works on its own keeps `autoSort`, its one automatic sort's queue entry (queued, then
// sorting under a lease the TownwiseAI reader's loop renews, then done, skipped or failed), beside `bookings` rather than
// in it, since an absent `bookings` is what the compare-and-sets above read as unsorted. queueAutoSort sets it once
// (never again, so a calendar is sorted on its own at most once); the claim is stores/cross-tenant.ts
// claimNextCalendarSort. TownwiseAI's labels then carry the sort's planned time as their bookingAt, so clearAiLabels
// (Undo per calendar) removes exactly those still unchanged, and unconfirmBy takes back a confirm TownwiseAI made.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { MAX_EVENTS, MAX_TITLE_CHARS, type IcsEvent } from '../calendar/ics.ts';
import { WEEKLY_TITLES_NOTICE } from '../calendar/titles-notice.ts';

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

/** A file calendar event's booking label (D58): only `buyout` and `party` change a forecast, once confirmed. */
export const BOOKINGS = ['buyout', 'party', 'own_event', 'other'] as const;
export type Booking = typeof BOOKINGS[number];
/** Who set a label: TownwiseAI's sort, or a person (whose label, or cleared label, the sort never overwrites). */
export type BookingBy = 'ai' | 'person';

/** D59: where a file calendar's automatic sort is. */
export type AutoSortStatus = 'queued' | 'sorting' | 'done' | 'skipped' | 'failed';

/** A file calendar's bookings: `unsorted` until a sort or a person's label, then `sorted`, then `confirmed` (Use for forecasts). */
export type BookingsState = 'unsorted' | 'sorted' | 'confirmed';

/** How many of a file calendar's events carry each label, and how many none. */
export interface BookingCounts {
  readonly buyout: number;
  readonly party: number;
  readonly own_event: number;
  readonly other: number;
  readonly unlabeled: number;
}

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
  /**
   * 1 when a file or link was added from the popover that says TownwiseAI reads its titles weekly (WEEKLY_TITLES_NOTICE,
   * calendar-event-suggestions design decision 11); absent otherwise, and never cleared.
   */
  titlesNotice?: number;
  /** A file's format (D58); absent reads `ics`. Never set on a link or a Google calendar. */
  format?: 'ics' | 'csv';
  /** A file calendar's bookings once sorted, labeled or confirmed (D58); absent reads unsorted. */
  bookings?: StoredBookings;
  /** D60: the stored file (tw_files) a file calendar was imported from in Your data; absent otherwise. */
  fromFileId?: Types.ObjectId;
  /** D59: a file calendar's automatic sort, queued on import while TownwiseAI works on its own; absent: never queued. */
  autoSort?: StoredAutoSort;
}

interface StoredAutoSort {
  status: AutoSortStatus;
  queuedAt: Date;
  /** A retry waits until this time. */
  notBefore: Date | null;
  /** The reader loop's claim, while sorting. */
  leaseUntil: Date | null;
  attempts: number;
  /** Why it was skipped or failed (a code); null otherwise. */
  reason: string | null;
  endedAt: Date | null;
  /**
   * The model's labels by uid, kept from the call until the end, so a retry writes them with no second call; absent
   * before the call and once it ended. Like a row's label, never logged.
   */
  labels?: { uid: string; booking: Booking }[];
}

interface StoredBookings {
  state: 'sorted' | 'confirmed';
  sortedAt?: Date | null;
  confirmedAt?: Date | null;
  /** The org admin who confirmed; null once that person is deleted (stores/cross-tenant.ts deletePersonRecords). */
  confirmedBy?: string | null;
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
  /** A file calendar row's booking label (D58); null when a person cleared it. Absent: never labeled. */
  booking?: Booking | null;
  bookingBy?: BookingBy;
  bookingAt?: Date;
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
    titlesNotice: { type: Number, enum: [WEEKLY_TITLES_NOTICE] },
    format: { type: String, enum: ['ics', 'csv'] },
    bookings: {
      type: new Schema<StoredBookings>({
        state: { type: String, required: true, enum: ['sorted', 'confirmed'] },
        sortedAt: { type: Date, default: null },
        confirmedAt: { type: Date, default: null },
        confirmedBy: { type: String, default: null },
      }, { _id: false, strict: 'throw' }),
      default: undefined,
    },
    fromFileId: { type: Schema.Types.ObjectId },
    autoSort: {
      type: new Schema<StoredAutoSort>({
        status: { type: String, required: true, enum: ['queued', 'sorting', 'done', 'skipped', 'failed'] },
        queuedAt: { type: Date, required: true },
        notBefore: { type: Date, default: null },
        leaseUntil: { type: Date, default: null },
        attempts: { type: Number, required: true },
        reason: { type: String, default: null },
        endedAt: { type: Date, default: null },
        labels: {
          type: [new Schema({ uid: { type: String, required: true }, booking: { type: String, required: true, enum: BOOKINGS } }, { _id: false, strict: 'throw' })],
          default: undefined,
        },
      }, { _id: false, strict: 'throw' }),
      default: undefined,
    },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, slot: 1 }, { unique: true });
  // D60: a stored file imports at most one calendar.
  schema.index({ orgId: 1, fromFileId: 1 }, { unique: true, partialFilterExpression: { fromFileId: { $type: 'objectId' } } });
  // D59: the TownwiseAI reader's claim of a queued automatic sort, across organizations (stores/cross-tenant.ts).
  schema.index({ 'autoSort.status': 1, 'autoSort.queuedAt': 1 }, { sparse: true });
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
    booking: { type: String, enum: [...BOOKINGS, null] },
    bookingBy: { type: String, enum: ['ai', 'person'] },
    bookingAt: { type: Date },
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
  /** A file's format (D58); null for a link or a Google calendar. */
  readonly format: 'ics' | 'csv' | null;
  /** A file calendar's bookings (D58); null for a link or a Google calendar. */
  readonly bookings: {
    readonly state: BookingsState;
    readonly sortedAt: Date | null;
    readonly confirmedAt: Date | null;
    readonly confirmedBy: string | null;
  } | null;
  /** D60: the stored file a file calendar was imported from in Your data; null otherwise. */
  readonly fromFileId: string | null;
  /** D59: a file calendar's automatic sort (its status, attempts and why it was skipped or failed); null when never queued. */
  readonly autoSort: { readonly status: AutoSortStatus; readonly attempts: number; readonly reason: string | null } | null;
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
  /** A file calendar event's label (D58), null for none (and for any other kind's event). */
  readonly booking: Booking | null;
  readonly bookingBy: BookingBy | null;
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
/** D59 slice 3: a keyed event a replace added or moved: its dates now (and, moved, its dates before too). */
export interface ChangedDates { readonly startDate: string; readonly endDate: string }

export type ReplaceResult =
  | { readonly switched: false }
  | {
    readonly switched: true; readonly generation: number; readonly keptKeys: number; readonly hadKeys: number;
    /**
     * D59 slice 3: the keyed events whose uid the replaced generation did not hold, or held at other dates or hours,
     * with their dates now, and a moved one's dates before too; empty for a calendar's first generation.
     */
    readonly changed: readonly ChangedDates[];
  };

/**
 * An add's replace: a new calendar's first generation (its reservedGeneration starts at 0, and no one else knows its id
 * until the add answers), with no generation before it.
 */
export const ADDED_REPLACE = { switched: true, generation: 1, keptKeys: 0, hadKeys: 0, changed: [] } as const satisfies ReplaceResult;

/**
 * A keyed event for the weekly suggestions call (lab/suggestions.ts): with its calendar's id, kind, whether its add
 * showed the weekly notice and, for a Google calendar, the connection that reads it (whose own record says whether its
 * connect showed the notice), so the call sends only calendars whose person was told. Never the calendar's label.
 */
export interface KeyedOwnerEvent extends StoredEvent {
  readonly calendarId: string;
  readonly kind: CalendarKind;
  /** The tw_google_connections row of a Google calendar; null for a file or a link. */
  readonly connectionId: string | null;
  /** A file or link added from the popover that showed the weekly notice; false for a Google calendar. */
  readonly titlesNotice: boolean;
  /** It carries a label on a confirmed calendar (D58): the weekly call leaves it out (design decision 13). */
  readonly labeled: boolean;
}

/** A file calendar's event with its label, for the sort's request and confirm's notes. */
export interface LabeledEvent extends StoredEvent {
  readonly booking: Booking | null;
  readonly bookingBy: BookingBy | null;
}

/** A confirmed calendar's buyout or party, as the lab input reads it: dates and label only, never a title or uid. */
export interface ConfirmedBooking {
  readonly startDate: string;
  /** Inclusive. */
  readonly endDate: string;
  readonly booking: 'buyout' | 'party';
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
 * and the connection that reads it. A file or link carries `titlesNotice: 1` when its add showed the weekly notice.
 */
export type NewCalendar =
  | { readonly kind: 'file'; readonly label: string; readonly titlesNotice?: typeof WEEKLY_TITLES_NOTICE; readonly format?: 'ics' | 'csv' }
  | { readonly kind: 'link'; readonly label: string; readonly sealedAddress: string; readonly host: string; readonly titlesNotice?: typeof WEEKLY_TITLES_NOTICE }
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
  /** D59 slice 5: the Google calendars of the organization the connection reads, as ids and their location's id. */
  listForConnection(scope: OrgScope, connectionId: string): Promise<{ id: string; locationId: string }[]>;
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
   * D60: add's file calendar made from a stored file (tw_files), which it keeps as `fromFileId`; 'file_imported' when a
   * calendar of that file already exists (also one another import stored meanwhile), and nothing is stored.
   */
  addFromFile(
    scope: OrgScope, locationId: string, fileId: string, calendar: NewCalendar & { kind: 'file' }, parsed: ParsedCalendar,
    input: { createdBy: string; now: Date },
  ): Promise<OwnerCalendarRecord | 'calendar_limit' | 'file_imported'>;
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
  /**
   * D58: a file calendar's current events, by start, with their labels; with `unlabeled`, only those no one labeled
   * (what a sort sends). Null for a missing calendar or one that is not a file.
   */
  labeledEvents(scope: OrgScope, locationId: string, calendarId: string, opts?: { unlabeled?: boolean }): Promise<LabeledEvent[] | null>;
  /**
   * D58: TownwiseAI's labels, each written only on a current row of this file calendar that no one has labeled, and the
   * calendar marked sorted with its sortedAt; a confirmed calendar that gained a label goes back to sorted, so no model
   * label trains a forecast before an admin confirms it. Resolves how many rows were labeled; null for a missing
   * calendar or one that is not a file.
   */
  setLabels(scope: OrgScope, locationId: string, calendarId: string, labels: readonly { uid: string; booking: Booking }[], now: Date): Promise<number | null>;
  /**
   * D58: a person's label on one current row of this file calendar (null clears it, and a sort still leaves it), and
   * the calendar marked sorted when it was unsorted. Resolves the row as it was before, or null when the calendar is
   * missing, not a file, or holds no such row.
   */
  setLabel(scope: OrgScope, locationId: string, calendarId: string, uid: string, booking: Booking | null, now: Date): Promise<LabeledEvent | null>;
  /**
   * D58: Use for forecasts, by compare-and-set: the file calendar's bookings confirmed at `now` by `by` unless already
   * confirmed. 'confirmed' when this call confirmed it, 'already' when it was, null when the calendar is missing or not a file.
   */
  confirmBookings(scope: OrgScope, locationId: string, calendarId: string, input: { by: string; now: Date }): Promise<'confirmed' | 'already' | null>;
  /** D58: how many of each file calendar's current events carry each label, by calendar id; a link or Google calendar has none. */
  labelCounts(scope: OrgScope, locationId: string): Promise<Map<string, BookingCounts>>;
  /** D58: the location's confirmed file calendars' current buyout and party events overlapping [from, to], dates and label only. */
  bookingsBetween(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<ConfirmedBooking[]>;
  /** D59: queues a file calendar's one automatic sort, unless it was ever queued. False for any other kind, or a missing calendar. */
  queueAutoSort(scope: OrgScope, locationId: string, calendarId: string, now: Date): Promise<boolean>;
  /** D59: the reader loop's lease on a sort it claimed (attempt `attempt`), pushed to `until` while it still holds it. */
  renewSortLease(scope: OrgScope, calendarId: string, attempt: number, until: Date): Promise<boolean>;
  /** D59: a sort attempt that stopped goes back to the queue, to be claimed again from `notBefore`. */
  releaseSort(scope: OrgScope, calendarId: string, attempt: number, notBefore: Date): Promise<boolean>;
  /** D59: the end of a sort attempt still held, by compare-and-set. False when it was no longer held. */
  finishSort(scope: OrgScope, calendarId: string, attempt: number, input: { status: 'done' | 'skipped' | 'failed'; reason: string | null; at: Date }): Promise<boolean>;
  /** D59: the model's labels a sort attempt still holding it keeps until the sort ends. False when it was no longer held. */
  saveSortLabels(scope: OrgScope, calendarId: string, attempt: number, labels: readonly { uid: string; booking: Booking }[]): Promise<boolean>;
  /** D59: the labels a sort kept (saveSortLabels), or null when none are kept. */
  sortLabels(scope: OrgScope, calendarId: string): Promise<{ uid: string; booking: Booking }[] | null>;
  /** D59: how many current rows of the file calendar carry TownwiseAI's label set at `at`. */
  aiLabelCount(scope: OrgScope, locationId: string, calendarId: string, at: Date): Promise<number>;
  /**
   * D59: the current rows carrying TownwiseAI's label set at `at`: how many, and the first and last day of their buyouts
   * and parties (null with none). Null for a missing calendar or one that is not a file.
   */
  aiLabelFacts(scope: OrgScope, locationId: string, calendarId: string, at: Date): Promise<{ count: number; booked: { startDate: string; endDate: string } | null } | null>;
  /** D59: how many current rows of the file calendar carry a label (or a cleared label) not set by TownwiseAI at `at`. */
  otherLabelCount(scope: OrgScope, locationId: string, calendarId: string, at: Date): Promise<number>;
  /**
   * D59, Undo per calendar: a file calendar `sorted` whose current rows carry no label (nor a person's cleared label)
   * goes back to unsorted, as if never sorted. Resolves whether it did.
   */
  unsortIfUnlabeled(scope: OrgScope, locationId: string, calendarId: string, now: Date): Promise<boolean>;
  /**
   * D59, Undo per calendar: TownwiseAI's labels set at `at` that nobody changed since are cleared (the rows read as never
   * labeled again). Resolves how many; null for a missing calendar or one that is not a file.
   */
  clearAiLabels(scope: OrgScope, locationId: string, calendarId: string, at: Date): Promise<number | null>;
  /** D59: a confirm made by `by` taken back by compare-and-set: the calendar is sorted again, waiting for Use for forecasts. */
  unconfirmBy(scope: OrgScope, locationId: string, calendarId: string, by: string): Promise<boolean>;
  /** Location deletion. Resolves the number of calendars deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number of calendars deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type SourceDoc = SourceFields & { _id: Types.ObjectId };

/** What googleSource and googleSources read: nothing a record shows. */
const SECRET_FIELDS = { _id: 1, googleConnectionId: 1, sealedAddress: 1 } as const;

function bookingsOf(doc: Pick<SourceDoc, 'kind' | 'bookings'>): OwnerCalendarRecord['bookings'] {
  if (doc.kind !== 'file') return null;
  const stored = doc.bookings;
  return {
    state: stored?.state ?? 'unsorted', sortedAt: stored?.sortedAt ?? null, confirmedAt: stored?.confirmedAt ?? null,
    confirmedBy: stored?.confirmedBy ?? null,
  };
}

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
    format: doc.kind === 'file' ? doc.format ?? 'ics' : null,
    bookings: bookingsOf(doc),
    fromFileId: doc.fromFileId?.toHexString() ?? null,
    autoSort: doc.autoSort === undefined ? null : { status: doc.autoSort.status, attempts: doc.autoSort.attempts, reason: doc.autoSort.reason },
  };
}

function storedEvent(row: EventFields): StoredEvent {
  return {
    uid: row.uid, title: row.title, startDate: row.startDate, endDate: row.endDate, startTime: row.startTime, endTime: row.endTime,
    keyed: row.keyed === true,
  };
}

function labeledEvent(row: EventFields): LabeledEvent {
  return { ...storedEvent(row), booking: row.booking ?? null, bookingBy: row.bookingBy ?? null };
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
    const had = previous === 0 ? [] : await Event.find(
      { orgId: key.orgId, sourceId: key._id, generation: previous, keyed: true }, { uid: 1, startDate: 1, endDate: 1, startTime: 1, endTime: 1 },
    ).lean();
    const hadUids = new Set(had.map((row) => row.uid));
    const hadByUid = new Map(had.map((row) => [row.uid, row]));
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
    // D59 slice 3: what a refresh added or moved (a calendar's first generation changes nothing it had).
    const changed = previous === 0 ? [] : events.flatMap((event) => {
      if (!event.keyed) return [];
      const before = hadByUid.get(event.uid);
      const now = { startDate: event.startDate, endDate: event.endDate };
      if (before === undefined) return [now];
      const moved = before.startDate !== event.startDate || before.endDate !== event.endDate
        || (before.startTime ?? null) !== event.startTime || (before.endTime ?? null) !== event.endTime;
      return moved ? [now, { startDate: before.startDate, endDate: before.endDate }] : [];
    });
    return { switched: true, generation, keptKeys, hadKeys: hadUids.size, changed };
  }

  /**
   * Each calendar of the location with its current generation's events overlapping the range (keyed ones only when
   * `keyed`). A replace that switched meanwhile may have deleted part of the generation just read: read again at its new one.
   */
  async function readBetween(scope: OrgScope, locationId: string, range: { from: string; to: string }, keyed: boolean) {
    const location = ofLocation(scope, locationId);
    const current = () => Source.find(location, { label: 1, kind: 1, googleConnectionId: 1, generation: 1, createdAt: 1, titlesNotice: 1, bookings: 1 })
      .sort({ createdAt: 1, _id: 1 }).lean();
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

  /** A file calendar's key and the filter of its current rows, or null when it is missing or not a file. */
  async function fileRows(scope: OrgScope, locationId: string, calendarId: string) {
    const key = ofCalendar(scope, locationId, calendarId);
    const source = await Source.findOne({ ...key, kind: 'file' }, { generation: 1 }).lean();
    return source === null ? null : { key, rows: { orgId: key.orgId, sourceId: key._id, generation: source.generation } };
  }

  /** A sort this attempt claimed and still holds. */
  const heldSort = (scope: OrgScope, calendarId: string, attempt: number) => ({
    orgId: new Types.ObjectId(scope.orgId), _id: new Types.ObjectId(calendarId), 'autoSort.status': 'sorting' as const, 'autoSort.attempts': attempt,
  });

  /** Marks a file calendar sorted when it has no bookings yet; a sort also sets sortedAt, whatever its state. */
  async function markSorted(key: ReturnType<typeof ofCalendar>, now: Date, bySort: boolean): Promise<void> {
    const fresh = await Source.updateOne({ ...key, bookings: trusted({ $exists: false }) }, {
      $set: { bookings: { state: 'sorted', sortedAt: bySort ? now : null, confirmedAt: null, confirmedBy: null } },
    });
    if (bySort && fresh.modifiedCount === 0) await Source.updateOne(key, { $set: { 'bookings.sortedAt': now } });
  }

  async function remove(scope: OrgScope, locationId: string, calendarId: string): Promise<boolean> {
    const key = ofCalendar(scope, locationId, calendarId);
    const events = { orgId: key.orgId, locationId: key.locationId, sourceId: key._id };
    return (await removeWhere(events, key)) === 1;
  }

  /** add and addFromFile: the calendar, in a free slot, then its events; with `fromFileId`, a stored file's (D60). */
  async function insert(
    scope: OrgScope, locationId: string, calendar: NewCalendar, parsed: ParsedCalendar,
    input: { createdBy: string; now: Date; fromFileId: Types.ObjectId | null },
  ): Promise<OwnerCalendarRecord | 'calendar_limit' | 'file_imported'> {
    const location = ofLocation(scope, locationId);
    const { fromFileId } = input;
    const imported = async (): Promise<boolean> => fromFileId !== null && (await Source.exists({ orgId: location.orgId, fromFileId })) !== null;
    if (await imported()) return 'file_imported';
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
      ...(calendar.kind !== 'google' && calendar.titlesNotice === WEEKLY_TITLES_NOTICE ? { titlesNotice: WEEKLY_TITLES_NOTICE } : {}),
      ...(calendar.kind === 'file' && calendar.format !== undefined ? { format: calendar.format } : {}),
      ...(fromFileId === null ? {} : { fromFileId }),
    };
    let added: SourceDoc | null = null;
    for (const slot of free) {
      try {
        added = (await Source.create({ ...fields, slot })).toObject();
        break;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // Another import of the same stored file got there first (D60).
        if (await imported()) return 'file_imported';
        // Another add took this slot after it was read: try the next free one.
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
    async listForConnection(scope, connectionId) {
      const docs = await Source.find(ofConnection(scope, connectionId), { _id: 1, locationId: 1 }).lean();
      return docs.map((doc) => ({ id: doc._id.toHexString(), locationId: doc.locationId.toHexString() }));
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
      const added = await insert(scope, locationId, calendar, parsed, { ...input, fromFileId: null });
      if (added === 'file_imported') throw new Error('an add with no stored file answered file_imported');
      return added;
    },
    addFromFile(scope, locationId, fileId, calendar, parsed, input) {
      return insert(scope, locationId, calendar, parsed, { ...input, fromFileId: new Types.ObjectId(fileId) });
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
        booking: source.kind === 'file' ? row.booking ?? null : null, bookingBy: source.kind === 'file' ? row.bookingBy ?? null : null,
      }))));
    },
    async keyedEventsBetween(scope, locationId, range) {
      const read = await readBetween(scope, locationId, range, true);
      return byStart(read.flatMap(({ source, rows }) => rows.map((row): KeyedOwnerEvent => ({
        ...storedEvent(row), calendarId: source._id.toHexString(), kind: source.kind,
        connectionId: source.googleConnectionId === null ? null : source.googleConnectionId.toHexString(),
        titlesNotice: source.kind !== 'google' && source.titlesNotice === WEEKLY_TITLES_NOTICE,
        labeled: source.kind === 'file' && source.bookings?.state === 'confirmed' && (row.booking ?? null) !== null,
      }))));
    },
    async labeledEvents(scope, locationId, calendarId, opts) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return null;
      const rows = await Event.find({ ...file.rows, ...(opts?.unlabeled === true ? { bookingBy: trusted({ $exists: false }) } : {}) })
        .sort({ startDate: 1, _id: 1 }).lean();
      return byStart(rows.map(labeledEvent));
    },
    async setLabels(scope, locationId, calendarId, labels, now) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return null;
      let labeled = 0;
      if (labels.length > 0) {
        const written = await Event.bulkWrite(labels.map((label) => ({
          updateOne: {
            filter: { ...file.rows, uid: label.uid, bookingBy: trusted({ $exists: false }) },
            update: { $set: { booking: label.booking, bookingBy: 'ai' as const, bookingAt: now } },
          },
        })), { ordered: false });
        labeled = written.modifiedCount;
      }
      await markSorted(file.key, now, true);
      // New AI labels on a confirmed calendar wait for an admin again: it goes back to sorted until the next confirm.
      if (labeled > 0) await Source.updateOne({ ...file.key, 'bookings.state': 'confirmed' }, { $set: { 'bookings.state': 'sorted' } });
      return labeled;
    },
    async setLabel(scope, locationId, calendarId, uid, booking, now) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return null;
      const before = await Event.findOneAndUpdate(
        { ...file.rows, uid }, { $set: { booking, bookingBy: 'person', bookingAt: now } }, { returnDocument: 'before' },
      ).lean();
      if (before === null) return null;
      await markSorted(file.key, now, false);
      return labeledEvent(before);
    },
    async confirmBookings(scope, locationId, calendarId, input) {
      const key = { ...ofCalendar(scope, locationId, calendarId), kind: 'file' as const };
      // Unsorted (no bookings yet) or sorted: one compare-and-set each, so two confirms at once confirm once.
      const fresh = await Source.updateOne({ ...key, bookings: trusted({ $exists: false }) }, {
        $set: { bookings: { state: 'confirmed', sortedAt: null, confirmedAt: input.now, confirmedBy: input.by } },
      });
      if (fresh.modifiedCount === 1) return 'confirmed';
      const sorted = await Source.updateOne({ ...key, 'bookings.state': 'sorted' }, {
        $set: { 'bookings.state': 'confirmed', 'bookings.confirmedAt': input.now, 'bookings.confirmedBy': input.by },
      });
      if (sorted.modifiedCount === 1) return 'confirmed';
      return (await Source.exists({ ...key, 'bookings.state': 'confirmed' })) === null ? null : 'already';
    },
    async labelCounts(scope, locationId) {
      const location = ofLocation(scope, locationId);
      const files = await Source.find({ ...location, kind: 'file' }, { generation: 1 }).lean();
      const counts = new Map<string, BookingCounts>();
      await Promise.all(files.map(async (source) => {
        const groups = await Event.aggregate<{ _id: Booking | null; count: number }>([
          { $match: { orgId: location.orgId, sourceId: source._id, generation: source.generation } },
          { $group: { _id: { $ifNull: ['$booking', null] }, count: { $sum: 1 } } },
        ]);
        const of = (booking: Booking): number => groups.find((group) => group._id === booking)?.count ?? 0;
        const total = groups.reduce((sum, group) => sum + group.count, 0);
        const labeled = BOOKINGS.reduce((sum, booking) => sum + of(booking), 0);
        counts.set(source._id.toHexString(), {
          buyout: of('buyout'), party: of('party'), own_event: of('own_event'), other: of('other'), unlabeled: total - labeled,
        });
      }));
      return counts;
    },
    async bookingsBetween(scope, locationId, range) {
      const location = ofLocation(scope, locationId);
      const sources = await Source.find({ ...location, kind: 'file', 'bookings.state': 'confirmed' }, { generation: 1 }).lean();
      const rows = (await Promise.all(sources.map((source) => Event.find({
        orgId: location.orgId, sourceId: source._id, generation: source.generation, booking: trusted({ $in: ['buyout', 'party'] }),
        startDate: trusted({ $lte: range.to }), endDate: trusted({ $gte: range.from }),
      }, { startDate: 1, endDate: 1, booking: 1 }).lean()))).flat();
      return rows.flatMap((row): ConfirmedBooking[] => (row.booking === 'buyout' || row.booking === 'party'
        ? [{ startDate: row.startDate, endDate: row.endDate, booking: row.booking }] : []))
        .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
    },
    async queueAutoSort(scope, locationId, calendarId, now) {
      const queued = await Source.updateOne({ ...ofCalendar(scope, locationId, calendarId), kind: 'file', autoSort: trusted({ $exists: false }) }, {
        $set: { autoSort: { status: 'queued', queuedAt: now, notBefore: null, leaseUntil: null, attempts: 0, reason: null, endedAt: null } },
      });
      return queued.modifiedCount === 1;
    },
    async renewSortLease(scope, calendarId, attempt, until) {
      const renewed = await Source.updateOne(heldSort(scope, calendarId, attempt), { $set: { 'autoSort.leaseUntil': until } });
      return renewed.matchedCount === 1;
    },
    async releaseSort(scope, calendarId, attempt, notBefore) {
      const released = await Source.updateOne(heldSort(scope, calendarId, attempt), {
        $set: { 'autoSort.status': 'queued', 'autoSort.leaseUntil': null, 'autoSort.notBefore': notBefore },
      });
      return released.matchedCount === 1;
    },
    async finishSort(scope, calendarId, attempt, input) {
      const finished = await Source.updateOne(heldSort(scope, calendarId, attempt), {
        $set: { 'autoSort.status': input.status, 'autoSort.reason': input.reason, 'autoSort.leaseUntil': null, 'autoSort.endedAt': input.at },
        $unset: { 'autoSort.labels': 1 },
      });
      return finished.modifiedCount === 1;
    },
    async saveSortLabels(scope, calendarId, attempt, labels) {
      const saved = await Source.updateOne(heldSort(scope, calendarId, attempt), {
        $set: { 'autoSort.labels': labels.map((label) => ({ uid: label.uid, booking: label.booking })) },
      });
      return saved.matchedCount === 1;
    },
    async sortLabels(scope, calendarId) {
      const doc = await Source.findOne({ orgId: new Types.ObjectId(scope.orgId), _id: new Types.ObjectId(calendarId) }, { autoSort: 1 }).lean();
      const labels = doc?.autoSort?.labels;
      return labels === undefined ? null : labels.map((label) => ({ uid: label.uid, booking: label.booking }));
    },
    async aiLabelCount(scope, locationId, calendarId, at) {
      const file = await fileRows(scope, locationId, calendarId);
      return file === null ? 0 : Event.countDocuments({ ...file.rows, bookingBy: 'ai', bookingAt: at });
    },
    async aiLabelFacts(scope, locationId, calendarId, at) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return null;
      const ours = { ...file.rows, bookingBy: 'ai' as const, bookingAt: at };
      const [count, booked] = await Promise.all([
        Event.countDocuments(ours),
        Event.find({ ...ours, booking: trusted({ $in: ['buyout', 'party'] }) }, { startDate: 1, endDate: 1 }).lean(),
      ]);
      if (booked.length === 0) return { count, booked: null };
      return {
        count,
        booked: {
          startDate: booked.reduce((min, row) => (row.startDate < min ? row.startDate : min), booked[0]?.startDate ?? ''),
          endDate: booked.reduce((max, row) => (row.endDate > max ? row.endDate : max), booked[0]?.endDate ?? ''),
        },
      };
    },
    async otherLabelCount(scope, locationId, calendarId, at) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return 0;
      return Event.countDocuments({ ...file.rows, bookingBy: trusted({ $exists: true }), $nor: [{ bookingBy: 'ai', bookingAt: at }] });
    },
    async unsortIfUnlabeled(scope, locationId, calendarId, now) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return false;
      const labeled = { ...file.rows, bookingBy: trusted({ $exists: true }) };
      if ((await Event.exists(labeled)) !== null) return false;
      const unsorted = await Source.updateOne({ ...file.key, 'bookings.state': 'sorted' }, { $unset: { bookings: 1 } });
      if (unsorted.modifiedCount === 0) return false;
      // A person's label that landed meanwhile marks it sorted again.
      if ((await Event.exists(labeled)) !== null) await markSorted(file.key, now, false);
      return true;
    },
    async clearAiLabels(scope, locationId, calendarId, at) {
      const file = await fileRows(scope, locationId, calendarId);
      if (file === null) return null;
      const cleared = await Event.updateMany({ ...file.rows, bookingBy: 'ai', bookingAt: at }, { $unset: { booking: 1, bookingBy: 1, bookingAt: 1 } });
      return cleared.modifiedCount;
    },
    async unconfirmBy(scope, locationId, calendarId, by) {
      const taken = await Source.updateOne({ ...ofCalendar(scope, locationId, calendarId), kind: 'file', 'bookings.state': 'confirmed', 'bookings.confirmedBy': by }, {
        $set: { 'bookings.state': 'sorted', 'bookings.confirmedAt': null, 'bookings.confirmedBy': null },
      });
      return taken.modifiedCount === 1;
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
