// tw_activity_days (openspec change staff-overview, design decision 1): the UTC days on which each person used the app in
// an organization, one document per person, organization and day. Its `_id` is built from those three, so it is the
// uniqueness itself and holds no time (an ObjectId would carry the second of the day's first request). Nothing else is
// kept: no path, route, page, IP address, device, count or time. access/activity.ts writes it; the overview reads and
// old-row removal and person deletion live in stores/cross-tenant.ts. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const ACTIVITY_DAYS_COLLECTION = 'tw_activity_days';

interface ActivityDayFields {
  /** `<orgId>:<userId>:<day>`. */
  _id: string;
  orgId: Types.ObjectId;
  userId: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
}

function activityDaySchema(): Schema<ActivityDayFields> {
  const schema = new Schema<ActivityDayFields>({
    _id: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    day: { type: String, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  // An organization's window; the overview's read across organizations and old-row removal; person deletion.
  schema.index({ orgId: 1, day: 1 });
  schema.index({ day: 1 });
  schema.index({ userId: 1 });
  return schema;
}

/** Registers TwActivityDay (tw_activity_days) on first call. */
export function activityDayModel(connection: Connection): Model<ActivityDayFields> {
  const existing = connection.models.TwActivityDay as Model<ActivityDayFields> | undefined;
  return existing ?? connection.model<ActivityDayFields>('TwActivityDay', activityDaySchema(), ACTIVITY_DAYS_COLLECTION);
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ActivityDayStore {
  /** Records that the person used the app in the organization on `day` (UTC); a day already recorded stays as it is. */
  record(scope: OrgScope, userId: string, day: string): Promise<void>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createActivityDayStore(connection: Connection): ActivityDayStore {
  const ActivityDay = activityDayModel(connection);
  return {
    async record(scope, userId, day) {
      try {
        await ActivityDay.updateOne(
          { _id: `${scope.orgId}:${userId}:${day}`, orgId: new Types.ObjectId(scope.orgId) },
          { $setOnInsert: { userId, day } },
          { upsert: true },
        );
      } catch (err) {
        // Two first requests of the day raced on _id; the other one wrote the row.
        if (!isDuplicateKeyError(err)) throw err;
      }
    },
    async removeForOrg(scope) {
      return (await ActivityDay.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
