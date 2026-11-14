// tw_order_counts (design Decision 3, the order-counts spec): one document per location and count date, holding the
// quantity on hand of each item counted that day, in purchase units. A save sets each sent item and keeps the others,
// so a bar counted in two goes holds every item. The latest count of an item is the newest date holding it. `items` is
// a mongoose Map of Number keyed by the setup's 24-hex item ids; the schema is strict: 'throw'. Nothing here logs. It
// goes with the location and the organization, never with the sales data.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { assertItemIds } from './item-sales.ts';

export const ORDER_COUNTS_COLLECTION = 'tw_order_counts';
/** Count dates latest() reads per query, newest first. */
const LATEST_BATCH = 30;

interface CountFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  date: string;
  items: Map<string, number>;
  updatedAt: Date;
}

function countSchema(): Schema<CountFields> {
  const schema = new Schema<CountFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    items: { type: Map, of: Number, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, date: 1 }, { unique: true });
  return schema;
}

/** Registers TwOrderCount (tw_order_counts) on first call. */
export function orderCountModel(connection: Connection): Model<CountFields> {
  const existing = connection.models.TwOrderCount as Model<CountFields> | undefined;
  return existing ?? connection.model<CountFields>('TwOrderCount', countSchema(), ORDER_COUNTS_COLLECTION);
}

export interface LatestCount {
  readonly quantity: number;
  /** The count date that holds it. */
  readonly date: string;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface OrderCountStore {
  /** Sets each sent item's quantity on `date`, keeping the items already counted that day. */
  save(scope: OrgScope, locationId: string, date: string, items: Readonly<Record<string, number>>, now: Date): Promise<void>;
  /**
   * Per item id of `itemIds`, the quantity from the newest count dated `since` or later; an item not counted then is
   * left out. Reads newest first, in batches, and stops once every item has a count.
   */
  latest(scope: OrgScope, locationId: string, since: string, itemIds: readonly string[]): Promise<Map<string, LatestCount>>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createOrderCountStore(connection: Connection): OrderCountStore {
  const Count = orderCountModel(connection);
  const place = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });
  return {
    async save(scope, locationId, date, items, now) {
      assertItemIds(items);
      const set = Object.fromEntries(Object.entries(items).map(([id, quantity]) => [`items.${id}`, quantity]));
      // Two saves of a new date can both try to insert it; the one that loses matches the row on a second try.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await Count.updateOne({ ...place(scope, locationId), date }, { $set: { ...set, updatedAt: now } }, { upsert: true });
          return;
        } catch (err) {
          if (!isDuplicateKeyError(err) || attempt === 1) throw err;
        }
      }
    },
    async latest(scope, locationId, since, itemIds) {
      const wanted = new Set(itemIds);
      const latest = new Map<string, LatestCount>();
      // A location's dates are unique (the index), so each batch starts strictly before the last one's oldest date.
      let before: string | null = null;
      while (latest.size < wanted.size) {
        const range = before === null ? { $gte: since } : { $gte: since, $lt: before };
        const docs: { date: string; items: Record<string, number> }[] = await Count
          .find({ ...place(scope, locationId), date: trusted(range) }, { _id: 0, date: 1, items: 1 })
          .sort({ date: -1 })
          .limit(LATEST_BATCH)
          .lean<{ date: string; items: Record<string, number> }[]>();
        for (const doc of docs) {
          for (const [id, quantity] of Object.entries(doc.items)) {
            if (wanted.has(id) && !latest.has(id)) latest.set(id, { quantity, date: doc.date });
          }
        }
        const oldest: { date: string } | undefined = docs.at(-1);
        if (docs.length < LATEST_BATCH || oldest === undefined) break;
        before = oldest.date;
      }
      return latest;
    },
    async removeForLocation(scope, locationId) {
      return (await Count.deleteMany(place(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Count.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
