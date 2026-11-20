// tw_research_spend (D66, spec 6.36, design decision 7): what town research has cost, a system month that no
// organization pays. One document per month (`_id: 'YYYY-MM'`, UTC) holds the month's total against
// TOWNWISE_RESEARCH_TOWN_MONTHLY_USD, and one per month and town (`_id: 'YYYY-MM:{townKey}'`) that town's slice, at most
// the cap divided by the towns in use that month, so one town cannot starve another. A town thread reserves its ceiling
// against both before its calls, by the compare-and-set chat usage uses (stores/chat-usage.ts), and settles to what it
// cost after. Location research never comes here: it spends its organization's TownwiseAI month.
// It holds no organization's data, so it is not a tenant store and takes no OrgScope (like stores/forecast-schedule.ts):
// a town key is a TownId of the twelve. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, type Connection, type Model } from 'mongoose';

import type { TownId } from '../towns.ts';

export const RESEARCH_SPEND_COLLECTION = 'tw_research_spend';

interface ResearchSpendFields {
  /** `YYYY-MM`, or `YYYY-MM:{townKey}`. */
  _id: string;
  costMicroUsd: number;
}

function researchSpendSchema(): Schema<ResearchSpendFields> {
  return new Schema<ResearchSpendFields>({
    _id: { type: String, required: true },
    costMicroUsd: { type: Number, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
}

/** Registers TwResearchSpend (tw_research_spend) on first call. */
export function researchSpendModel(connection: Connection): Model<ResearchSpendFields> {
  const existing = connection.models.TwResearchSpend as Model<ResearchSpendFields> | undefined;
  return existing ?? connection.model<ResearchSpendFields>('TwResearchSpend', researchSpendSchema(), RESEARCH_SPEND_COLLECTION);
}

export interface ResearchSpendStore {
  /** The month's total and the town's slice so far, in micro-dollars (0 before any). */
  spent(month: string, townKey: TownId): Promise<{ month: number; town: number }>;
  /**
   * Adds `costMicroUsd` to the month and to the town's slice only while the month stays within `capMicroUsd` and the
   * slice within `sliceMicroUsd` with it. Each is one compare-and-set, the month's first; when the slice refuses, the
   * month's share is given back. False, adding nothing, when either would pass.
   */
  reserve(input: { month: string; townKey: TownId; costMicroUsd: number; capMicroUsd: number; sliceMicroUsd: number }): Promise<boolean>;
  /** Adds a cost to the month and the town's slice (a negative one settles a reservation to what it cost). */
  add(input: { month: string; townKey: TownId; costMicroUsd: number }): Promise<void>;
}

export function createResearchSpendStore(connection: Connection): ResearchSpendStore {
  const Spend = researchSpendModel(connection);
  const sliceId = (month: string, townKey: TownId) => `${month}:${townKey}`;

  /** The chat-usage reserve on one document: within `limit` with `cost`, or the document's first cost. */
  async function reserveOne(id: string, cost: number, limit: number): Promise<boolean> {
    const fits = { _id: id, costMicroUsd: trusted({ $lte: limit - cost }) };
    if ((await Spend.updateOne(fits, { $inc: { costMicroUsd: cost } })).matchedCount === 1) return true;
    if (cost > limit) return false;
    try {
      await Spend.create({ _id: id, costMicroUsd: cost });
      return true;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      return (await Spend.updateOne(fits, { $inc: { costMicroUsd: cost } })).matchedCount === 1;
    }
  }

  async function addOne(id: string, cost: number): Promise<void> {
    try {
      await Spend.updateOne({ _id: id }, { $inc: { costMicroUsd: cost } }, { upsert: true });
    } catch (err) {
      // Two first costs of a month raced on the id; the other one created the document.
      if (!isDuplicateKeyError(err)) throw err;
      await Spend.updateOne({ _id: id }, { $inc: { costMicroUsd: cost } });
    }
  }

  return {
    async spent(month, townKey) {
      const docs = await Spend.find({ _id: trusted({ $in: [month, sliceId(month, townKey)] }) }).lean();
      const of = (id: string) => docs.find((doc) => doc._id === id)?.costMicroUsd ?? 0;
      return { month: of(month), town: of(sliceId(month, townKey)) };
    },
    async reserve(input) {
      if (!(await reserveOne(input.month, input.costMicroUsd, input.capMicroUsd))) return false;
      if (await reserveOne(sliceId(input.month, input.townKey), input.costMicroUsd, input.sliceMicroUsd)) return true;
      await addOne(input.month, -input.costMicroUsd);
      return false;
    },
    async add(input) {
      await addOne(input.month, input.costMicroUsd);
      await addOne(sliceId(input.month, input.townKey), input.costMicroUsd);
    },
  };
}
