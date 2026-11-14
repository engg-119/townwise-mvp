// tw_item_sales (design Decisions 3 and 4, the item-sales spec): one document per location and business date, holding
// the servings each setup item sold that day, matched in the browser. A stored day is covered: an item absent from it
// sold none. A day not stored is unknown. `items` is a mongoose Map of Number, so every value is cast to a number and
// a read (lean) returns a plain object; its keys are the setup's 24-hex item ids, never a name. The schema is
// strict: 'throw'. Nothing here logs. It goes with the location's sales data, the location and the organization.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import mongoose, { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const ITEM_SALES_COLLECTION = 'tw_item_sales';

interface ItemSalesFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  date: string;
  items: Map<string, number>;
  uploadedAt: Date;
}

function itemSalesSchema(): Schema<ItemSalesFields> {
  const schema = new Schema<ItemSalesFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    items: { type: Map, of: Number, required: true },
    uploadedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, date: 1 }, { unique: true });
  return schema;
}

/** Registers TwItemSalesDay (tw_item_sales) on first call. */
export function itemSalesModel(connection: Connection): Model<ItemSalesFields> {
  const existing = connection.models.TwItemSalesDay as Model<ItemSalesFields> | undefined;
  return existing ?? connection.model<ItemSalesFields>('TwItemSalesDay', itemSalesSchema(), ITEM_SALES_COLLECTION);
}

/** One covered day: servings by item id. A lean read returns the Map as this plain object. */
export interface ItemSalesDay {
  readonly date: string;
  readonly items: Readonly<Record<string, number>>;
}

export interface ItemSalesCoverage {
  readonly firstDate: string;
  readonly lastDate: string;
  readonly dayCount: number;
}

const ITEM_ID = /^[0-9a-f]{24}$/;

/** Item ids become field names, so anything else (a dot, a dollar) is refused before it reaches the database. */
export function assertItemIds(items: Readonly<Record<string, number>>): void {
  if (!Object.keys(items).every((id) => ITEM_ID.test(id))) throw new Error('item ids must be 24 hex characters');
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ItemSalesStore {
  /**
   * `replace` (an org admin's upload): stores every sent day, replacing its items, then deletes the stored days from
   * `from` to `to` (inclusive) that were not sent; `stored` is the sent days and `kept` is 0. Otherwise (a member's):
   * inserts only the sent days not already stored and leaves every stored day as it is, deleting nothing; `stored` is
   * the days it inserted, `kept` the sent days already stored, and `removed` is 0. Either way a retry gives the same
   * days. The sent dates lie in the range (the handler checks). Two replacing uploads over overlapping ranges at once
   * are not merged: each day holds whichever upload wrote it last, and a day one sent and the other left out may be
   * deleted by the other's sweep. Last writer wins per day, as uploading again would give.
   */
  apply(scope: OrgScope, locationId: string, input: {
    from: string; to: string; days: readonly ItemSalesDay[]; now: Date; replace: boolean;
  }): Promise<{ stored: number; removed: number; kept: number }>;
  /** The covered days from `from` to `to`, inclusive, oldest first. */
  days(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<ItemSalesDay[]>;
  /** Null when no day is stored. */
  coverage(scope: OrgScope, locationId: string): Promise<ItemSalesCoverage | null>;
  /** True when the location has any item-sales day (the location delete's data check). */
  hasAny(scope: OrgScope, locationId: string): Promise<boolean>;
  /** The location's item sales, with its sales data or with the location. Resolves the number of days deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createItemSalesStore(connection: Connection): ItemSalesStore {
  const ItemSales = itemSalesModel(connection);
  const place = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });
  return {
    async apply(scope, locationId, input) {
      for (const day of input.days) assertItemIds(day.items);
      const key = place(scope, locationId);
      let inserted = 0;
      if (input.days.length > 0) {
        const ops = input.days.map((day) => {
          const fields = { items: { ...day.items }, uploadedAt: input.now };
          return {
            updateOne: { filter: { ...key, date: day.date }, update: input.replace ? { $set: fields } : { $setOnInsert: fields }, upsert: true },
          };
        });
        // Two uploads of one new day can both try to insert it; the one that loses matches the row on a second try.
        // Each attempt's inserts count, so a day this call inserted before the retry is not counted as kept.
        for (let attempt = 0; ; attempt += 1) {
          try {
            inserted += (await ItemSales.bulkWrite(ops, { ordered: false })).upsertedCount;
            break;
          } catch (err) {
            if (!isDuplicateKeyError(err) || attempt === 1) throw err;
            if (err instanceof mongoose.mongo.MongoBulkWriteError) inserted += err.upsertedCount;
          }
        }
      }
      if (!input.replace) return { stored: inserted, removed: 0, kept: input.days.length - inserted };
      const removed = await ItemSales.deleteMany({
        ...key, date: trusted({ $gte: input.from, $lte: input.to, $nin: input.days.map((day) => day.date) }),
      });
      return { stored: input.days.length, removed: removed.deletedCount, kept: 0 };
    },
    async days(scope, locationId, range) {
      const docs = await ItemSales
        .find({ ...place(scope, locationId), date: trusted({ $gte: range.from, $lte: range.to }) }, { _id: 0, date: 1, items: 1 })
        .sort({ date: 1 })
        .lean<ItemSalesDay[]>();
      return docs.map((doc) => ({ date: doc.date, items: { ...doc.items } }));
    },
    async coverage(scope, locationId) {
      const [row] = await ItemSales.aggregate<{ first: string; last: string; days: number }>([
        { $match: place(scope, locationId) },
        { $group: { _id: null, first: { $min: '$date' }, last: { $max: '$date' }, days: { $sum: 1 } } },
      ]);
      return row === undefined ? null : { firstDate: row.first, lastDate: row.last, dayCount: row.days };
    },
    async hasAny(scope, locationId) {
      return (await ItemSales.exists(place(scope, locationId))) !== null;
    },
    async removeForLocation(scope, locationId) {
      return (await ItemSales.deleteMany(place(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await ItemSales.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
