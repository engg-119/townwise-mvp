// tw_forecast_schedule (D42, spec 6.25): one document, `{ _id: 'weekly', owner, leaseUntil, paused, suggestionsAt }`.
// The weekly refresh's lease (10 minutes, taken and renewed by compare-and-set as the file sweep's is, so overlapping
// worker executions do no harm), the staff pause (`{ at, by, email }` of the staff member, or null), which pauses the
// whole weekly worker, weekly suggestions included, and when a pass last ran the weekly suggestions (openspec change
// weekly-forecast-suggestions; null or absent before the first), which TownwiseAI's panel reads to say whether they
// run. It holds no organization's data, so it is not a tenant store and takes no OrgScope: the weekly worker
// (lab/schedule.ts), the staff route that pauses it (handlers/calibrations.ts), the next refresh date (calibration.ts)
// and the panel (handlers/weekly-suggestions.ts) read it here. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, type Connection, type Model } from 'mongoose';

export const FORECAST_SCHEDULE_COLLECTION = 'tw_forecast_schedule';
const SCHEDULE_ID = 'weekly';

export interface SchedulePause {
  at: Date;
  /** The staff member's user id. */
  by: string;
  email: string;
}

interface ForecastScheduleFields {
  _id: string;
  owner: string | null;
  leaseUntil: Date;
  paused: SchedulePause | null;
  suggestionsAt: Date | null;
}

function forecastScheduleSchema(): Schema<ForecastScheduleFields> {
  const paused = new Schema<SchedulePause>({
    at: { type: Date, required: true },
    by: { type: String, required: true },
    email: { type: String, required: true },
  }, { _id: false, strict: 'throw' });
  return new Schema<ForecastScheduleFields>({
    _id: { type: String, required: true },
    owner: { type: String, default: null },
    leaseUntil: { type: Date, required: true },
    paused: { type: paused, default: null },
    suggestionsAt: { type: Date, default: null },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
}

/** Registers TwForecastSchedule (tw_forecast_schedule) on first call. */
export function forecastScheduleModel(connection: Connection): Model<ForecastScheduleFields> {
  const existing = connection.models.TwForecastSchedule as Model<ForecastScheduleFields> | undefined;
  return existing ?? connection.model<ForecastScheduleFields>('TwForecastSchedule', forecastScheduleSchema(), FORECAST_SCHEDULE_COLLECTION);
}

export interface ForecastScheduleStore {
  /**
   * Takes the lease for `owner` when nobody holds a live one (the first pass ever creates the document). Resolves
   * whether it was taken and the pause as it is now.
   */
  claim(input: { owner: string; now: Date; leaseMs: number }): Promise<{ claimed: boolean; paused: SchedulePause | null }>;
  /** Extends the lease while `owner` still holds it; false once another pass took it. */
  renew(input: { owner: string; now: Date; leaseMs: number }): Promise<boolean>;
  /** Ends `owner`'s lease, so the next pass need not wait out its 10 minutes. */
  release(input: { owner: string; now: Date }): Promise<void>;
  /** The staff pause, or null (no document yet included). */
  paused(): Promise<SchedulePause | null>;
  /** Sets or clears the staff pause. */
  setPaused(paused: SchedulePause | null, now: Date): Promise<void>;
  /** Records that `owner`'s pass is running the weekly suggestions now (while it holds the lease). */
  markSuggestionsRan(input: { owner: string; now: Date }): Promise<void>;
  /** When a pass last ran the weekly suggestions (null before the first), and whether staff paused the worker. */
  suggestionsState(): Promise<{ ranAt: Date | null; paused: boolean }>;
}

export function createForecastScheduleStore(connection: Connection): ForecastScheduleStore {
  const Schedule = forecastScheduleModel(connection);
  const pauseOf = (doc: { paused: SchedulePause | null } | null): SchedulePause | null => (doc?.paused == null
    ? null : { at: doc.paused.at, by: doc.paused.by, email: doc.paused.email });
  return {
    async claim(input) {
      const until = new Date(input.now.getTime() + input.leaseMs);
      const taken = await Schedule.findOneAndUpdate(
        { _id: SCHEDULE_ID, leaseUntil: trusted({ $lte: input.now }) },
        { $set: { owner: input.owner, leaseUntil: until } },
        { returnDocument: 'after' },
      ).lean();
      if (taken !== null) return { claimed: true, paused: pauseOf(taken) };
      try {
        await Schedule.create({ _id: SCHEDULE_ID, owner: input.owner, leaseUntil: until, paused: null });
        return { claimed: true, paused: null };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        return { claimed: false, paused: pauseOf(await Schedule.findById(SCHEDULE_ID).lean()) };
      }
    },
    async renew(input) {
      const result = await Schedule.updateOne(
        { _id: SCHEDULE_ID, owner: input.owner },
        { $set: { leaseUntil: new Date(input.now.getTime() + input.leaseMs) } },
      );
      return result.matchedCount === 1;
    },
    async release(input) {
      await Schedule.updateOne({ _id: SCHEDULE_ID, owner: input.owner }, { $set: { leaseUntil: input.now } });
    },
    async paused() {
      return pauseOf(await Schedule.findById(SCHEDULE_ID).lean());
    },
    async setPaused(paused, now) {
      // The first write ever creates the document with an expired lease, so the next pass can take it.
      await Schedule.updateOne(
        { _id: SCHEDULE_ID },
        { $set: { paused }, $setOnInsert: { owner: null, leaseUntil: now } },
        { upsert: true },
      );
    },
    async markSuggestionsRan(input) {
      await Schedule.updateOne({ _id: SCHEDULE_ID, owner: input.owner }, { $set: { suggestionsAt: input.now } });
    },
    async suggestionsState() {
      const doc = await Schedule.findById(SCHEDULE_ID).lean();
      return { ranAt: doc?.suggestionsAt ?? null, paused: doc?.paused != null };
    },
  };
}
