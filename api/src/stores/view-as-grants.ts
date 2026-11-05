import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, type Connection, type Model, type Types } from 'mongoose';

export type GrantEndReason = 'ended' | 'replaced' | 'expired';

export interface ViewAsGrantFields {
  actorUserId: string;
  actorSessionId: string;
  activeSessionId?: string;
  targetUserId: string;
  orgId: Types.ObjectId | null;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: GrantEndReason | null;
}

function grantSchema(): Schema<ViewAsGrantFields> {
  const schema = new Schema<ViewAsGrantFields>({
    actorUserId: { type: String, required: true },
    actorSessionId: { type: String, required: true },
    activeSessionId: { type: String },
    targetUserId: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, default: null },
    reason: { type: String, required: true, minlength: 5, maxlength: 200 },
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
  readonly id: string;
  readonly targetUserId: string;
  readonly orgId: string | null;
  readonly reason: string;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
}

export interface ViewAsGrantStore {
  /** The grant still holding this session (`activeSessionId`), live or expired. */
  findBySession(sessionId: string): Promise<ViewAsGrantRecord | null>;
  /** Inserts a grant holding this session; false when the session already holds one (the unique index). */
  insert(input: {
    id: string; actorUserId: string; sessionId: string; targetUserId: string; orgId: string | null;
    reason: string; startedAt: Date; expiresAt: Date;
  }): Promise<boolean>;
  /** Compare-and-set: ends the grant while it still holds this session, and releases the session. */
  end(grantId: string, sessionId: string, input: { endedAt: Date; endReason: GrantEndReason }): Promise<boolean>;
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
    async end(grantId, sessionId, input) {
      const result = await Grant.updateOne(
        { _id: grantId, activeSessionId: sessionId },
        { $set: { endedAt: input.endedAt, endReason: input.endReason }, $unset: { activeSessionId: '' } },
      );
      return result.modifiedCount === 1;
    },
    async findBySession(sessionId) {
      const doc = await Grant.findOne({ activeSessionId: sessionId }).lean();
      if (doc === null) return null;
      return {
        id: doc._id.toHexString(),
        targetUserId: doc.targetUserId,
        orgId: doc.orgId === null ? null : doc.orgId.toHexString(),
        reason: doc.reason,
        startedAt: doc.startedAt,
        expiresAt: doc.expiresAt,
        endedAt: doc.endedAt,
      };
    },
  };
}
