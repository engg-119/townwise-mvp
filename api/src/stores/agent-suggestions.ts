// tw_agent_suggestions and tw_suggestion_passes (openspec change weekly-forecast-suggestions, spec 6.27): the notes and
// rule schedules TownwiseAI's weekly pass suggests for a location (lab/suggestions.ts), and the record that a location's
// week had its pass. A suggestion changes nothing until an org admin accepts it (handlers/weekly-suggestions.ts), which
// writes the note or rule with the suggestion's id, so a retried accept writes it once. Statuses: `open`, `accepted`,
// `dismissed`, and `expired` once its first date is today or past in the town (an open one past it is never listed).
// Every change of status is a compare-and-set (no transactions, D17). A pass row is inserted `running` before the call,
// unique on { orgId, locationId, week }, so a week makes at most one call per location, whatever passes overlap; it
// holds the call's reservation of the TownwiseAI month while it runs, and is then set to its outcome, which hands the
// reservation back in the same write, so it is settled once: by the pass, or, when the pass died, by the next pass that
// finds the row still `running` (resolveStalePass). Ids, dates, codes and counts only: no function here logs, and
// nothing copies a note's text, a rule's words or a why into an audit event.
//
// Three kinds came with owner-calendar events (openspec change calendar-event-suggestions, design decisions 3 and 4):
// `event`, a private event the weekly pass spotted on an owner calendar (its calendar id, the event's stored uid and its
// dates and hours in `event`, never its title), and the deterministic follow-ups `move` and `remove` of a note linked to
// an event that moved or went (`follow`). Their `content` is the note as it would be after accepting (for `remove`, the
// note as it is; for `event`, a private event of effect `unknown`), so expiry and listing read `content.startDate` as
// for the others, and their `why` is null: their words are written at read time. A follow-up holds `openFollowFor`
// (its note's id) only while open, under a unique partial index, so a note has at most one open follow-up; every change
// of status clears it. upsertFollow inserts one, or updates the open one in place by compare-and-set, and never makes
// again a change an org admin dismissed (same note, kind and target). A uid names a booking: nothing here logs it.
//
// Suggested closure rules (openspec change suggest-closure-rules, D46) share the collection: `source` is `file` (a file
// read, with its `fileId`) or `sales` (the sales history, with its `evidence`), absent on the weekly pass's rows (read as
// `weekly`). They carry a `closureKey` (agent/closure-suggestions.ts), unique per location in any status (a partial
// index), have no why (their origin is worded from `source`, `fileId` and `evidence`), and are open while their end is
// null or not before today in the town. Members decide them (handlers/rule-suggestions.ts). The three owner-calendar
// kinds carry no `source` either: they are neither a file's nor the sales history's, an org admin decides them in the
// weekly panel (handlers/weekly-suggestions.ts), and they list and expire by first date with the weekly pass's rows.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import { seasonSchema, type RuleSchedule, type RuleSeason } from './business-rules.ts';
import type { NoteContent, NoteDates } from './notes.ts';

export const AGENT_SUGGESTIONS_COLLECTION = 'tw_agent_suggestions';
export const SUGGESTION_PASSES_COLLECTION = 'tw_suggestion_passes';

export type SuggestionStatus = 'open' | 'accepted' | 'dismissed' | 'expired';
/** Who made a suggestion: the weekly pass (absent on its rows), a file read, or the sales history (D46). */
export type SuggestionSource = 'weekly' | 'file' | 'sales';
/** Rule suggestions a member decides (D46). */
export type RuleSuggestionSource = Exclude<SuggestionSource, 'weekly'>;

/** Why the sales history suggests a closed weekday: counts and one date only. */
export interface SalesEvidence {
  /** Counted days of the weekday with no sales, and all its counted days. */
  readonly noSalesCount: number;
  readonly weekdayCount: number;
  /** The last counted day of the weekday with sales (guests or net sales), or null when it had none. */
  readonly lastSalesDate: string | null;
}
/** How a location's weekly pass ended: still running (or died running), suggested some, none, budget spent, failed. */
export type SuggestionPassStatus = 'running' | 'suggested' | 'none' | 'budget' | 'failed';

/** An owner-calendar event an `event` suggestion spotted: its calendar's id, its stored uid, its dates and hours. */
export interface SuggestedEvent extends NoteDates {
  readonly calendarId: string;
  readonly uid: string;
}

/** A follow-up of a note linked to an owner-calendar event (calendar/follow-up.ts). */
export interface FollowUp {
  readonly noteId: string;
  readonly calendarId: string;
  readonly change: 'moved' | 'gone';
  /** The note's dates and hours, which were its link's, when the follow-up was made. */
  readonly from: NoteDates;
  /** The event's new dates and hours for a move; null when it is gone. */
  readonly to: NoteDates | null;
  /** The note's updatedAt when the follow-up was made or last updated: what an accept compares and sets on. */
  readonly noteUpdatedAt: Date;
}

/** What the weekly pass suggests today: a note, or a business rule with its words and schedule (D31). */
export type NoteOrRuleContent =
  | { readonly type: 'note'; readonly note: NoteContent }
  | { readonly type: 'rule'; readonly text: string; readonly schedule: RuleSchedule };

/** A follow-up's content: the note as accepting would leave it (as it is, for a removal). */
export type FollowContent =
  | { readonly type: 'move'; readonly note: NoteContent; readonly follow: FollowUp }
  | { readonly type: 'remove'; readonly note: NoteContent; readonly follow: FollowUp };

/** What a suggestion proposes: a note, a rule, a spotted owner-calendar event (as a note), or a follow-up. */
export type SuggestionContent =
  | NoteOrRuleContent
  | { readonly type: 'event'; readonly note: NoteContent; readonly event: SuggestedEvent }
  | FollowContent;

export type SuggestionType = SuggestionContent['type'];

/** What upsertFollow did: inserted one, updated the open one, found it already so, or found the change dismissed. */
export type FollowOutcome = 'made' | 'updated' | 'same' | 'dismissed';

interface ContentFields {
  kind: NoteContent['kind'];
  startDate: string;
  endDate: string | null;
  weekdays: number[] | null;
  effect: NoteContent['effect'];
  expectedGuests: number | null;
  detail: string | null;
  startTime: string | null;
  endTime: string | null;
  /** A rule schedule's yearly season (D46); absent otherwise. */
  season?: { repeat: 'yearly'; from: string; to: string };
}

interface DateFields {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
}

interface EventFields extends DateFields {
  calendarId: Types.ObjectId;
  uid: string;
}

interface FollowFields {
  noteId: Types.ObjectId;
  calendarId: Types.ObjectId;
  change: 'moved' | 'gone';
  from: DateFields;
  to: DateFields | null;
  noteUpdatedAt: Date;
}

interface SuggestionFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  /** The pass's week, or a follow-up's: the Monday, YYYY-MM-DD, in the town. */
  week: string;
  type: SuggestionType;
  /** A note's fields, or a rule's schedule (`detail` null, `endDate` null for no end). */
  content: ContentFields;
  /** A rule's words; null on a note. */
  text: string | null;
  /** TownwiseAI's one sentence on why, on a weekly `note` or `rule`; null on a file or sales row and on `event`, `move` and `remove`, whose words are written at read time. */
  why: string | null;
  /** On `event`: the owner-calendar event spotted. */
  event?: EventFields;
  /** On `move` and `remove`: the change to the linked note. */
  follow?: FollowFields;
  /** On an open `move` or `remove`: its note's id, unique among open follow-ups; cleared on every change of status. */
  openFollowFor?: Types.ObjectId;
  /** Absent on the weekly pass's rows and the owner-calendar kinds. */
  source?: RuleSuggestionSource;
  /** The file a file row was read from. */
  fileId?: Types.ObjectId;
  /** A sales row's evidence. */
  evidence?: { noSalesCount: number; weekdayCount: number; lastSalesDate: string | null };
  /** File and sales rows only: one per key at a location, in any status. */
  closureKey?: string;
  /** The town calendar entries it rests on. */
  calendarIds: string[];
  status: SuggestionStatus;
  /** Who accepted or dismissed it; null while open or expired, and once that person is deleted. */
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PassFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  week: string;
  status: SuggestionPassStatus;
  /** Suggestions kept and stored. */
  suggested: number;
  /** What the running call reserved of the organization's TownwiseAI month, in micro-dollars; 0 once settled. */
  reservedMicroUsd?: number;
  /** The month (YYYY-MM, UTC) it was reserved in; null or absent before a reservation. */
  month?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function contentSchema(): Schema<ContentFields> {
  return new Schema<ContentFields>({
    kind: { type: String, required: true, enum: ['closure', 'private_event', 'opening', 'other'] },
    startDate: { type: String, required: true },
    endDate: { type: String, default: null },
    weekdays: { type: [Number], default: null },
    effect: { type: String, required: true, enum: ['closed', 'more_guests', 'fewer_guests', 'unknown'] },
    expectedGuests: { type: Number, default: null },
    detail: { type: String, default: null },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    season: { type: seasonSchema(), required: false },
  }, { _id: false, strict: 'throw', versionKey: false });
}

function dateSchema(): Schema<DateFields> {
  return new Schema<DateFields>({
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
  }, { _id: false, strict: 'throw', versionKey: false });
}

function suggestionSchema(): Schema<SuggestionFields> {
  const schema = new Schema<SuggestionFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    week: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    type: { type: String, required: true, enum: ['note', 'rule', 'event', 'move', 'remove'] },
    content: { type: contentSchema(), required: true },
    text: { type: String, default: null },
    // Required on a weekly `note` or `rule` only; a file or sales row, an `event`, a `move` and a `remove` have none.
    why: {
      type: String, maxlength: 400, default: null,
      required: function required(this: { source?: string; type?: string }) {
        return (this.source === undefined || this.source === 'weekly') && (this.type === 'note' || this.type === 'rule');
      },
    },
    event: {
      type: new Schema<EventFields>({
        calendarId: { type: Schema.Types.ObjectId, required: true },
        uid: { type: String, required: true, maxlength: 1_024 },
        startDate: { type: String, required: true },
        endDate: { type: String, required: true },
        startTime: { type: String, default: null },
        endTime: { type: String, default: null },
      }, { _id: false, strict: 'throw', versionKey: false }),
    },
    follow: {
      type: new Schema<FollowFields>({
        noteId: { type: Schema.Types.ObjectId, required: true },
        calendarId: { type: Schema.Types.ObjectId, required: true },
        change: { type: String, required: true, enum: ['moved', 'gone'] },
        from: { type: dateSchema(), required: true },
        to: { type: dateSchema(), default: null },
        noteUpdatedAt: { type: Date, required: true },
      }, { _id: false, strict: 'throw', versionKey: false }),
    },
    openFollowFor: { type: Schema.Types.ObjectId },
    source: { type: String, enum: ['file', 'sales'] },
    fileId: { type: Schema.Types.ObjectId },
    evidence: {
      type: new Schema({
        noSalesCount: { type: Number, required: true, min: 0 },
        weekdayCount: { type: Number, required: true, min: 0 },
        lastSalesDate: { type: String, default: null },
      }, { _id: false, strict: 'throw', versionKey: false }),
    },
    closureKey: { type: String },
    calendarIds: { type: [String], default: [] },
    status: { type: String, required: true, enum: ['open', 'accepted', 'dismissed', 'expired'] },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  // The panel's list, the pass's duplicate check and expiry: by location, then status and first date.
  schema.index({ orgId: 1, locationId: 1, status: 1, 'content.startDate': 1 });
  // At most one open follow-up per note (design decision 3), as tw_calibrations.liveLocation holds one live calibration.
  schema.index({ openFollowFor: 1 }, { unique: true, partialFilterExpression: { openFollowFor: { $type: 'objectId' } } });
  // D46: one suggested closure rule per key at a location, in any status, so a dismissed one is never suggested again.
  schema.index({ orgId: 1, locationId: 1, closureKey: 1 }, { unique: true, partialFilterExpression: { closureKey: { $type: 'string' } } });
  return schema;
}

function passSchema(): Schema<PassFields> {
  const schema = new Schema<PassFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    week: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, required: true, enum: ['running', 'suggested', 'none', 'budget', 'failed'] },
    suggested: { type: Number, required: true, min: 0 },
    reservedMicroUsd: { type: Number, default: 0, min: 0 },
    month: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, week: 1 }, { unique: true });
  // The weekly worker's lookup of rows a dead pass left running (stores/cross-tenant.ts staleSuggestionPasses).
  schema.index({ status: 1, updatedAt: 1 });
  return schema;
}

/** Registers TwAgentSuggestion (tw_agent_suggestions) on first call. */
export function agentSuggestionModel(connection: Connection): Model<SuggestionFields> {
  const existing = connection.models.TwAgentSuggestion as Model<SuggestionFields> | undefined;
  return existing ?? connection.model<SuggestionFields>('TwAgentSuggestion', suggestionSchema(), AGENT_SUGGESTIONS_COLLECTION);
}

/** Registers TwSuggestionPass (tw_suggestion_passes) on first call. */
export function suggestionPassModel(connection: Connection): Model<PassFields> {
  const existing = connection.models.TwSuggestionPass as Model<PassFields> | undefined;
  return existing ?? connection.model<PassFields>('TwSuggestionPass', passSchema(), SUGGESTION_PASSES_COLLECTION);
}

export type SuggestionRecord = SuggestionContent & {
  readonly id: string;
  readonly locationId: string;
  readonly week: string;
  /** The first date it names (the note's or schedule's start); it expires once that is today or past in the town. */
  readonly firstDate: string;
  /** Null on a file or sales row, and on `event`, `move` and `remove`. */
  readonly why: string | null;
  readonly calendarIds: readonly string[];
  readonly status: SuggestionStatus;
  readonly createdAt: Date;
  /** Its last write: an accept of a follow-up compares and sets on it, so a refresh's rewrite is never accepted unseen. */
  readonly updatedAt: Date;
  readonly source: SuggestionSource;
  readonly fileId: string | null;
  readonly evidence: SalesEvidence | null;
  readonly closureKey: string | null;
};

/** A suggested closure rule to store (D46): a file or sales row, under a given id. */
export interface NewRuleSuggestion {
  readonly id: string;
  readonly locationId: string;
  /** The town's Monday of the day it was made. */
  readonly week: string;
  readonly source: RuleSuggestionSource;
  readonly text: string;
  readonly schedule: RuleSchedule;
  readonly closureKey: string;
  readonly fileId?: string;
  readonly evidence?: SalesEvidence;
  readonly now: Date;
}

export interface SuggestionPassRecord {
  readonly locationId: string;
  readonly week: string;
  readonly status: SuggestionPassStatus;
  readonly suggested: number;
}

/** A reservation a pass row held when it was settled: what to hand back to which month. */
export interface HeldReservation {
  readonly month: string;
  readonly microUsd: number;
}

export interface NewSuggestion {
  readonly content: SuggestionContent;
  /** Set on `note` and `rule`; null on the other kinds. */
  readonly why: string | null;
  readonly calendarIds: readonly string[];
}

/** At most this many of a location's suggestions are read back for the duplicate check, newest first. */
const RECENT_LIMIT = 500;

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface AgentSuggestionStore {
  /** Inserts the location's pass row for the week as `running`; false when the week already has one. */
  claimPass(scope: OrgScope, input: { locationId: string; week: string; now: Date }): Promise<boolean>;
  /** Records on the running pass row the reservation its call made; false when the row is no longer running. */
  holdReservation(scope: OrgScope, input: { locationId: string; week: string; month: string; microUsd: number; now: Date }): Promise<boolean>;
  /**
   * Sets a running pass's outcome (a compare-and-set from `running`) and settles its reservation in the same write.
   * Resolves the reservation it held (`microUsd` 0 when none), or null when the row was no longer running (a later
   * pass resolved it and handed the reservation back).
   */
  finishPass(scope: OrgScope, input: {
    locationId: string; week: string; status: Exclude<SuggestionPassStatus, 'running'>; suggested: number; now: Date;
  }): Promise<HeldReservation | null>;
  /**
   * A row still `running` since before `before` (its pass died): one that held a reservation becomes `failed`, which
   * resolves the reservation to hand back; one that held none (no call was made) is removed, so the week can still run,
   * and resolves `{ microUsd: 0 }`. Null when it is no longer running and stale (a compare-and-set, so it settles once).
   */
  resolveStalePass(scope: OrgScope, input: { locationId: string; week: string; before: Date; now: Date }): Promise<HeldReservation | null>;
  /**
   * Removes a running pass row whose call failed before it reported anything (it cost nothing), so a later pass that
   * week makes it. Resolves the reservation it held to hand back, or null when it was no longer running (a compare-and-set).
   */
  releasePass(scope: OrgScope, input: { locationId: string; week: string }): Promise<HeldReservation | null>;
  findPass(scope: OrgScope, locationId: string, week: string): Promise<SuggestionPassRecord | null>;
  /** Stores a pass's kept suggestions, each `open`. */
  insert(scope: OrgScope, input: { locationId: string; week: string; suggestions: readonly NewSuggestion[]; now: Date }): Promise<SuggestionRecord[]>;
  /**
   * D46: a file or sales suggestion under its given id. `created` false: a row with the id was there (a retry wrote
   * it). Null when another row holds its closure key (in any status).
   */
  insertOne(scope: OrgScope, input: NewRuleSuggestion): Promise<{ readonly record: SuggestionRecord; readonly created: boolean } | null>;
  /** The open weekly suggestions whose first date is after `today`, soonest first (never a file or sales row). */
  listOpen(scope: OrgScope, locationId: string, today: string): Promise<SuggestionRecord[]>;
  /** D46: the open file and sales suggestions whose end is null or not before `today`, oldest first. */
  listOpenRules(scope: OrgScope, locationId: string, today: string): Promise<SuggestionRecord[]>;
  /** D46: the row holding this closure key at the location, in any status, else null. */
  findByKey(scope: OrgScope, locationId: string, closureKey: string): Promise<SuggestionRecord | null>;
  /** D46: the open suggestions a file's read made. */
  openFromFile(scope: OrgScope, locationId: string, fileId: string): Promise<SuggestionRecord[]>;
  /** D46: deletes one file or sales suggestion while it is open (a compare-and-set); false otherwise. */
  removeOpen(scope: OrgScope, locationId: string, id: string): Promise<boolean>;
  /** D46: a sales delete, the location's sales suggestions that are not accepted. Resolves the number deleted. */
  removeSalesUndecided(scope: OrgScope, locationId: string): Promise<number>;
  /**
   * The location's `note` and `rule` suggestions in any status, newest first (at most 500): what a pass must not suggest
   * again. The owner-calendar kinds are left out, so follow-ups and spotted events never crowd earlier notes out of it.
   */
  recent(scope: OrgScope, locationId: string): Promise<SuggestionRecord[]>;
  /** One suggestion of this location, else null (another location's or organization's id included). */
  find(scope: OrgScope, locationId: string, id: string): Promise<SuggestionRecord | null>;
  /**
   * Open (or dismissed, when a dismiss raced an accept that had already written its note) to accepted. False when it
   * is already accepted, expired or gone. With `updatedAt`, only while its last write is still that one (a follow-up
   * a refresh rewrote since the accept read it stays as it is); with `orExpired` (the accept's own note write landed),
   * also from expired, whatever its last write.
   */
  markAccepted(scope: OrgScope, locationId: string, id: string, input: { by: string; now: Date; updatedAt?: Date; orExpired?: boolean }): Promise<boolean>;
  /** Open to dismissed; false otherwise. */
  markDismissed(scope: OrgScope, locationId: string, id: string, input: { by: string; now: Date }): Promise<boolean>;
  /**
   * To expired: open weekly suggestions whose first date is `today` or past, and open file and sales suggestions whose
   * end is before `today` (an ongoing one never). Resolves the number changed.
   */
  expire(scope: OrgScope, locationId: string, today: string, now: Date): Promise<number>;
  /** One open suggestion to expired (what it rests on is gone); false otherwise. */
  markExpired(scope: OrgScope, locationId: string, id: string, now: Date): Promise<boolean>;
  /**
   * A follow-up for its note: 'dismissed' (and the note's open follow-up, if any, expired) when an org admin dismissed
   * this change before; else inserts one, `open`, with `week` the town's Monday of `today` ('made'), or updates the
   * note's open one in place by compare-and-set ('updated'), or finds it already so ('same').
   */
  upsertFollow(scope: OrgScope, locationId: string, content: FollowContent, input: { today: string; now: Date }): Promise<FollowOutcome>;
  /** The note's open follow-up, if any, to expired. False when it had none. */
  expireFollow(scope: OrgScope, locationId: string, noteId: string, now: Date): Promise<boolean>;
  /** The owner-calendar events the location's `event` suggestions name, in any status (at most 500, newest first). */
  eventKeysSuggested(scope: OrgScope, locationId: string): Promise<{ calendarId: string; uid: string }[]>;
  /** Location deletion: its suggestions and pass rows. Resolves the number of suggestions deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** A pass whose location was deleted while it ran: the week's pass row and the suggestions it stored. */
  removeForPass(scope: OrgScope, locationId: string, week: string): Promise<void>;
  /** Organization deletion. Resolves the number of suggestions deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type SuggestionDoc = SuggestionFields & { _id: Types.ObjectId };

function datesOf(fields: DateFields): NoteDates {
  return { startDate: fields.startDate, endDate: fields.endDate, startTime: fields.startTime, endTime: fields.endTime };
}

function dateFields(dates: NoteDates): DateFields {
  return { startDate: dates.startDate, endDate: dates.endDate, startTime: dates.startTime, endTime: dates.endTime };
}

function followOf(fields: FollowFields): FollowUp {
  return {
    noteId: fields.noteId.toHexString(), calendarId: fields.calendarId.toHexString(), change: fields.change, from: datesOf(fields.from),
    to: fields.to === null ? null : datesOf(fields.to), noteUpdatedAt: fields.noteUpdatedAt,
  };
}

function followFields(follow: FollowUp): FollowFields {
  return {
    noteId: new Types.ObjectId(follow.noteId), calendarId: new Types.ObjectId(follow.calendarId), change: follow.change,
    from: dateFields(follow.from), to: follow.to === null ? null : dateFields(follow.to), noteUpdatedAt: follow.noteUpdatedAt,
  };
}

function seasonOf(season: ContentFields['season']): { season?: RuleSeason } {
  return season === undefined ? {} : { season: { repeat: 'yearly', from: season.from, to: season.to } };
}

/** A row's content. Every write of an `event`, `move` or `remove` sets its sub-document (contentFields). */
function contentOf(doc: SuggestionDoc): SuggestionContent {
  const c = doc.content;
  const shared = { kind: c.kind, startDate: c.startDate, weekdays: c.weekdays, effect: c.effect, expectedGuests: c.expectedGuests, startTime: c.startTime, endTime: c.endTime };
  if (doc.type === 'rule') return { type: 'rule', text: doc.text ?? '', schedule: { ...shared, endDate: c.endDate, ...seasonOf(c.season) } };
  const note: NoteContent = { ...shared, endDate: c.endDate ?? c.startDate, detail: c.detail };
  if (doc.type === 'event' && doc.event !== undefined) {
    const { event } = doc;
    return { type: 'event', note, event: { calendarId: event.calendarId.toHexString(), uid: event.uid, ...datesOf(event) } };
  }
  if ((doc.type === 'move' || doc.type === 'remove') && doc.follow !== undefined) return { type: doc.type, note, follow: followOf(doc.follow) };
  if (doc.type === 'note') return { type: 'note', note };
  throw new Error(`suggestion ${doc._id.toHexString()} of type ${doc.type} has no ${doc.type === 'event' ? 'event' : 'follow'}`);
}

function toSuggestion(doc: SuggestionDoc): SuggestionRecord {
  const c = doc.content;
  const content = contentOf(doc);
  return {
    ...content,
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    week: doc.week,
    firstDate: c.startDate,
    why: doc.why ?? null,
    calendarIds: doc.calendarIds,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    source: doc.source ?? 'weekly',
    fileId: doc.fileId?.toHexString() ?? null,
    evidence: doc.evidence === undefined ? null
      : { noSalesCount: doc.evidence.noSalesCount, weekdayCount: doc.evidence.weekdayCount, lastSalesDate: doc.evidence.lastSalesDate ?? null },
    closureKey: doc.closureKey ?? null,
  };
}

function contentFields(content: SuggestionContent): Pick<SuggestionFields, 'type' | 'content' | 'text' | 'event' | 'follow'> {
  if (content.type !== 'rule') {
    const n = content.note;
    const fields = {
      text: null,
      content: {
        kind: n.kind, startDate: n.startDate, endDate: n.endDate, weekdays: n.weekdays === null ? null : [...n.weekdays], effect: n.effect,
        expectedGuests: n.expectedGuests, detail: n.detail, startTime: n.startTime, endTime: n.endTime,
      },
    };
    if (content.type === 'event') {
      const { event } = content;
      return { type: 'event', ...fields, event: { calendarId: new Types.ObjectId(event.calendarId), uid: event.uid, ...dateFields(event) } };
    }
    if (content.type === 'note') return { type: 'note', ...fields };
    return { type: content.type, ...fields, follow: followFields(content.follow) };
  }
  const s = content.schedule;
  return {
    type: 'rule', text: content.text,
    content: {
      kind: s.kind, startDate: s.startDate, endDate: s.endDate, weekdays: s.weekdays === null ? null : [...s.weekdays], effect: s.effect,
      expectedGuests: s.expectedGuests, detail: null, startTime: s.startTime, endTime: s.endTime,
      ...(s.season === undefined || s.season === null ? {} : { season: { repeat: 'yearly', from: s.season.from, to: s.season.to } }),
    },
  };
}

/** The Monday of the week `day` (YYYY-MM-DD) falls in. */
function mondayOf(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  return utcDay(at, -((at.getUTCDay() + 6) % 7));
}

/** Same dates and hours (a null target is a removal's). */
function sameDates(a: NoteDates | null, b: NoteDates | null): boolean {
  if (a === null || b === null) return a === b;
  return a.startDate === b.startDate && a.endDate === b.endDate && a.startTime === b.startTime && a.endTime === b.endTime;
}

/** A compare-and-set lost to a concurrent run this many times gives up: a later refresh recomputes from stored state. */
const FOLLOW_ATTEMPTS = 3;
/** The weekly pass's rows carry no source. */
const weeklyRows = () => ({ source: trusted({ $exists: false }) });
/** File and sales rows (D46). */
const ruleRows = () => ({ source: trusted({ $in: ['file', 'sales'] satisfies RuleSuggestionSource[] }) });
/** A file or sales row (D46) with no end, or an end not before `today` (a null end is never less than a date). */
const live = (today: string) => ({ 'content.endDate': trusted({ $not: { $lt: today } }) });

export function createAgentSuggestionStore(connection: Connection): AgentSuggestionStore {
  const Suggestion = agentSuggestionModel(connection);
  const Pass = suggestionPassModel(connection);
  const of = (scope: OrgScope, locationId: string) => ({ orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId) });
  const one = (scope: OrgScope, locationId: string, id: string) => ({ ...of(scope, locationId), _id: new Types.ObjectId(id) });
  async function expireFollow(scope: OrgScope, locationId: string, noteId: string, now: Date): Promise<boolean> {
    const result = await Suggestion.updateOne(
      { ...of(scope, locationId), openFollowFor: new Types.ObjectId(noteId), status: 'open' },
      { $set: { status: 'expired', updatedAt: now }, $unset: { openFollowFor: '' } },
    );
    return result.modifiedCount === 1;
  }
  return {
    async claimPass(scope, input) {
      try {
        await Pass.create({ ...of(scope, input.locationId), week: input.week, status: 'running', suggested: 0, createdAt: input.now, updatedAt: input.now });
        return true;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },
    async holdReservation(scope, input) {
      const result = await Pass.updateOne(
        { ...of(scope, input.locationId), week: input.week, status: 'running' },
        { $set: { reservedMicroUsd: input.microUsd, month: input.month, updatedAt: input.now } },
      );
      return result.modifiedCount === 1;
    },
    async finishPass(scope, input) {
      const before = await Pass.findOneAndUpdate(
        { ...of(scope, input.locationId), week: input.week, status: 'running' },
        { $set: { status: input.status, suggested: input.suggested, reservedMicroUsd: 0, updatedAt: input.now } },
        { returnDocument: 'before' },
      ).lean();
      return before === null ? null : { month: before.month ?? '', microUsd: before.reservedMicroUsd ?? 0 };
    },
    async resolveStalePass(scope, input) {
      const stale = { ...of(scope, input.locationId), week: input.week, status: 'running' as const, updatedAt: trusted({ $lt: input.before }) };
      const bare = await Pass.deleteOne({ ...stale, reservedMicroUsd: trusted({ $in: [0, null] }) });
      if (bare.deletedCount === 1) return { month: '', microUsd: 0 };
      const before = await Pass.findOneAndUpdate(
        stale, { $set: { status: 'failed', reservedMicroUsd: 0, updatedAt: input.now } }, { returnDocument: 'before' },
      ).lean();
      return before === null ? null : { month: before.month ?? '', microUsd: before.reservedMicroUsd ?? 0 };
    },
    async releasePass(scope, input) {
      const before = await Pass.findOneAndDelete({ ...of(scope, input.locationId), week: input.week, status: 'running' }).lean();
      return before === null ? null : { month: before.month ?? '', microUsd: before.reservedMicroUsd ?? 0 };
    },
    async findPass(scope, locationId, week) {
      const doc = await Pass.findOne({ ...of(scope, locationId), week }).lean();
      return doc === null ? null : { locationId, week: doc.week, status: doc.status, suggested: doc.suggested };
    },
    async insert(scope, input) {
      if (input.suggestions.length === 0) return [];
      const docs = await Suggestion.insertMany(input.suggestions.map((suggestion) => ({
        ...of(scope, input.locationId), week: input.week, ...contentFields(suggestion.content), why: suggestion.why,
        calendarIds: [...suggestion.calendarIds], status: 'open', decidedBy: null, decidedAt: null, createdAt: input.now, updatedAt: input.now,
      })));
      return docs.map((doc) => toSuggestion(doc.toObject<SuggestionDoc>()));
    },
    async insertOne(scope, input) {
      const id = new Types.ObjectId(input.id);
      try {
        const doc = await Suggestion.create({
          _id: id, ...of(scope, input.locationId), week: input.week, ...contentFields({ type: 'rule', text: input.text, schedule: input.schedule }),
          why: null, calendarIds: [], status: 'open', decidedBy: null, decidedAt: null, createdAt: input.now, updatedAt: input.now,
          source: input.source, closureKey: input.closureKey,
          ...(input.fileId === undefined ? {} : { fileId: new Types.ObjectId(input.fileId) }),
          ...(input.evidence === undefined ? {} : { evidence: { ...input.evidence } }),
        });
        return { record: toSuggestion(doc.toObject<SuggestionDoc>()), created: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const written = await Suggestion.findOne({ ...of(scope, input.locationId), _id: id }).lean();
        return written === null ? null : { record: toSuggestion(written), created: false };
      }
    },
    async listOpen(scope, locationId, today) {
      const docs = await Suggestion.find({ ...of(scope, locationId), ...weeklyRows(), status: 'open', 'content.startDate': trusted({ $gt: today }) })
        .sort({ 'content.startDate': 1, _id: 1 }).lean();
      return docs.map(toSuggestion);
    },
    async listOpenRules(scope, locationId, today) {
      const docs = await Suggestion.find({ ...of(scope, locationId), ...ruleRows(), status: 'open', ...live(today) })
        .sort({ createdAt: 1, _id: 1 }).lean();
      return docs.map(toSuggestion);
    },
    async findByKey(scope, locationId, closureKey) {
      const doc = await Suggestion.findOne({ ...of(scope, locationId), closureKey }).lean();
      return doc === null ? null : toSuggestion(doc);
    },
    async openFromFile(scope, locationId, fileId) {
      const docs = await Suggestion.find({ ...of(scope, locationId), source: 'file', fileId: new Types.ObjectId(fileId), status: 'open' })
        .sort({ _id: 1 }).lean();
      return docs.map(toSuggestion);
    },
    async removeOpen(scope, locationId, id) {
      const result = await Suggestion.deleteOne({ ...one(scope, locationId, id), ...ruleRows(), status: 'open' });
      return result.deletedCount === 1;
    },
    async removeSalesUndecided(scope, locationId) {
      return (await Suggestion.deleteMany({ ...of(scope, locationId), source: 'sales', status: trusted({ $ne: 'accepted' }) })).deletedCount;
    },
    async recent(scope, locationId) {
      const docs = await Suggestion.find({ ...of(scope, locationId), type: trusted({ $in: ['note', 'rule'] }) }).sort({ _id: -1 }).limit(RECENT_LIMIT).lean();
      return docs.map(toSuggestion);
    },
    async find(scope, locationId, id) {
      const doc = await Suggestion.findOne(one(scope, locationId, id)).lean();
      return doc === null ? null : toSuggestion(doc);
    },
    async markAccepted(scope, locationId, id, input) {
      const statuses: SuggestionStatus[] = ['open', 'dismissed'];
      const live = { status: trusted({ $in: statuses }), ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }) };
      const expired: { status: SuggestionStatus } = { status: 'expired' };
      const result = await Suggestion.updateOne(
        { ...one(scope, locationId, id), ...(input.orExpired === true ? { $or: [live, expired] } : live) },
        { $set: { status: 'accepted', decidedBy: input.by, decidedAt: input.now, updatedAt: input.now }, $unset: { openFollowFor: '' } },
      );
      return result.modifiedCount === 1;
    },
    async markDismissed(scope, locationId, id, input) {
      const result = await Suggestion.updateOne(
        { ...one(scope, locationId, id), status: 'open' },
        { $set: { status: 'dismissed', decidedBy: input.by, decidedAt: input.now, updatedAt: input.now }, $unset: { openFollowFor: '' } },
      );
      return result.modifiedCount === 1;
    },
    async expire(scope, locationId, today, now) {
      const ofWeek = await Suggestion.updateMany(
        { ...of(scope, locationId), ...weeklyRows(), status: 'open', 'content.startDate': trusted({ $lte: today }) },
        { $set: { status: 'expired', updatedAt: now }, $unset: { openFollowFor: '' } },
      );
      const ended = await Suggestion.updateMany(
        { ...of(scope, locationId), ...ruleRows(), status: 'open', 'content.endDate': trusted({ $type: 'string', $lt: today }) },
        { $set: { status: 'expired', updatedAt: now } },
      );
      return ofWeek.modifiedCount + ended.modifiedCount;
    },
    async markExpired(scope, locationId, id, now) {
      const result = await Suggestion.updateOne(
        { ...one(scope, locationId, id), status: 'open' }, { $set: { status: 'expired', updatedAt: now }, $unset: { openFollowFor: '' } },
      );
      return result.modifiedCount === 1;
    },
    async upsertFollow(scope, locationId, content, input) {
      const { follow } = content;
      const noteId = new Types.ObjectId(follow.noteId);
      const dismissed = await Suggestion.exists({
        ...of(scope, locationId), status: 'dismissed', type: content.type, 'follow.noteId': noteId,
        ...(follow.to === null ? {} : {
          'follow.to.startDate': follow.to.startDate, 'follow.to.endDate': follow.to.endDate,
          'follow.to.startTime': follow.to.startTime, 'follow.to.endTime': follow.to.endTime,
        }),
      });
      if (dismissed !== null) {
        await expireFollow(scope, locationId, follow.noteId, input.now);
        return 'dismissed';
      }
      const fields = { ...contentFields(content), week: mondayOf(input.today) };
      for (let attempt = 0; attempt < FOLLOW_ATTEMPTS; attempt += 1) {
        const open = await Suggestion.findOne({ ...of(scope, locationId), openFollowFor: noteId, status: 'open' }).lean();
        if (open === null) {
          try {
            await Suggestion.create({
              ...of(scope, locationId), ...fields, why: null, calendarIds: [], status: 'open', openFollowFor: noteId, decidedBy: null,
              decidedAt: null, createdAt: input.now, updatedAt: input.now,
            });
            return 'made';
          } catch (err) {
            // Another run made the note's open follow-up first: compare against it.
            if (!isDuplicateKeyError(err)) throw err;
            continue;
          }
        }
        const current = open.follow === undefined ? null : followOf(open.follow);
        if (open.type === content.type && current !== null && sameDates(current.to, follow.to)
          && current.noteUpdatedAt.getTime() === follow.noteUpdatedAt.getTime()) return 'same';
        const updated = await Suggestion.updateOne(
          { _id: open._id, openFollowFor: noteId, status: 'open', type: open.type, updatedAt: open.updatedAt },
          { $set: { ...fields, updatedAt: input.now } },
        );
        if (updated.modifiedCount === 1) return 'updated';
      }
      // Lost every race: the runs that won wrote the note's open follow-up, and the next refresh recomputes it.
      return 'same';
    },
    expireFollow,
    async eventKeysSuggested(scope, locationId) {
      const docs = await Suggestion.find({ ...of(scope, locationId), type: 'event' }, { event: 1 }).sort({ _id: -1 }).limit(RECENT_LIMIT).lean();
      return docs.flatMap((doc) => (doc.event === undefined ? [] : [{ calendarId: doc.event.calendarId.toHexString(), uid: doc.event.uid }]));
    },
    async removeForLocation(scope, locationId) {
      await Pass.deleteMany(of(scope, locationId));
      return (await Suggestion.deleteMany(of(scope, locationId))).deletedCount;
    },
    async removeForPass(scope, locationId, week) {
      await Suggestion.deleteMany({ ...of(scope, locationId), week });
      await Pass.deleteMany({ ...of(scope, locationId), week });
    },
    async removeForOrg(scope) {
      const org = { orgId: new Types.ObjectId(scope.orgId) };
      await Pass.deleteMany(org);
      return (await Suggestion.deleteMany(org)).deletedCount;
    },
  };
}
