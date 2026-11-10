// tw_profiles (spec 6.22): the name a person gave Townwise for TownwiseAI's greeting. Account-level, one row per
// person, read and written only for the caller's own userId. Never logged or audited. Deleted with the person, never
// with an organization.
import { Schema, type Connection, type Model } from 'mongoose';

export const PROFILES_COLLECTION = 'tw_profiles';

interface ProfileFields {
  /** The kit user id, a string as in tw_access_requests and tw_welcomes. */
  userId: string;
  /** Null is a row on purpose: “no name”, which is also the answer to the one-time prompt's Not now. */
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function profileSchema(): Schema<ProfileFields> {
  const schema = new Schema<ProfileFields>({
    userId: { type: String, required: true },
    displayName: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ userId: 1 }, { unique: true });
  return schema;
}

/** Registers TwProfile (tw_profiles) on first call. */
export function profileModel(connection: Connection): Model<ProfileFields> {
  const existing = connection.models.TwProfile as Model<ProfileFields> | undefined;
  return existing ?? connection.model<ProfileFields>('TwProfile', profileSchema(), PROFILES_COLLECTION);
}

/** Account-level, keyed by the caller's own userId (never an organization), like tw_access_requests. */
export interface ProfileStore {
  get(userId: string): Promise<{ displayName: string | null } | null>;
  /** An upsert; `createdAt` is set only on insert. */
  set(userId: string, displayName: string | null, now: Date): Promise<void>;
}

export function createProfileStore(connection: Connection): ProfileStore {
  const Profile = profileModel(connection);
  return {
    async get(userId) {
      const row = await Profile.findOne({ userId }).lean();
      return row === null ? null : { displayName: row.displayName };
    },
    async set(userId, displayName, now) {
      await Profile.updateOne(
        { userId },
        { $set: { displayName, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    },
  };
}
