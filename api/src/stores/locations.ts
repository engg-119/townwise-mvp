import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, type Connection, type Model, type Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { Town } from '../towns.ts';

/** `{ townId, name, state }`, shared by locations and access requests. townId is validated on input. */
export function townFieldSchema(): Schema<Town> {
  return new Schema<Town>({
    townId: { type: String, default: null },
    name: { type: String, required: true },
    state: { type: String, required: true },
  }, { _id: false, strict: true });
}

export interface LocationFields {
  orgId: Types.ObjectId;
  name: string;
  nameKey: string;
  town: Town;
  createdAt: Date;
  createdBy: string;
}

function locationSchema(): Schema<LocationFields> {
  const schema = new Schema<LocationFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, minlength: 1, maxlength: 80 },
    nameKey: { type: String, required: true },
    town: { type: townFieldSchema(), required: true },
    createdAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, nameKey: 1 }, { unique: true });
  schema.index({ orgId: 1, createdAt: 1 });
  return schema;
}

/** Registers TwLocation (tw_locations) on first call. */
export function locationModel(connection: Connection): Model<LocationFields> {
  const existing = connection.models.TwLocation as Model<LocationFields> | undefined;
  return existing ?? connection.model<LocationFields>('TwLocation', locationSchema(), 'tw_locations');
}

/** `name` trimmed, lowercased, inner spaces collapsed (spec 6.4). */
export function locationNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface LocationRecord {
  readonly id: string;
  readonly name: string;
  readonly town: Town;
  readonly createdAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface LocationStore {
  /** The organization's locations, oldest first. */
  list(scope: OrgScope): Promise<LocationRecord[]>;
  /** One location of this organization, else null (another organization's id included). */
  find(scope: OrgScope, locationId: string): Promise<LocationRecord | null>;
  count(scope: OrgScope): Promise<number>;
  /** Null when this organization already has a location with that name (the unique nameKey index). */
  create(scope: OrgScope, input: { name: string; town: Town; createdAt: Date; createdBy: string }): Promise<LocationRecord | null>;
  /** Sets the fields given; `name_taken` when another location of this organization has that name. */
  update(scope: OrgScope, locationId: string, input: { name?: string | undefined; town?: Town | undefined }):
    Promise<'updated' | 'not_found' | 'name_taken'>;
  remove(scope: OrgScope, locationId: string): Promise<boolean>;
  /** F3 step 7: the location with this name in the organization, inserted once (`$setOnInsert`), so a retry finds it. */
  ensureByName(scope: OrgScope, input: { name: string; town: Town; createdAt: Date; createdBy: string }):
    Promise<{ id: string; inserted: boolean }>;
}

function toLocation(doc: LocationFields & { _id: Types.ObjectId }): LocationRecord {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    town: { townId: doc.town.townId, name: doc.town.name, state: doc.town.state },
    createdAt: doc.createdAt,
  };
}

export function createLocationStore(connection: Connection): LocationStore {
  const Location = locationModel(connection);
  return {
    async list(scope) {
      const docs = await Location.find({ orgId: scope.orgId }).sort({ createdAt: 1, _id: 1 }).lean();
      return docs.map(toLocation);
    },
    async find(scope, locationId) {
      const doc = await Location.findOne({ _id: locationId, orgId: scope.orgId }).lean();
      return doc === null ? null : toLocation(doc);
    },
    count(scope) {
      return Location.countDocuments({ orgId: scope.orgId });
    },
    async create(scope, input) {
      try {
        const doc = await Location.create({
          orgId: scope.orgId,
          name: input.name.trim(),
          nameKey: locationNameKey(input.name),
          town: { townId: input.town.townId, name: input.town.name, state: input.town.state },
          createdAt: input.createdAt,
          createdBy: input.createdBy,
        });
        return toLocation(doc.toObject());
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
    },
    async update(scope, locationId, input) {
      const set: Partial<LocationFields> = {};
      if (input.name !== undefined) {
        set.name = input.name.trim();
        set.nameKey = locationNameKey(input.name);
      }
      if (input.town !== undefined) set.town = { townId: input.town.townId, name: input.town.name, state: input.town.state };
      try {
        const result = await Location.updateOne({ _id: locationId, orgId: scope.orgId }, { $set: set });
        return result.matchedCount === 1 ? 'updated' : 'not_found';
      } catch (err) {
        if (isDuplicateKeyError(err)) return 'name_taken';
        throw err;
      }
    },
    async remove(scope, locationId) {
      const result = await Location.deleteOne({ _id: locationId, orgId: scope.orgId });
      return result.deletedCount === 1;
    },
    async ensureByName(scope, input) {
      const filter = { orgId: scope.orgId, nameKey: locationNameKey(input.name) };
      let inserted = false;
      try {
        const result = await Location.updateOne(filter, {
          $setOnInsert: {
            name: input.name.trim(),
            town: { townId: input.town.townId, name: input.town.name, state: input.town.state },
            createdAt: input.createdAt,
            createdBy: input.createdBy,
          },
        }, { upsert: true });
        inserted = result.upsertedCount === 1;
      } catch (err) {
        // A concurrent retry inserted it first.
        if (!isDuplicateKeyError(err)) throw err;
      }
      const doc = await Location.findOne(filter).lean();
      if (doc === null) throw new Error('location missing after its upsert');
      return { id: doc._id.toHexString(), inserted };
    },
  };
}
