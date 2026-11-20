import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, type Connection, type Model, type Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export interface OrgFields {
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  createdBy: string;
  fromRequestId: Types.ObjectId | null;
  suspendedAt: Date | null;
  /**
   * When someone first took a seat (a join or an approval), set once and never cleared, so staff setup (D23) never
   * reopens, even once every seat is removed and its person deleted. Absent until then, and on older documents.
   */
  firstJoinedAt?: Date;
  /**
   * When the organization was last suspended: set at each suspension and never cleared, reactivation included, so an
   * open-as-admin grant started before it never comes back to life (D25). Absent until the first suspension, and on
   * older documents.
   */
  lastSuspendedAt?: Date;
  /**
   * Staff switched forecasts on (with its owner's agreement) or off for the organization (G1). Absent until first
   * switched, which reads as on (D42, owner directive 2026-11-16). `by` is the staff user id, null once that person is
   * deleted.
   */
  forecasts?: { on: boolean; at: Date; by: string | null };
  /**
   * An org admin turned TownwiseAI's weekly suggestions off or back on (openspec change weekly-forecast-suggestions).
   * Absent until first switched, which reads as on (owner directive 2026-11-16). `by` is the admin's user id, null once
   * that person is deleted.
   */
  weeklySuggestions?: { on: boolean; at: Date; by: string | null };
  /**
   * An org admin turned off or back on sending the location calendars' event titles to TownwiseAI's weekly call (openspec
   * change calendar-event-suggestions, design decision 9). Absent until first switched, which reads as on (owner rule
   * 2026-11-16). `by` is the admin's user id (staff open as admin may only turn it off), null once that person is deleted.
   */
  calendarTitlesToAi?: { on: boolean; at: Date; by: string | null };
  /**
   * D59 (openspec change auto-apply-agent-reads, design decision 13): an org admin turned TownwiseAI working on its own
   * off or back on. Absent until first switched, which reads as on (owner rule 2026-11-16). `by` is the admin's user id
   * (staff open as admin may only turn it off), null once that person is deleted.
   */
  agentAuto?: { on: boolean; at: Date; by: string | null };
  /**
   * D66 (openspec change town-research-agent, design decision 9): an org admin turned research of the organization's
   * locations off or back on. Absent until first switched, which reads as on (owner rule 2026-11-16). `by` is the
   * admin's user id (staff open as admin may only turn it off), null once that person is deleted.
   */
  research?: { on: boolean; at: Date; by: string | null };
}

function orgSchema(): Schema<OrgFields> {
  const schema = new Schema<OrgFields>({
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    status: { type: String, required: true, enum: ['active', 'suspended'] },
    createdAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
    fromRequestId: { type: Schema.Types.ObjectId, default: null },
    suspendedAt: { type: Date, default: null },
    firstJoinedAt: { type: Date },
    lastSuspendedAt: { type: Date },
    forecasts: { type: new Schema({ on: { type: Boolean, required: true }, at: { type: Date, required: true }, by: { type: String, default: null } }, { _id: false, strict: true }) },
    weeklySuggestions: { type: new Schema({ on: { type: Boolean, required: true }, at: { type: Date, required: true }, by: { type: String, default: null } }, { _id: false, strict: true }) },
    calendarTitlesToAi: { type: new Schema({ on: { type: Boolean, required: true }, at: { type: Date, required: true }, by: { type: String, default: null } }, { _id: false, strict: true }) },
    agentAuto: { type: new Schema({ on: { type: Boolean, required: true }, at: { type: Date, required: true }, by: { type: String, default: null } }, { _id: false, strict: true }) },
    research: { type: new Schema({ on: { type: Boolean, required: true }, at: { type: Date, required: true }, by: { type: String, default: null } }, { _id: false, strict: true }) },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ createdAt: -1 });
  return schema;
}

/** Registers TwOrg (tw_orgs) on first call; the first registration on a connection wins. */
export function orgModel(connection: Connection): Model<OrgFields> {
  const existing = connection.models.TwOrg as Model<OrgFields> | undefined;
  return existing ?? connection.model<OrgFields>('TwOrg', orgSchema(), 'tw_orgs');
}

export interface OrgRecord {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: Date;
  readonly fromRequestId: string | null;
  readonly suspendedAt: Date | null;
  readonly firstJoinedAt: Date | null;
  readonly lastSuspendedAt: Date | null;
  /** Whether forecasts are on, and when staff last switched them; `{ on: true, at: null }` before the first switch (D42). */
  readonly forecasts: { readonly on: boolean; readonly at: Date | null };
  /** Whether weekly suggestions are on, and when an org admin last switched them; `{ on: true, at: null }` before that. */
  readonly weeklySuggestions: { readonly on: boolean; readonly at: Date | null };
  /** Whether the weekly call reads the calendars' event titles, and when an org admin last switched it; on before that. */
  readonly calendarTitlesToAi: { readonly on: boolean; readonly at: Date | null };
  /** D59: whether TownwiseAI works on its own, and when an org admin last switched it; on before that. */
  readonly agentAuto: { readonly on: boolean; readonly at: Date | null };
  /** D66: whether the organization's locations are researched, and when an org admin last switched it; on before that. */
  readonly research: { readonly on: boolean; readonly at: Date | null };
}

export interface OrgStore {
  findById(id: string): Promise<OrgRecord | null>;
  findByIds(ids: readonly string[]): Promise<OrgRecord[]>;
  /** Every organization, newest first (the staff console). */
  list(): Promise<OrgRecord[]>;
  /** F3 step 6: inserts the organization with this id once (`$setOnInsert`), so a retry finds it. */
  insertFromRequest(input: {
    id: string; name: string; createdAt: Date; createdBy: string; fromRequestId: string;
  }): Promise<{ org: OrgRecord; inserted: boolean }>;
  /** F10: a new active organization staff created directly, with no request; null when this id is already taken. */
  insertByStaff(input: { id: string; name: string; createdAt: Date; createdBy: string }): Promise<OrgRecord | null>;
  /** Sets the name. Resolves the organization as it was before, or null when it is gone. */
  rename(scope: OrgScope, name: string): Promise<OrgRecord | null>;
  /**
   * The staff console's changes in one write: the name, and the status, which suspends (setting suspendedAt and
   * lastSuspendedAt) or reactivates (clearing suspendedAt only). False when the organization is gone.
   */
  update(scope: OrgScope, changes: { name?: string; status?: 'active' | 'suspended' }, now: Date): Promise<boolean>;
  /**
   * Deletion's last step (spec 10.7), so a retry still finds the organization until then. Only while it is suspended:
   * false when it was reactivated, or is already gone.
   */
  remove(scope: OrgScope): Promise<boolean>;
  /** Deletes the organization an approval made from this request (fromRequestId), whatever its status. */
  removeFromRequest(scope: OrgScope, requestId: string): Promise<boolean>;
  /** Sets `firstJoinedAt` to `at` only while it is unset (a compare-and-set), right after a seat is taken. */
  markJoined(scope: OrgScope, at: Date): Promise<void>;
  /** Switches forecasts on or off, recording when and by which staff member. False when the organization is gone. */
  setForecasts(scope: OrgScope, change: { on: boolean; at: Date; by: string }): Promise<boolean>;
  /** Turns weekly suggestions on or off, recording when and by which org admin. False when the organization is gone. */
  setWeeklySuggestions(scope: OrgScope, change: { on: boolean; at: Date; by: string }): Promise<boolean>;
  /** Turns sending calendar event titles on or off, recording when and by whom. False when the organization is gone. */
  setCalendarTitlesToAi(scope: OrgScope, change: { on: boolean; at: Date; by: string }): Promise<boolean>;
  /** D59: turns TownwiseAI working on its own on or off, recording when and by whom. False when the organization is gone. */
  setAgentAuto(scope: OrgScope, change: { on: boolean; at: Date; by: string }): Promise<boolean>;
  /** D66: turns research on or off, recording when and by whom. False when the organization is gone. */
  setResearch(scope: OrgScope, change: { on: boolean; at: Date; by: string }): Promise<boolean>;
}

function toOrg(doc: OrgFields & { _id: Types.ObjectId }): OrgRecord {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    status: doc.status,
    createdAt: doc.createdAt,
    fromRequestId: doc.fromRequestId === null ? null : doc.fromRequestId.toHexString(),
    suspendedAt: doc.suspendedAt,
    firstJoinedAt: doc.firstJoinedAt ?? null,
    lastSuspendedAt: doc.lastSuspendedAt ?? null,
    // D42: on by default for every organization, existing and new (approved 2026-11-19), until staff switch it off.
    forecasts: doc.forecasts == null ? { on: true, at: null } : { on: doc.forecasts.on, at: doc.forecasts.at },
    // Weekly suggestions: on by default (owner directive 2026-11-16) until an org admin turns them off. [CONFIRM]
    weeklySuggestions: doc.weeklySuggestions == null
      ? { on: true, at: null } : { on: doc.weeklySuggestions.on, at: doc.weeklySuggestions.at },
    // Calendar titles to TownwiseAI: on by default (owner, 2026-11-17; approved 2026-11-19) until an org admin turns them off.
    calendarTitlesToAi: doc.calendarTitlesToAi == null
      ? { on: true, at: null } : { on: doc.calendarTitlesToAi.on, at: doc.calendarTitlesToAi.at },
    // D59: TownwiseAI works on its own by default (owner rule 2026-11-16; approved 2026-11-19) until an org admin turns it off.
    agentAuto: doc.agentAuto == null ? { on: true, at: null } : { on: doc.agentAuto.on, at: doc.agentAuto.at },
    // D66: research is on by default (owner rule 2026-11-16; approved 2026-11-20) until an org admin turns it off.
    research: doc.research == null ? { on: true, at: null } : { on: doc.research.on, at: doc.research.at },
  };
}

/** The organization is the tenant root: reads by its own id, which callers take from a seat or a scope. */
export function createOrgStore(connection: Connection): OrgStore {
  const Org = orgModel(connection);
  return {
    async findById(id) {
      const doc = await Org.findById(id).lean();
      return doc === null ? null : toOrg(doc);
    },
    async findByIds(ids) {
      if (ids.length === 0) return [];
      const docs = await Org.find({ _id: trusted({ $in: [...ids] }) }).lean();
      return docs.map(toOrg);
    },
    async list() {
      const docs = await Org.find({}).sort({ createdAt: -1, _id: -1 }).lean();
      return docs.map(toOrg);
    },
    async insertFromRequest(input) {
      let inserted = false;
      try {
        const result = await Org.updateOne({ _id: input.id }, {
          $setOnInsert: {
            name: input.name, status: 'active', createdAt: input.createdAt, createdBy: input.createdBy,
            fromRequestId: input.fromRequestId, suspendedAt: null,
          },
        }, { upsert: true });
        inserted = result.upsertedCount === 1;
      } catch (err) {
        // A concurrent retry inserted it first.
        if (!isDuplicateKeyError(err)) throw err;
      }
      const doc = await Org.findById(input.id).lean();
      if (doc === null) throw new Error('organization missing after its upsert');
      return { org: toOrg(doc), inserted };
    },
    async insertByStaff(input) {
      try {
        const doc = await Org.create({
          _id: input.id, name: input.name, status: 'active', createdAt: input.createdAt, createdBy: input.createdBy,
          fromRequestId: null, suspendedAt: null,
        });
        return toOrg(doc.toObject());
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
    },
    async rename(scope, name) {
      const doc = await Org.findOneAndUpdate({ _id: scope.orgId }, { $set: { name } }, { returnDocument: 'before' }).lean();
      return doc === null ? null : toOrg(doc);
    },
    async update(scope, changes, now) {
      const set: Partial<Pick<OrgFields, 'name' | 'status' | 'suspendedAt' | 'lastSuspendedAt'>> = {};
      if (changes.name !== undefined) set.name = changes.name;
      if (changes.status !== undefined) {
        set.status = changes.status;
        set.suspendedAt = changes.status === 'suspended' ? now : null;
        if (changes.status === 'suspended') set.lastSuspendedAt = now;
      }
      const result = await Org.updateOne({ _id: scope.orgId }, { $set: set });
      return result.matchedCount === 1;
    },
    async remove(scope) {
      return (await Org.deleteOne({ _id: scope.orgId, status: 'suspended' })).deletedCount === 1;
    },
    async removeFromRequest(scope, requestId) {
      return (await Org.deleteOne({ _id: scope.orgId, fromRequestId: requestId })).deletedCount === 1;
    },
    async markJoined(scope, at) {
      await Org.updateOne({ _id: scope.orgId, firstJoinedAt: trusted({ $exists: false }) }, { $set: { firstJoinedAt: at } });
    },
    async setForecasts(scope, change) {
      const result = await Org.updateOne({ _id: scope.orgId }, { $set: { forecasts: { on: change.on, at: change.at, by: change.by } } });
      return result.matchedCount === 1;
    },
    async setWeeklySuggestions(scope, change) {
      const result = await Org.updateOne(
        { _id: scope.orgId }, { $set: { weeklySuggestions: { on: change.on, at: change.at, by: change.by } } },
      );
      return result.matchedCount === 1;
    },
    async setCalendarTitlesToAi(scope, change) {
      const result = await Org.updateOne(
        { _id: scope.orgId }, { $set: { calendarTitlesToAi: { on: change.on, at: change.at, by: change.by } } },
      );
      return result.matchedCount === 1;
    },
    async setAgentAuto(scope, change) {
      const result = await Org.updateOne({ _id: scope.orgId }, { $set: { agentAuto: { on: change.on, at: change.at, by: change.by } } });
      return result.matchedCount === 1;
    },
    async setResearch(scope, change) {
      const result = await Org.updateOne({ _id: scope.orgId }, { $set: { research: { on: change.on, at: change.at, by: change.by } } });
      return result.matchedCount === 1;
    },
  };
}
