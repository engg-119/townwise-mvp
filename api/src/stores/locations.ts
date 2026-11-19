import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { CAUSES, type Cause } from '../lab/causes.ts';
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
  placeId: string | null;
  createdAt: Date;
  createdBy: string;
  /** True on a location Townwise staff added during setup (D23), with their user id as `createdBy`; absent otherwise. */
  byStaff?: boolean;
  /**
   * D59 (openspec change auto-apply-agent-reads, design decision 12): a change to the days the lab trains on wants a
   * refit: `wantedAt`, the latest such change (set with `$max`, cleared by compare-and-set on the value read), and
   * `startedAt`, when the hourly pass last tried one for it (a start or a refusal), and `starts`, when it actually started
   * one, the last REFIT_STARTS_KEPT (the weekly cap counts them). Absent until the first. D65 (openspec change
   * forecast-training-status, design decision 5): `causes`, what wanted it since the mark was last cleared (`$addToSet`
   * beside the `$max`, unset by the same clear); absent on a mark from before D65.
   */
  refit?: { wantedAt?: Date; startedAt?: Date; starts?: Date[]; causes?: Cause[] };
  /**
   * D59 slice 3 (design decision 1): a calendar refresh added or moved a keyed event in the next 91 days, so the weekly
   * pass is brought forward: `wantedAt`, the latest such refresh (`$max`), cleared by compare-and-set on the value the
   * hourly pass read. Absent until the first.
   */
  earlyPass?: { wantedAt?: Date };
}

function locationSchema(): Schema<LocationFields> {
  const schema = new Schema<LocationFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, minlength: 1, maxlength: 80 },
    nameKey: { type: String, required: true },
    town: { type: townFieldSchema(), required: true },
    placeId: { type: String, default: null, maxlength: 512 },
    createdAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
    byStaff: { type: Boolean },
    refit: {
      type: new Schema({
        wantedAt: { type: Date }, startedAt: { type: Date }, starts: { type: [Date], default: undefined },
        causes: { type: [String], enum: CAUSES, default: undefined },
      }, { _id: false, strict: true }),
    },
    earlyPass: { type: new Schema({ wantedAt: { type: Date } }, { _id: false, strict: true }) },
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
  readonly placeId: string | null;
  readonly createdAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface LocationStore {
  /** The organization's locations, oldest first. */
  list(scope: OrgScope): Promise<LocationRecord[]>;
  /** One location of this organization, else null (another organization's id included). */
  find(scope: OrgScope, locationId: string): Promise<LocationRecord | null>;
  count(scope: OrgScope): Promise<number>;
  /**
   * Null when this organization already has a location with that name (the unique nameKey index). `id`, when given, is
   * the id a staff event written before the insert already names; `byStaff` marks staff setup's (D23).
   */
  create(scope: OrgScope, input: {
    id?: string; name: string; town: Town; placeId: string | null; createdAt: Date; createdBy: string; byStaff?: boolean;
  }): Promise<LocationRecord | null>;
  /** Sets the fields given (`placeId` null clears it); `name_taken` when another location of this organization has that name. */
  update(scope: OrgScope, locationId: string, input: { name?: string | undefined; town?: Town | undefined; placeId?: string | null | undefined }):
    Promise<'updated' | 'not_found' | 'name_taken'>;
  remove(scope: OrgScope, locationId: string): Promise<boolean>;
  /**
   * F3 step 7: the location with this name in the organization, inserted once (`$setOnInsert`), so a retry finds it.
   * `placeId` is the stored location's, so a caller can tell when the name already belongs to a location for another place.
   */
  ensureByName(scope: OrgScope, input: { name: string; town: Town; placeId: string | null; createdAt: Date; createdBy: string }):
    Promise<{ id: string; inserted: boolean; placeId: string | null }>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
  /**
   * D59: marks the location as wanting a refit at `at`, or later (`$max`), adding `cause` to the mark's causes (D65).
   * False when the location is gone.
   */
  wantRefit(scope: OrgScope, locationId: string, at: Date, cause: Cause): Promise<boolean>;
  /** D59: the location's refit marks; nulls when none (or the location is gone). */
  refitState(scope: OrgScope, locationId: string): Promise<RefitState>;
  /**
   * D59: clears the mark and its causes only while it is still `wantedAt` (a compare-and-set), so a change landing
   * meanwhile stays, with every cause.
   */
  clearRefitWanted(scope: OrgScope, locationId: string, wantedAt: Date): Promise<boolean>;
  /**
   * D59: records that the hourly pass tried a refit at `at`, so the next waits a day; `started` when one actually started,
   * which the weekly cap counts.
   */
  markRefitStarted(scope: OrgScope, locationId: string, at: Date, started: boolean): Promise<boolean>;
  /** D59 slice 3: marks the location's weekly pass as brought forward at `at`, or later (`$max`). False when it is gone. */
  wantEarlyPass(scope: OrgScope, locationId: string, at: Date): Promise<boolean>;
  /** D59 slice 3: clears that mark only while it is still `wantedAt` (a compare-and-set), so a refresh meanwhile stays. */
  clearEarlyPass(scope: OrgScope, locationId: string, wantedAt: Date): Promise<boolean>;
}

/** D59: the refit starts a location keeps: at most one a day, so a week's worth and one more. */
export const REFIT_STARTS_KEPT = 8;

/**
 * D59: when a training change last wanted a refit, and when the hourly pass last started one; D65: what wanted it since
 * the mark was last cleared (`[]` when none was recorded).
 */
export interface RefitState { readonly wantedAt: Date | null; readonly startedAt: Date | null; readonly causes: readonly Cause[] }

function toLocation(doc: LocationFields & { _id: Types.ObjectId }): LocationRecord {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    town: { townId: doc.town.townId, name: doc.town.name, state: doc.town.state },
    // Locations stored before place ids have no such field.
    placeId: doc.placeId ?? null,
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
          ...(input.id === undefined ? {} : { _id: new Types.ObjectId(input.id) }),
          orgId: scope.orgId,
          name: input.name.trim(),
          nameKey: locationNameKey(input.name),
          town: { townId: input.town.townId, name: input.town.name, state: input.town.state },
          placeId: input.placeId,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          ...(input.byStaff === true ? { byStaff: true } : {}),
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
      if (input.placeId !== undefined) set.placeId = input.placeId;
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
            placeId: input.placeId,
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
      // Locations stored before place ids have no such field.
      return { id: doc._id.toHexString(), inserted, placeId: doc.placeId ?? null };
    },
    async removeForOrg(scope) {
      return (await Location.deleteMany({ orgId: scope.orgId })).deletedCount;
    },
    async wantRefit(scope, locationId, at, cause) {
      return (await Location.updateOne(
        { _id: locationId, orgId: scope.orgId }, { $max: { 'refit.wantedAt': at }, $addToSet: { 'refit.causes': cause } },
      )).matchedCount === 1;
    },
    async wantEarlyPass(scope, locationId, at) {
      return (await Location.updateOne({ _id: locationId, orgId: scope.orgId }, { $max: { 'earlyPass.wantedAt': at } })).matchedCount === 1;
    },
    async clearEarlyPass(scope, locationId, wantedAt) {
      const result = await Location.updateOne(
        { _id: locationId, orgId: scope.orgId, 'earlyPass.wantedAt': wantedAt }, { $unset: { 'earlyPass.wantedAt': 1 } },
      );
      return result.modifiedCount === 1;
    },
    async refitState(scope, locationId) {
      const doc = await Location.findOne({ _id: locationId, orgId: scope.orgId }, { refit: 1 }).lean();
      return { wantedAt: doc?.refit?.wantedAt ?? null, startedAt: doc?.refit?.startedAt ?? null, causes: doc?.refit?.causes ?? [] };
    },
    async clearRefitWanted(scope, locationId, wantedAt) {
      const result = await Location.updateOne(
        { _id: locationId, orgId: scope.orgId, 'refit.wantedAt': wantedAt }, { $unset: { 'refit.wantedAt': 1, 'refit.causes': 1 } },
      );
      return result.modifiedCount === 1;
    },
    async markRefitStarted(scope, locationId, at, started) {
      return (await Location.updateOne({ _id: locationId, orgId: scope.orgId }, {
        $set: { 'refit.startedAt': at },
        ...(started ? { $push: { 'refit.starts': { $each: [at], $slice: -REFIT_STARTS_KEPT } } } : {}),
      })).matchedCount === 1;
    },
  };
}
