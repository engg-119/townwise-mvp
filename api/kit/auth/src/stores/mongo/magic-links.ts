import { Schema, trusted, type Connection, type Model } from 'mongoose';

import type { MagicLinkStore, Platform } from '../types.ts';

interface MagicLinkFields {
  _id: string;
  email: string;
  platform: Platform;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

function magicLinkSchema(): Schema<MagicLinkFields> {
  const schema = new Schema<MagicLinkFields>({
    _id: { type: String, required: true },
    email: { type: String, required: true },
    platform: { type: String, required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ email: 1 });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return schema;
}

export function createMagicLinkStore(connection: Connection): MagicLinkStore {
  const existing = connection.models.AuthMagicLink as Model<MagicLinkFields> | undefined;
  const MagicLink = existing ?? connection.model<MagicLinkFields>('AuthMagicLink', magicLinkSchema(), 'auth_magic_links');

  return {
    async create(input): Promise<void> {
      await MagicLink.create({
        _id: input.tokenHash,
        email: input.email,
        platform: input.platform,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        consumedAt: null,
      });
    },
    async consume(input): Promise<boolean> {
      const doc = await MagicLink.findOneAndUpdate(
        {
          _id: input.tokenHash,
          email: input.email,
          platform: input.platform,
          consumedAt: null,
          expiresAt: trusted({ $gt: input.now }),
        },
        { $set: { consumedAt: input.now } },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async deleteForEmail(email: string): Promise<number> {
      const result = await MagicLink.deleteMany({ email, consumedAt: null });
      return result.deletedCount;
    },
  };
}
