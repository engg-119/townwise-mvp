import { isDuplicateKeyError, objectId } from '@ckeith26/mongo';
import { Schema, trusted, type Connection, type Model } from 'mongoose';

import { DuplicateError, type User, type UserStore } from '../types.ts';

interface UserFields {
  email: string;
  googleSubject?: string;
  createdAt: Date;
}

function userSchema(): Schema<UserFields> {
  const schema = new Schema<UserFields>({
    email: { type: String, required: true },
    googleSubject: { type: String },
    createdAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ email: 1 }, { unique: true });
  schema.index({ googleSubject: 1 }, {
    unique: true,
    partialFilterExpression: { googleSubject: { $type: 'string' } },
  });
  return schema;
}

function fieldOf(value: unknown): 'email' | 'googleSubject' | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if ('email' in value) return 'email';
  if ('googleSubject' in value) return 'googleSubject';
  return undefined;
}

function duplicateField(err: unknown): 'email' | 'googleSubject' | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const direct = fieldOf(record.keyPattern) ?? fieldOf(record.keyValue);
  if (direct !== undefined) return direct;
  const writes = record.writeErrors;
  if (writes === undefined || writes === null) return undefined;
  for (const entry of [writes].flat()) {
    const nested = duplicateField(entry);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

async function withDuplicate<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const field = duplicateField(err);
    if (field === undefined) throw err;
    throw new DuplicateError(field);
  }
}

function toUser(doc: { _id: unknown; email: string; googleSubject?: string | undefined; createdAt: Date }): User {
  return {
    id: String(doc._id),
    email: doc.email,
    googleSubject: doc.googleSubject ?? null,
    createdAt: doc.createdAt,
  };
}

export function createUserStore(connection: Connection): UserStore {
  const existing = connection.models.AuthUser as Model<UserFields> | undefined;
  const UserModel = existing ?? connection.model<UserFields>('AuthUser', userSchema(), 'users');

  return {
    async findById(id: string): Promise<User | null> {
      if (!objectId.safeParse(id).success) return null;
      const doc = await UserModel.findById(id);
      return doc === null ? null : toUser(doc);
    },
    async findByEmail(email: string): Promise<User | null> {
      const doc = await UserModel.findOne({ email });
      return doc === null ? null : toUser(doc);
    },
    async findByGoogleSubject(subject: string): Promise<User | null> {
      const doc = await UserModel.findOne({ googleSubject: subject });
      return doc === null ? null : toUser(doc);
    },
    async create(input: { email: string; googleSubject?: string; now: Date }): Promise<User> {
      const doc = await withDuplicate(() => UserModel.create({
        email: input.email,
        createdAt: input.now,
        ...(input.googleSubject !== undefined ? { googleSubject: input.googleSubject } : {}),
      }));
      return toUser(doc);
    },
    async linkGoogleSubject(input: { id: string; subject: string }): Promise<User | null> {
      if (!objectId.safeParse(input.id).success) return null;
      const doc = await withDuplicate(() => UserModel.findOneAndUpdate(
        { _id: input.id, googleSubject: trusted({ $exists: false }) },
        { $set: { googleSubject: input.subject } },
        { returnDocument: 'after' },
      ));
      return doc === null ? null : toUser(doc);
    },
    async updateEmail(input: { id: string; from: string; to: string }): Promise<User | null> {
      if (!objectId.safeParse(input.id).success) return null;
      const doc = await withDuplicate(() => UserModel.findOneAndUpdate(
        { _id: input.id, email: input.from },
        { $set: { email: input.to } },
        { returnDocument: 'after' },
      ));
      return doc === null ? null : toUser(doc);
    },
  };
}
