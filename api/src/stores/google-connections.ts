// tw_google_connections (openspec change connect-google-calendar: the google-calendar spec, design decisions 4, 5, 6
// and 10): a person's Google access for calendars in one organization, at most one per (organization, person) under a
// unique index, shared by every Google calendar that person adds to the organization's locations. Its refresh token is
// stored only as the opaque string calendar/secret.ts seals, read back only by sealedToken() for server code
// (calendar/google-access.ts), and never part of a record. No access token, email address, name or Google subject is
// stored: the scopes granted, the person's agreement and the times are all a record holds.
// Every connection is due for a check at checkAt, which is never null: a connect sets it 24 hours on, markForCheck sets
// it to now before any step that may leave the connection unused or unowned, and clearCheck (an add) and releaseCheck
// (the refresh loop's check, only while no mark came in meanwhile) push it on again, so the refresh loop looks at each
// connection at least daily (its claim, by checkAt with leaseUntil, is in stores/cross-tenant.ts). revokedAt is set
// when Google refuses the refresh token, so the connection's other calendars fail without calling Google, and cleared
// by a reconnect. `titlesNotice` is 1 once a connect came from the explainer that says TownwiseAI reads the titles weekly
// (calendar-event-suggestions design decision 11): set by a connect that says so, never cleared. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { WEEKLY_TITLES_NOTICE } from '../calendar/titles-notice.ts';

export const GOOGLE_CONNECTIONS_COLLECTION = 'tw_google_connections';

/**
 * A connection is checked again this long after a connect or its last check, so an unused one ends about a day after
 * it was made. [CONFIRM: an unused Google connection is ended after 24 hours]
 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

interface ConnectionFields {
  orgId: Types.ObjectId;
  /** The kit user id, a string as in tw_members and tw_chat_conversations. */
  userId: string;
  /** The refresh token as calendar/secret.ts sealed it. */
  sealedRefreshToken: string;
  /** The scopes Google granted, as its token answer listed them. */
  scopes: string[];
  /** The press of "Continue to Google" that agreed to what the connect section says (design decision 12). */
  agreedAt: Date;
  connectedAt: Date;
  updatedAt: Date;
  /** When Google refused the refresh token (`invalid_grant`); null while it works. */
  revokedAt: Date | null;
  /** When the refresh loop next checks the connection's seat and use. Never null. */
  checkAt: Date;
  /** A check's claim on the connection, until this time. */
  leaseUntil: Date | null;
  /** 1 once a connect came from the explainer that says titles are read weekly; absent otherwise. */
  titlesNotice?: number;
}

function connectionSchema(): Schema<ConnectionFields> {
  const schema = new Schema<ConnectionFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    sealedRefreshToken: { type: String, required: true },
    scopes: { type: [String] },
    agreedAt: { type: Date, required: true },
    connectedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    checkAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: null },
    titlesNotice: { type: Number, enum: [WEEKLY_TITLES_NOTICE] },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, userId: 1 }, { unique: true });
  // The refresh loop's claim of a due check, across organizations (stores/cross-tenant.ts).
  schema.index({ checkAt: 1 });
  return schema;
}

/** Registers TwGoogleConnection (tw_google_connections) on first call. */
export function googleConnectionModel(connection: Connection): Model<ConnectionFields> {
  const existing = connection.models.TwGoogleConnection as Model<ConnectionFields> | undefined;
  return existing ?? connection.model<ConnectionFields>('TwGoogleConnection', connectionSchema(), GOOGLE_CONNECTIONS_COLLECTION);
}

/** A connection as server code sees it: never its refresh token. */
export interface GoogleConnectionRecord {
  readonly id: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly agreedAt: Date;
  readonly connectedAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt: Date | null;
  readonly checkAt: Date;
  readonly leaseUntil: Date | null;
  /** A connect came from the explainer that says TownwiseAI reads the titles weekly. */
  readonly titlesNotice: boolean;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface GoogleConnectionStore {
  /**
   * Stores the person's connection after a connect: the sealed refresh token, the scopes, agreedAt and connectedAt
   * `now`, revokedAt cleared and the check 24 hours on, inserting it or replacing the one there. A null token keeps the
   * stored one (Google sent none, design decision 8) and only updates an existing row that is not revoked: null when
   * there is none, or when it was revoked since the caller checked it. `titlesNotice` records that this connect came
   * from the explainer that says titles are read weekly; without it, what an earlier connect recorded stays.
   */
  upsert(scope: OrgScope, userId: string, input: {
    sealedRefreshToken: string | null; scopes: readonly string[]; now: Date; titlesNotice?: boolean;
  }): Promise<GoogleConnectionRecord | null>;
  findForUser(scope: OrgScope, userId: string): Promise<GoogleConnectionRecord | null>;
  /** Another organization's id answers null, as an unknown one does. */
  find(scope: OrgScope, connectionId: string): Promise<GoogleConnectionRecord | null>;
  /** The sealed refresh token, for calendar/google-access.ts only; null when the connection is gone. */
  sealedToken(scope: OrgScope, connectionId: string): Promise<string | null>;
  /** A new refresh token Google sent replaces the stored one. False when the connection is gone. */
  replaceToken(scope: OrgScope, connectionId: string, sealedRefreshToken: string, now: Date): Promise<boolean>;
  /** Google refused the refresh token. True when this call marked it; false when it was already revoked or is gone. */
  markRevoked(scope: OrgScope, connectionId: string, now: Date): Promise<boolean>;
  /** Due for a check at once (checkAt `now`), before a step that may leave it unused or unowned. False when gone. */
  markForCheck(scope: OrgScope, connectionId: string, now: Date): Promise<boolean>;
  /** Checked, or in use again: the next check 24 hours on, and any check's lease let go. False when gone. */
  clearCheck(scope: OrgScope, connectionId: string, now: Date): Promise<boolean>;
  /**
   * The refresh loop's end of a connection check it claimed (design decision 10), its own lease only: the next check at
   * `nextCheckAt` while checkAt is still the `checkAt` it claimed, else (a mark came in during the check) only the lease
   * let go, so the connection stays due. True when it set the next check.
   */
  releaseCheck(scope: OrgScope, connectionId: string, input: { leaseUntil: Date; checkAt: Date; nextCheckAt: Date }): Promise<boolean>;
  /** False when it was not there. */
  remove(scope: OrgScope, connectionId: string): Promise<boolean>;
  /** The organization's connections, oldest first (organization deletion revokes each). */
  listForOrg(scope: OrgScope): Promise<GoogleConnectionRecord[]>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type ConnectionDoc = ConnectionFields & { _id: Types.ObjectId };

function toRecord(doc: ConnectionDoc): GoogleConnectionRecord {
  return {
    id: doc._id.toHexString(),
    userId: doc.userId,
    scopes: [...doc.scopes],
    agreedAt: doc.agreedAt,
    connectedAt: doc.connectedAt,
    updatedAt: doc.updatedAt,
    revokedAt: doc.revokedAt,
    checkAt: doc.checkAt,
    leaseUntil: doc.leaseUntil,
    titlesNotice: doc.titlesNotice === WEEKLY_TITLES_NOTICE,
  };
}

export function createGoogleConnectionStore(connection: Connection): GoogleConnectionStore {
  const GoogleConnection = googleConnectionModel(connection);
  const ofOrg = (scope: OrgScope) => ({ orgId: new Types.ObjectId(scope.orgId) });
  const ofConnection = (scope: OrgScope, connectionId: string) => ({ ...ofOrg(scope), _id: new Types.ObjectId(connectionId) });
  const nextCheck = (now: Date): Date => new Date(now.getTime() + CHECK_INTERVAL_MS);

  return {
    async upsert(scope, userId, input) {
      const filter = { ...ofOrg(scope), userId };
      const now = input.now;
      const set = {
        scopes: [...input.scopes], agreedAt: now, connectedAt: now, updatedAt: now, revokedAt: null, checkAt: nextCheck(now),
        ...(input.titlesNotice === true ? { titlesNotice: WEEKLY_TITLES_NOTICE } : {}),
      };
      if (input.sealedRefreshToken === null) {
        // Compare-and-set on revokedAt: a refusal recorded since connect checked the row stays, over a token that fails.
        const kept = await GoogleConnection.findOneAndUpdate({ ...filter, revokedAt: null }, { $set: set }, { returnDocument: 'after' }).lean();
        return kept === null ? null : toRecord(kept);
      }
      const update = { $set: { ...set, sealedRefreshToken: input.sealedRefreshToken }, $setOnInsert: { leaseUntil: null } };
      for (let attempt = 1; ; attempt += 1) {
        try {
          return toRecord(await GoogleConnection.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' }).lean());
        } catch (err) {
          // Two first connects raced on the unique index: the second, tried again, replaces the row the first inserted.
          if (attempt > 1 || !isDuplicateKeyError(err)) throw err;
        }
      }
    },
    async findForUser(scope, userId) {
      const doc = await GoogleConnection.findOne({ ...ofOrg(scope), userId }).lean();
      return doc === null ? null : toRecord(doc);
    },
    async find(scope, connectionId) {
      const doc = await GoogleConnection.findOne(ofConnection(scope, connectionId)).lean();
      return doc === null ? null : toRecord(doc);
    },
    async sealedToken(scope, connectionId) {
      const doc = await GoogleConnection.findOne(ofConnection(scope, connectionId), { sealedRefreshToken: 1 }).lean();
      return doc?.sealedRefreshToken ?? null;
    },
    async replaceToken(scope, connectionId, sealedRefreshToken, now) {
      const replaced = await GoogleConnection.updateOne(ofConnection(scope, connectionId), { $set: { sealedRefreshToken, updatedAt: now } });
      return replaced.matchedCount === 1;
    },
    async markRevoked(scope, connectionId, now) {
      // The first refusal's time stays: a later one changes nothing.
      const marked = await GoogleConnection.updateOne({ ...ofConnection(scope, connectionId), revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } });
      return marked.modifiedCount === 1;
    },
    async markForCheck(scope, connectionId, now) {
      return (await GoogleConnection.updateOne(ofConnection(scope, connectionId), { $set: { checkAt: now } })).matchedCount === 1;
    },
    async clearCheck(scope, connectionId, now) {
      const cleared = await GoogleConnection.updateOne(ofConnection(scope, connectionId), { $set: { checkAt: nextCheck(now), leaseUntil: null } });
      return cleared.matchedCount === 1;
    },
    async releaseCheck(scope, connectionId, input) {
      const own = { ...ofConnection(scope, connectionId), leaseUntil: input.leaseUntil };
      // Compare-and-set on checkAt: a mark written since the claim stays, and the next look checks again.
      const pushed = await GoogleConnection.updateOne({ ...own, checkAt: input.checkAt }, { $set: { checkAt: input.nextCheckAt, leaseUntil: null } });
      if (pushed.matchedCount === 1) return true;
      await GoogleConnection.updateOne(own, { $set: { leaseUntil: null } });
      return false;
    },
    async remove(scope, connectionId) {
      return (await GoogleConnection.deleteOne(ofConnection(scope, connectionId))).deletedCount === 1;
    },
    async listForOrg(scope) {
      const docs = await GoogleConnection.find(ofOrg(scope)).sort({ connectedAt: 1, _id: 1 }).lean();
      return docs.map(toRecord);
    },
    async removeForOrg(scope) {
      return (await GoogleConnection.deleteMany(ofOrg(scope))).deletedCount;
    },
  };
}
