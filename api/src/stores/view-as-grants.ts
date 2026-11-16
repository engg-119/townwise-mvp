// A staff session's grant (tw_view_as_grants): view-as (D8), or open as admin (D25). A grant holds its session while
// `activeSessionId` is set, and the unique index on it allows one live grant per session across both kinds.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

export type GrantEndReason = 'ended' | 'replaced' | 'expired';

export interface ViewAsGrantFields {
  /** Set only on an open-as-admin grant (D25). A grant without it is view-as, as every grant before D25. */
  kind?: 'open_as_admin';
  actorUserId: string;
  actorSessionId: string;
  activeSessionId?: string;
  /** View-as only. */
  targetUserId?: string;
  orgId: Types.ObjectId | null;
  /** View-as; open as admin once someone has joined its organization (D25, 2026-11-15). */
  reason?: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: GrantEndReason | null;
}

/** Required on a view-as grant: on every grant but an open-as-admin one. */
function isViewAs(this: { kind?: 'open_as_admin' }): boolean {
  return this.kind !== 'open_as_admin';
}

function grantSchema(): Schema<ViewAsGrantFields> {
  const schema = new Schema<ViewAsGrantFields>({
    kind: { type: String, enum: ['open_as_admin'] },
    actorUserId: { type: String, required: true },
    actorSessionId: { type: String, required: true },
    activeSessionId: { type: String },
    targetUserId: { type: String, required: isViewAs },
    orgId: { type: Schema.Types.ObjectId, default: null },
    reason: { type: String, required: isViewAs, minlength: 5, maxlength: 200 },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null, enum: ['ended', 'replaced', 'expired'] },
  }, { strict: true, versionKey: false, read: 'primary' });
  // One live grant per staff session.
  schema.index({ activeSessionId: 1 }, {
    unique: true,
    partialFilterExpression: { activeSessionId: { $type: 'string' } },
  });
  schema.index({ actorUserId: 1, startedAt: -1 });
  return schema;
}

/** Registers TwViewAsGrant (tw_view_as_grants) on first call. Grants are never deleted. */
export function viewAsGrantModel(connection: Connection): Model<ViewAsGrantFields> {
  const existing = connection.models.TwViewAsGrant as Model<ViewAsGrantFields> | undefined;
  return existing ?? connection.model<ViewAsGrantFields>('TwViewAsGrant', grantSchema(), 'tw_view_as_grants');
}

export interface ViewAsGrantRecord {
  readonly kind: 'view_as';
  readonly id: string;
  readonly targetUserId: string;
  readonly orgId: string | null;
  readonly reason: string;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
}

/** D25: the organization this staff session opened as its admin. */
export interface OpenAsAdminGrantRecord {
  readonly kind: 'open_as_admin';
  readonly id: string;
  readonly orgId: string;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
}

export type GrantRecord = ViewAsGrantRecord | OpenAsAdminGrantRecord;

export interface ViewAsGrantStore {
  /** The grant still holding this session (`activeSessionId`), live or expired, of either kind. */
  findBySession(sessionId: string): Promise<GrantRecord | null>;
  /** A grant by its id, ended or not, of either kind; null for an unknown id. */
  findById(grantId: string): Promise<GrantRecord | null>;
  /** Inserts a view-as grant holding this session; false when the session already holds one (the unique index). */
  insert(input: {
    id: string; actorUserId: string; sessionId: string; targetUserId: string; orgId: string | null;
    reason: string; startedAt: Date; expiresAt: Date;
  }): Promise<boolean>;
  /** Inserts an open-as-admin grant holding this session; false when the session already holds one of either kind. */
  insertOpenAsAdmin(input: { id: string; actorUserId: string; sessionId: string; orgId: string; startedAt: Date; expiresAt: Date; reason?: string }): Promise<boolean>;
  /** Compare-and-set: ends the grant while it still holds this session, and releases the session. */
  end(grantId: string, sessionId: string, input: { endedAt: Date; endReason: GrantEndReason }): Promise<boolean>;
  /**
   * This staff member's open-as-admin grants still holding a session other than `sessionId` whose `expiresAt` has
   * passed, each with the session it holds (the `actorUserId` index). A grant still live in another session, and every
   * view-as grant, is never returned.
   */
  findExpiredOpenAsAdminElsewhere(actorUserId: string, sessionId: string, now: Date): Promise<{ grant: OpenAsAdminGrantRecord; sessionId: string }[]>;
}

type GrantDoc = ViewAsGrantFields & { _id: Types.ObjectId };

/**
 * A stored grant as its record. A grant the schema could not have stored (open as admin with no organization, view-as
 * with no target or reason) throws rather than resolve to either kind: failing closed beats guessing whose it is.
 */
function toGrant(doc: GrantDoc): GrantRecord {
  const id = doc._id.toHexString();
  if (doc.kind === 'open_as_admin') {
    if (doc.orgId === null) throw new Error('an open-as-admin grant without an organization');
    return { kind: 'open_as_admin', id, orgId: doc.orgId.toHexString(), startedAt: doc.startedAt, expiresAt: doc.expiresAt, endedAt: doc.endedAt };
  }
  if (doc.targetUserId === undefined || doc.reason === undefined) throw new Error('a view-as grant without its target or reason');
  return {
    kind: 'view_as',
    id,
    targetUserId: doc.targetUserId,
    orgId: doc.orgId === null ? null : doc.orgId.toHexString(),
    reason: doc.reason,
    startedAt: doc.startedAt,
    expiresAt: doc.expiresAt,
    endedAt: doc.endedAt,
  };
}

export function createViewAsGrantStore(connection: Connection): ViewAsGrantStore {
  const Grant = viewAsGrantModel(connection);
  return {
    async insert(input) {
      try {
        await Grant.create({
          _id: input.id, actorUserId: input.actorUserId, actorSessionId: input.sessionId, activeSessionId: input.sessionId,
          targetUserId: input.targetUserId, orgId: input.orgId, reason: input.reason, startedAt: input.startedAt,
          expiresAt: input.expiresAt, endedAt: null, endReason: null,
        });
        return true;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },
    async insertOpenAsAdmin(input) {
      try {
        await Grant.create({
          _id: input.id, kind: 'open_as_admin', actorUserId: input.actorUserId, actorSessionId: input.sessionId,
          activeSessionId: input.sessionId, orgId: input.orgId, startedAt: input.startedAt, expiresAt: input.expiresAt,
          endedAt: null, endReason: null, ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
        return true;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },
    async end(grantId, sessionId, input) {
      const result = await Grant.updateOne(
        { _id: grantId, activeSessionId: sessionId },
        { $set: { endedAt: input.endedAt, endReason: input.endReason }, $unset: { activeSessionId: '' } },
      );
      return result.modifiedCount === 1;
    },
    async findBySession(sessionId) {
      const doc = await Grant.findOne({ activeSessionId: sessionId }).lean();
      return doc === null ? null : toGrant(doc);
    },
    async findById(grantId) {
      if (!Types.ObjectId.isValid(grantId)) return null;
      const doc = await Grant.findOne({ _id: new Types.ObjectId(grantId) }).lean();
      return doc === null ? null : toGrant(doc);
    },
    async findExpiredOpenAsAdminElsewhere(actorUserId, sessionId, now) {
      const docs = await Grant.find({
        kind: 'open_as_admin', actorUserId, activeSessionId: trusted({ $type: 'string', $ne: sessionId }), expiresAt: trusted({ $lte: now }),
      }).lean();
      return docs.flatMap((doc) => {
        const grant = toGrant(doc);
        return doc.activeSessionId === undefined || grant.kind !== 'open_as_admin' ? [] : [{ grant, sessionId: doc.activeSessionId }];
      });
    },
  };
}
