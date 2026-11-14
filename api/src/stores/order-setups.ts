// tw_order_setups (design Decision 3, the order-setup spec): one document per location holding its ordering setup,
// written whole under compare-and-set on `version`. The first save inserts version 1 and the unique index turns a
// racing first save into 'changed'. The schema is strict: 'throw' and the write builds each row field by field, so
// nothing else is stored. It goes with the location and the organization, never with the sales data.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { ORDER_CATEGORIES, ORDER_UNITS, type OrderSetup } from '../orders/setup.ts';

export const ORDER_SETUPS_COLLECTION = 'tw_order_setups';

interface SetupFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  version: number;
  suppliers: OrderSetup['suppliers'];
  items: OrderSetup['items'];
  updatedAt: Date;
}

const STRICT = { strict: 'throw', _id: false } as const;

function setupSchema(): Schema<SetupFields> {
  const delivery = new Schema({
    deliveryWeekday: { type: Number, required: true },
    cutoffWeekday: { type: Number, required: true },
    cutoffTime: { type: String, required: true },
  }, STRICT);
  const supplier = new Schema({
    id: { type: String, required: true },
    name: { type: String, required: true },
    deliveries: { type: [delivery] },
  }, STRICT);
  const posName = new Schema({
    name: { type: String, required: true },
    perSale: { type: Number, required: true },
  }, STRICT);
  const item = new Schema({
    id: { type: String, required: true },
    name: { type: String, required: true },
    supplierId: { type: String, required: true },
    category: { type: String, required: true, enum: ORDER_CATEGORIES },
    unit: { type: String, required: true, enum: ORDER_UNITS },
    servingsPerUnit: { type: Number, required: true },
    par: { type: Number, required: true },
    dealSize: { type: Number },
    neverRunOut: { type: Boolean, required: true },
    posNames: { type: [posName] },
  }, STRICT);
  const schema = new Schema<SetupFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    suppliers: { type: [supplier] },
    items: { type: [item] },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1 }, { unique: true });
  return schema;
}

/** Registers TwOrderSetup (tw_order_setups) on first call. */
export function orderSetupModel(connection: Connection): Model<SetupFields> {
  const existing = connection.models.TwOrderSetup as Model<SetupFields> | undefined;
  return existing ?? connection.model<SetupFields>('TwOrderSetup', setupSchema(), ORDER_SETUPS_COLLECTION);
}

export interface StoredSetup extends OrderSetup {
  readonly version: number;
  readonly updatedAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface OrderSetupStore {
  get(scope: OrgScope, locationId: string): Promise<StoredSetup | null>;
  /**
   * Stores the setup when `expectedVersion` is the stored version (0: none stored yet), as that version plus one.
   * 'changed' when someone saved first. The setup comes from mintIds (orders/setup.ts), so every row has an id.
   */
  save(scope: OrgScope, locationId: string, expectedVersion: number, setup: OrderSetup, now: Date): Promise<StoredSetup | 'changed'>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). */
  removeForOrg(scope: OrgScope): Promise<number>;
}

/** Field by field, so a caller's extra keys never reach the strict schema. */
function rows(setup: OrderSetup): Pick<SetupFields, 'suppliers' | 'items'> {
  return {
    suppliers: setup.suppliers.map((supplier) => ({
      id: supplier.id,
      name: supplier.name,
      deliveries: supplier.deliveries.map((d) => ({ deliveryWeekday: d.deliveryWeekday, cutoffWeekday: d.cutoffWeekday, cutoffTime: d.cutoffTime })),
    })),
    items: setup.items.map((item) => ({
      id: item.id, name: item.name, supplierId: item.supplierId, category: item.category, unit: item.unit,
      servingsPerUnit: item.servingsPerUnit, par: item.par, dealSize: item.dealSize, neverRunOut: item.neverRunOut,
      posNames: item.posNames.map((pos) => ({ name: pos.name, perSale: pos.perSale })),
    })),
  };
}

function toStored(doc: SetupFields): StoredSetup {
  return { version: doc.version, updatedAt: doc.updatedAt, ...rows(doc) };
}

export function createOrderSetupStore(connection: Connection): OrderSetupStore {
  const Setup = orderSetupModel(connection);
  const place = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });
  return {
    async get(scope, locationId) {
      const doc = await Setup.findOne(place(scope, locationId)).lean();
      return doc === null ? null : toStored(doc);
    },
    async save(scope, locationId, expectedVersion, setup, now) {
      if (expectedVersion === 0) {
        try {
          const doc = await Setup.create({ ...place(scope, locationId), version: 1, ...rows(setup), updatedAt: now });
          return toStored(doc.toObject());
        } catch (err) {
          if (isDuplicateKeyError(err)) return 'changed';
          throw err;
        }
      }
      const doc = await Setup.findOneAndUpdate(
        { ...place(scope, locationId), version: expectedVersion },
        { $set: { ...rows(setup), updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? 'changed' : toStored(doc);
    },
    async removeForLocation(scope, locationId) {
      return (await Setup.deleteMany(place(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Setup.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
