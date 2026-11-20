// tw_business_rules (spec 6.24): standing facts about a location ("Closed Mondays") that TownwiseAI reads with every
// message. One document per rule. `text` is the owner's own words: no function here logs, and nothing copies it into an
// audit event. The unique { orgId, locationId, key } index refuses a rule that differs only in case. A rule may carry a
// `schedule` (D31): a note's fields but its detail, which the forecast read applies as it applies notes (spec 14.5). A
// rule stored without one has no `schedule` field at all. A schedule may repeat each year (D46, `season`); a schedule
// stored without one has no `season` field. D59 slice 3: a rule TownwiseAI added on its own (agent/apply.ts) carries
// `agent: { changeId, at }`, its ledger row and its `updatedAt` then; Undo removes it only while unchanged (removeIf).
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { NoteContent } from './notes.ts';

export const BUSINESS_RULES_COLLECTION = 'tw_business_rules';

/** At most this many rules per location; `list` reads no more. */
export const MAX_RULES = 30;

export type RuleVia = 'page' | 'townwise_ai';

/**
 * A rule's forecast effect (D31): a note's fields but its detail and title, since the rule's own text says what it is, with an
 * `endDate` of null for a schedule with no end. Validated by readRuleSchedule (handlers/notes.ts) with a note's rules.
 */
export interface RuleSchedule extends Omit<NoteContent, 'detail' | 'endDate' | 'title'> {
  /** Inclusive; null: no end ("ongoing"). */
  readonly endDate: string | null;
  /**
   * D46: the months and days the schedule covers every year from its start, `to` before `from` crossing the new year;
   * `endDate` is then null. Absent or null: none.
   */
  readonly season?: RuleSeason | null;
}

/** A yearly season: 'MM-DD' to 'MM-DD', both inclusive. */
export interface RuleSeason { readonly repeat: 'yearly'; readonly from: string; readonly to: string }

interface SeasonFields { repeat: 'yearly'; from: string; to: string }

interface ScheduleFields {
  kind: RuleSchedule['kind'];
  startDate: string;
  endDate: string | null;
  weekdays: number[] | null;
  effect: RuleSchedule['effect'];
  expectedGuests: number | null;
  startTime: string | null;
  endTime: string | null;
  /** Absent on a schedule with no season. */
  season?: SeasonFields;
}

interface BusinessRuleFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  text: string;
  /** `text.toLowerCase()`: the duplicate check. */
  key: string;
  addedVia: RuleVia;
  /** Absent on a rule with no schedule. */
  schedule?: ScheduleFields;
  createdBy: string;
  byStaff?: boolean;
  /** D59 slice 3: a rule TownwiseAI added on its own: its ledger row and the rule's `updatedAt` then. Absent otherwise. */
  agent?: { changeId: Types.ObjectId; at: Date };
  createdAt: Date;
  updatedAt: Date;
}

function scheduleSchema(): Schema<ScheduleFields> {
  return new Schema<ScheduleFields>({
    kind: { type: String, required: true, enum: ['closure', 'private_event', 'opening', 'other'] },
    startDate: { type: String, required: true },
    endDate: { type: String, default: null },
    weekdays: { type: [Number], default: null },
    effect: { type: String, required: true, enum: ['closed', 'more_guests', 'fewer_guests', 'unknown'] },
    expectedGuests: { type: Number, default: null },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    season: { type: seasonSchema(), required: false },
  }, { _id: false, strict: true, versionKey: false });
}

/** A rule schedule's yearly season (D46); also tw_agent_suggestions' content (stores/agent-suggestions.ts). */
export function seasonSchema(): Schema<SeasonFields> {
  return new Schema<SeasonFields>({
    repeat: { type: String, required: true, enum: ['yearly'] },
    from: { type: String, required: true, match: /^\d{2}-\d{2}$/ },
    to: { type: String, required: true, match: /^\d{2}-\d{2}$/ },
  }, { _id: false, strict: 'throw', versionKey: false });
}

function businessRuleSchema(): Schema<BusinessRuleFields> {
  const schema = new Schema<BusinessRuleFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    text: { type: String, required: true, maxlength: 400 },
    key: { type: String, required: true },
    addedVia: { type: String, required: true, enum: ['page', 'townwise_ai'] },
    schedule: { type: scheduleSchema(), required: false },
    createdBy: { type: String, required: true },
    byStaff: { type: Boolean },
    agent: {
      type: new Schema({
        changeId: { type: Schema.Types.ObjectId, required: true }, at: { type: Date, required: true },
      }, { _id: false, strict: 'throw' }),
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  // Also serves the list and the scheduled rules (the forecast read): filter on orgId and locationId, at most 30 rows
  // sorted in the query.
  schema.index({ orgId: 1, locationId: 1, key: 1 }, { unique: true });
  return schema;
}

/** Registers TwBusinessRule (tw_business_rules) on first call. */
export function businessRuleModel(connection: Connection): Model<BusinessRuleFields> {
  const existing = connection.models.TwBusinessRule as Model<BusinessRuleFields> | undefined;
  return existing ?? connection.model<BusinessRuleFields>('TwBusinessRule', businessRuleSchema(), BUSINESS_RULES_COLLECTION);
}

export interface BusinessRuleRecord {
  readonly id: string;
  readonly text: string;
  readonly addedVia: RuleVia;
  /** The rule's forecast effect; null: TownwiseAI reads the rule, and the forecast doesn't change. */
  readonly schedule: RuleSchedule | null;
  readonly createdBy: string;
  /** Made by Townwise staff in open as admin (D25); shown as "Townwise staff", never the staff email. */
  readonly byStaff: boolean;
  /** D59 slice 3: set on a rule TownwiseAI added on its own (its ledger row, and its updatedAt then); null otherwise (absent in older fixtures). */
  readonly agent?: { readonly changeId: string; readonly at: Date } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface BusinessRuleStore {
  /** Oldest first, at most MAX_RULES. */
  list(scope: OrgScope, locationId: string): Promise<BusinessRuleRecord[]>;
  /** The rules with a schedule, oldest first, at most MAX_RULES: the forecast read's and the lab input's. */
  scheduled(scope: OrgScope, locationId: string): Promise<BusinessRuleRecord[]>;
  /** One rule of this location, else null (another location's or organization's id included). */
  find(scope: OrgScope, locationId: string, ruleId: string): Promise<BusinessRuleRecord | null>;
  /** D59 slice 3: the rules of the organization with these ids (Undo's and the activity's reads). */
  byIds(scope: OrgScope, ids: readonly string[]): Promise<BusinessRuleRecord[]>;
  count(scope: OrgScope, locationId: string): Promise<number>;
  /** `id`, when given, becomes the rule's id. A duplicate id or key throws the duplicate key error. */
  create(
    scope: OrgScope, locationId: string,
    input: {
      text: string; schedule: RuleSchedule | null; addedVia: RuleVia; createdBy: string; now: Date; id?: string; byStaff?: boolean;
      /** D59 slice 3: the ledger row of a rule TownwiseAI adds on its own; `at` is `now`. */
      agent?: { changeId: string };
    },
  ): Promise<BusinessRuleRecord>;
  /**
   * Writes only the fields given: `text`, and `schedule` (null takes it off). Fields left out keep what they hold now,
   * so two edits of different fields racing both land. The rule as it is after, or null when it is gone. A duplicate key
   * throws.
   */
  update(
    scope: OrgScope, locationId: string, ruleId: string, change: { text?: string; schedule?: RuleSchedule | null }, now: Date,
  ): Promise<BusinessRuleRecord | null>;
  remove(scope: OrgScope, locationId: string, ruleId: string): Promise<boolean>;
  /** D59 slice 3 (Undo): deletes the rule only while its updatedAt is this one, by compare-and-set. */
  removeIf(scope: OrgScope, locationId: string, ruleId: string, updatedAt: Date): Promise<boolean>;
  /** Location deletion. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

/** True when both schedules have the same season, or neither has one (absent and null alike). */
export function sameSeason(a: RuleSeason | null | undefined, b: RuleSeason | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  return x === null || y === null ? x === y : x.from === y.from && x.to === y.to;
}

/** The duplicate check's key: the same rule in another case is the same rule. */
export function ruleKey(text: string): string {
  return text.toLowerCase();
}

function toSchedule(fields: ScheduleFields): RuleSchedule {
  return {
    kind: fields.kind,
    startDate: fields.startDate,
    endDate: fields.endDate ?? null,
    weekdays: fields.weekdays === null ? null : [...fields.weekdays],
    effect: fields.effect,
    expectedGuests: fields.expectedGuests ?? null,
    startTime: fields.startTime ?? null,
    endTime: fields.endTime ?? null,
    ...(fields.season === undefined ? {} : { season: { repeat: 'yearly', from: fields.season.from, to: fields.season.to } }),
  };
}

/** The stored schedule, field by field: a season only when it has one. */
function scheduleFieldsOf(schedule: RuleSchedule): ScheduleFields {
  const { season, ...rest } = schedule;
  return {
    ...rest, weekdays: schedule.weekdays === null ? null : [...schedule.weekdays],
    ...(season === undefined || season === null ? {} : { season: { repeat: 'yearly', from: season.from, to: season.to } }),
  };
}

function toRule(doc: BusinessRuleFields & { _id: Types.ObjectId }): BusinessRuleRecord {
  return {
    id: doc._id.toHexString(),
    text: doc.text,
    addedVia: doc.addedVia,
    schedule: doc.schedule === undefined ? null : toSchedule(doc.schedule),
    createdBy: doc.createdBy,
    byStaff: doc.byStaff === true,
    agent: doc.agent === undefined ? null : { changeId: doc.agent.changeId.toHexString(), at: doc.agent.at },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createBusinessRuleStore(connection: Connection): BusinessRuleStore {
  const Rule = businessRuleModel(connection);
  return {
    async list(scope, locationId) {
      const docs = await Rule.find({ orgId: scope.orgId, locationId }).sort({ createdAt: 1, _id: 1 }).limit(MAX_RULES).lean();
      return docs.map(toRule);
    },
    async scheduled(scope, locationId) {
      const docs = await Rule.find({ orgId: scope.orgId, locationId, schedule: trusted({ $type: 'object' }) })
        .sort({ createdAt: 1, _id: 1 }).limit(MAX_RULES).lean();
      return docs.map(toRule);
    },
    async find(scope, locationId, ruleId) {
      const doc = await Rule.findOne({ _id: ruleId, orgId: scope.orgId, locationId }).lean();
      return doc === null ? null : toRule(doc);
    },
    async byIds(scope, ids) {
      if (ids.length === 0) return [];
      const docs = await Rule.find({ orgId: scope.orgId, _id: trusted({ $in: ids.map((id) => new Types.ObjectId(id)) }) }).lean();
      return docs.map(toRule);
    },
    count(scope, locationId) {
      return Rule.countDocuments({ orgId: scope.orgId, locationId });
    },
    async create(scope, locationId, input) {
      const doc = await Rule.create({
        ...(input.id === undefined ? {} : { _id: new Types.ObjectId(input.id) }),
        orgId: scope.orgId, locationId, text: input.text, key: ruleKey(input.text), addedVia: input.addedVia,
        ...(input.schedule === null ? {} : { schedule: scheduleFieldsOf(input.schedule) }),
        createdBy: input.createdBy, ...(input.byStaff === true ? { byStaff: true } : {}),
        ...(input.agent === undefined ? {} : { agent: { changeId: new Types.ObjectId(input.agent.changeId), at: input.now } }),
        createdAt: input.now, updatedAt: input.now,
      });
      return toRule(doc.toObject());
    },
    async update(scope, locationId, ruleId, change, now) {
      const { text, schedule } = change;
      const set = {
        updatedAt: now,
        ...(text === undefined ? {} : { text, key: ruleKey(text) }),
        ...(schedule === undefined || schedule === null ? {} : { schedule: scheduleFieldsOf(schedule) }),
      };
      // Awaited as it is, with lean as an option, so a test can hold the call between two racing requests.
      const doc = await Rule.findOneAndUpdate(
        { _id: ruleId, orgId: scope.orgId, locationId },
        schedule === null ? { $set: set, $unset: { schedule: '' } } : { $set: set },
        { returnDocument: 'after', lean: true },
      );
      return doc === null ? null : toRule(doc);
    },
    async remove(scope, locationId, ruleId) {
      const result = await Rule.deleteOne({ _id: ruleId, orgId: scope.orgId, locationId });
      return result.deletedCount === 1;
    },
    async removeIf(scope, locationId, ruleId, updatedAt) {
      return (await Rule.deleteOne({ _id: ruleId, orgId: scope.orgId, locationId, updatedAt })).deletedCount === 1;
    },
    async removeForLocation(scope, locationId) {
      return (await Rule.deleteMany({ orgId: scope.orgId, locationId })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Rule.deleteMany({ orgId: scope.orgId })).deletedCount;
    },
  };
}
