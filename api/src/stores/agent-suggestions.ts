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
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { RuleSchedule } from './business-rules.ts';
import type { NoteContent } from './notes.ts';

export const AGENT_SUGGESTIONS_COLLECTION = 'tw_agent_suggestions';
export const SUGGESTION_PASSES_COLLECTION = 'tw_suggestion_passes';

export type SuggestionStatus = 'open' | 'accepted' | 'dismissed' | 'expired';
/** How a location's weekly pass ended: still running (or died running), suggested some, none, budget spent, failed. */
export type SuggestionPassStatus = 'running' | 'suggested' | 'none' | 'budget' | 'failed';

/** What a suggestion proposes: a note, or a business rule with its words and schedule (D31). */
export type SuggestionContent =
  | { readonly type: 'note'; readonly note: NoteContent }
  | { readonly type: 'rule'; readonly text: string; readonly schedule: RuleSchedule };

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
}

interface SuggestionFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  /** The pass's week: the Monday, YYYY-MM-DD, in the town. */
  week: string;
  type: 'note' | 'rule';
  /** A note's fields, or a rule's schedule (`detail` null, `endDate` null for no end). */
  content: ContentFields;
  /** A rule's words; null on a note. */
  text: string | null;
  /** TownwiseAI's one sentence on why. */
  why: string;
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
  }, { _id: false, strict: 'throw', versionKey: false });
}

function suggestionSchema(): Schema<SuggestionFields> {
  const schema = new Schema<SuggestionFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    week: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    type: { type: String, required: true, enum: ['note', 'rule'] },
    content: { type: contentSchema(), required: true },
    text: { type: String, default: null },
    why: { type: String, required: true, maxlength: 400 },
    calendarIds: { type: [String], default: [] },
    status: { type: String, required: true, enum: ['open', 'accepted', 'dismissed', 'expired'] },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  // The panel's list, the pass's duplicate check and expiry: by location, then status and first date.
  schema.index({ orgId: 1, locationId: 1, status: 1, 'content.startDate': 1 });
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
  readonly why: string;
  readonly calendarIds: readonly string[];
  readonly status: SuggestionStatus;
  readonly createdAt: Date;
};

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
  readonly why: string;
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
  /** The open suggestions whose first date is after `today`, soonest first. */
  listOpen(scope: OrgScope, locationId: string, today: string): Promise<SuggestionRecord[]>;
  /** The location's suggestions in any status, newest first (at most 500): what a pass must not suggest again. */
  recent(scope: OrgScope, locationId: string): Promise<SuggestionRecord[]>;
  /** One suggestion of this location, else null (another location's or organization's id included). */
  find(scope: OrgScope, locationId: string, id: string): Promise<SuggestionRecord | null>;
  /**
   * Open (or dismissed, when a dismiss raced an accept that had already written its note) to accepted. False when it
   * is already accepted, expired or gone.
   */
  markAccepted(scope: OrgScope, locationId: string, id: string, input: { by: string; now: Date }): Promise<boolean>;
  /** Open to dismissed; false otherwise. */
  markDismissed(scope: OrgScope, locationId: string, id: string, input: { by: string; now: Date }): Promise<boolean>;
  /** Open suggestions whose first date is `today` or past, to expired. Resolves the number changed. */
  expire(scope: OrgScope, locationId: string, today: string, now: Date): Promise<number>;
  /** Location deletion: its suggestions and pass rows. Resolves the number of suggestions deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** A pass whose location was deleted while it ran: the week's pass row and the suggestions it stored. */
  removeForPass(scope: OrgScope, locationId: string, week: string): Promise<void>;
  /** Organization deletion. Resolves the number of suggestions deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type SuggestionDoc = SuggestionFields & { _id: Types.ObjectId };

function toSuggestion(doc: SuggestionDoc): SuggestionRecord {
  const c = doc.content;
  const shared = { kind: c.kind, startDate: c.startDate, weekdays: c.weekdays, effect: c.effect, expectedGuests: c.expectedGuests, startTime: c.startTime, endTime: c.endTime };
  const content: SuggestionContent = doc.type === 'rule'
    ? { type: 'rule', text: doc.text ?? '', schedule: { ...shared, endDate: c.endDate } }
    : { type: 'note', note: { ...shared, endDate: c.endDate ?? c.startDate, detail: c.detail } };
  return {
    ...content,
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    week: doc.week,
    firstDate: c.startDate,
    why: doc.why,
    calendarIds: doc.calendarIds,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

function contentFields(content: SuggestionContent): { type: 'note' | 'rule'; content: ContentFields; text: string | null } {
  if (content.type === 'note') {
    const n = content.note;
    return {
      type: 'note', text: null,
      content: {
        kind: n.kind, startDate: n.startDate, endDate: n.endDate, weekdays: n.weekdays === null ? null : [...n.weekdays], effect: n.effect,
        expectedGuests: n.expectedGuests, detail: n.detail, startTime: n.startTime, endTime: n.endTime,
      },
    };
  }
  const s = content.schedule;
  return {
    type: 'rule', text: content.text,
    content: {
      kind: s.kind, startDate: s.startDate, endDate: s.endDate, weekdays: s.weekdays === null ? null : [...s.weekdays], effect: s.effect,
      expectedGuests: s.expectedGuests, detail: null, startTime: s.startTime, endTime: s.endTime,
    },
  };
}

export function createAgentSuggestionStore(connection: Connection): AgentSuggestionStore {
  const Suggestion = agentSuggestionModel(connection);
  const Pass = suggestionPassModel(connection);
  const of = (scope: OrgScope, locationId: string) => ({ orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId) });
  const one = (scope: OrgScope, locationId: string, id: string) => ({ ...of(scope, locationId), _id: new Types.ObjectId(id) });
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
    async listOpen(scope, locationId, today) {
      const docs = await Suggestion.find({ ...of(scope, locationId), status: 'open', 'content.startDate': trusted({ $gt: today }) })
        .sort({ 'content.startDate': 1, _id: 1 }).lean();
      return docs.map(toSuggestion);
    },
    async recent(scope, locationId) {
      const docs = await Suggestion.find(of(scope, locationId)).sort({ _id: -1 }).limit(RECENT_LIMIT).lean();
      return docs.map(toSuggestion);
    },
    async find(scope, locationId, id) {
      const doc = await Suggestion.findOne(one(scope, locationId, id)).lean();
      return doc === null ? null : toSuggestion(doc);
    },
    async markAccepted(scope, locationId, id, input) {
      const result = await Suggestion.updateOne(
        { ...one(scope, locationId, id), status: trusted({ $in: ['open', 'dismissed'] }) },
        { $set: { status: 'accepted', decidedBy: input.by, decidedAt: input.now, updatedAt: input.now } },
      );
      return result.modifiedCount === 1;
    },
    async markDismissed(scope, locationId, id, input) {
      const result = await Suggestion.updateOne(
        { ...one(scope, locationId, id), status: 'open' },
        { $set: { status: 'dismissed', decidedBy: input.by, decidedAt: input.now, updatedAt: input.now } },
      );
      return result.modifiedCount === 1;
    },
    async expire(scope, locationId, today, now) {
      const result = await Suggestion.updateMany(
        { ...of(scope, locationId), status: 'open', 'content.startDate': trusted({ $lte: today }) },
        { $set: { status: 'expired', updatedAt: now } },
      );
      return result.modifiedCount;
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
