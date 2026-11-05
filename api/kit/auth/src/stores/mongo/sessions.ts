import { isDuplicateKeyError } from '@ckeith26/mongo';
import mongoose, { Schema, trusted, type Connection, type Model } from 'mongoose';

import { IDLE_DAYS } from '../../sessions.ts';
import type { LiveWindow, Platform, RevokeReason, SessionRecord, SessionStore } from '../types.ts';

interface SessionFields {
  _id: string;
  userId: mongoose.Types.ObjectId;
  platform: Platform;
  refreshHash: string;
  previousRefreshHash?: string;
  createdAt: Date;
  lastUsedAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: RevokeReason | null;
}

interface RetiredFields {
  _id: string;
  sessionId: string;
  expiresAt: Date;
}

function sessionSchema(): Schema<SessionFields> {
  const schema = new Schema<SessionFields>({
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    platform: { type: String, required: true },
    refreshHash: { type: String, required: true },
    previousRefreshHash: { type: String },
    createdAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ refreshHash: 1 }, { unique: true });
  schema.index({ previousRefreshHash: 1 }, {
    partialFilterExpression: { previousRefreshHash: { $type: 'string' } },
  });
  schema.index({ userId: 1 });
  schema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 604800 });
  return schema;
}

function retiredSchema(): Schema<RetiredFields> {
  const schema = new Schema<RetiredFields>({
    _id: { type: String, required: true },
    sessionId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 604800 });
  return schema;
}

function toSession(doc: SessionFields): SessionRecord {
  return {
    id: doc._id,
    userId: String(doc.userId),
    platform: doc.platform,
    refreshHash: doc.refreshHash,
    previousRefreshHash: doc.previousRefreshHash ?? null,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt,
    absoluteExpiresAt: doc.absoluteExpiresAt,
    revokedAt: doc.revokedAt,
    revokeReason: doc.revokeReason,
  };
}

function live(w: LiveWindow): {
  revokedAt: null;
  absoluteExpiresAt: { $gt: Date };
  lastUsedAt: { $gt: Date };
} {
  return {
    revokedAt: null,
    absoluteExpiresAt: trusted({ $gt: w.now }),
    lastUsedAt: trusted({ $gt: w.idleCutoff }),
  };
}

function sessionOf(doc: object): SessionFields {
  return doc as SessionFields;
}

export function createSessionStore(connection: Connection): SessionStore {
  const sessions = (connection.models.AuthSession as Model<SessionFields> | undefined)
    ?? connection.model<SessionFields>('AuthSession', sessionSchema(), 'auth_sessions');
  const retired = (connection.models.AuthRefreshRetired as Model<RetiredFields> | undefined)
    ?? connection.model<RetiredFields>('AuthRefreshRetired', retiredSchema(), 'auth_refresh_retired');

  async function recordRetired(hash: string, sessionId: string, expiresAt: Date): Promise<void> {
    try {
      await retired.create({ _id: hash, sessionId, expiresAt });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }

  return {
    async create(input): Promise<SessionRecord> {
      const doc = await sessions.create({
        _id: input.id,
        userId: new mongoose.Types.ObjectId(input.userId),
        platform: input.platform,
        refreshHash: input.refreshHash,
        createdAt: input.now,
        lastUsedAt: input.now,
        absoluteExpiresAt: input.absoluteExpiresAt,
        revokedAt: null,
        revokeReason: null,
      });
      return toSession(doc);
    },
    async findLive(id, w): Promise<SessionRecord | null> {
      const doc = await sessions.findOne({ _id: id, ...live(w) });
      return doc === null ? null : toSession(sessionOf(doc));
    },
    async rotate(input): Promise<SessionRecord | null> {
      const doc = await sessions.findOneAndUpdate(
        { refreshHash: input.currentHash, platform: input.platform, ...live(input) },
        { $set: { refreshHash: input.newHash, previousRefreshHash: input.currentHash, lastUsedAt: input.now } },
        { returnDocument: 'after' },
      );
      if (doc === null) return null;
      const session = sessionOf(doc);
      await recordRetired(input.currentHash, session._id, session.absoluteExpiresAt);
      return toSession(session);
    },
    async findByPreviousHash(hash, platform): Promise<SessionRecord | null> {
      const doc = await sessions.findOne({ previousRefreshHash: hash, platform });
      return doc === null ? null : toSession(sessionOf(doc));
    },
    async rotateFromPrevious(input): Promise<SessionRecord | null> {
      const doc = await sessions.findOneAndUpdate(
        {
          _id: input.id,
          previousRefreshHash: input.previousHash,
          refreshHash: input.expectedCurrentHash,
          ...live(input),
        },
        { $set: { refreshHash: input.newHash, previousRefreshHash: input.expectedCurrentHash } },
        { returnDocument: 'after' },
      );
      if (doc === null) return null;
      const session = sessionOf(doc);
      await recordRetired(input.expectedCurrentHash, session._id, session.absoluteExpiresAt);
      return toSession(session);
    },
    async findByRetiredHash(hash, platform): Promise<SessionRecord | null> {
      const row = await retired.findById(hash);
      if (row === null) return null;
      const doc = await sessions.findOne({ _id: row.sessionId, platform });
      return doc === null ? null : toSession(sessionOf(doc));
    },
    async revoke(input): Promise<boolean> {
      const doc = await sessions.findOneAndUpdate(
        { _id: input.id, revokedAt: null },
        { $set: { revokedAt: input.now, revokeReason: input.reason } },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async revokeByRefreshHash(input): Promise<boolean> {
      const idleCutoff = new Date(input.now.getTime() - IDLE_DAYS * 24 * 60 * 60 * 1000);
      const doc = await sessions.findOneAndUpdate(
        {
          refreshHash: input.hash,
          platform: input.platform,
          ...live({ now: input.now, idleCutoff }),
        },
        { $set: { revokedAt: input.now, revokeReason: input.reason } },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async revokeAllForUser(input): Promise<number> {
      const filter: {
        userId: mongoose.Types.ObjectId;
        revokedAt: null;
        _id?: { $ne: string };
      } = {
        userId: new mongoose.Types.ObjectId(input.userId),
        revokedAt: null,
      };
      if (input.exceptId !== undefined) filter._id = trusted({ $ne: input.exceptId });
      const result = await sessions.updateMany(filter, { $set: { revokedAt: input.now, revokeReason: input.reason } });
      return result.modifiedCount;
    },
  };
}
