// tw_agent_answers (spec 6.17, docs/portal/tuning-chat.md section 8): the answers to TownwiseAI's questions about a
// location's days with no sales, keyed by the question's id (dates and a weekday number only). An answer claims its row
// (`saving`), writes the closure note a `closed` answer makes with the row's `noteId`, then marks it `done`, so a retry
// or a second tab finishes the same note instead of making another (handlers/agent.ts). Every row gets its `noteId`
// when it is inserted, whatever the answer. It holds no person id (the audit event carries the actor) and no text.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { QuestionAnswer } from '../agent/questions.ts';

export const AGENT_ANSWERS_COLLECTION = 'tw_agent_answers';

export type AnswerStatus = 'saving' | 'done';

interface AnswerFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  questionId: string;
  answer: QuestionAnswer;
  noteId: Types.ObjectId;
  status: AnswerStatus;
  createdAt: Date;
  updatedAt: Date;
}

function answerSchema(): Schema<AnswerFields> {
  const schema = new Schema<AnswerFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    questionId: { type: String, required: true },
    answer: { type: String, required: true, enum: ['closed', 'open', 'not_sure'] },
    noteId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, required: true, enum: ['saving', 'done'] },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, questionId: 1 }, { unique: true });
  return schema;
}

/** Registers TwAgentAnswer (tw_agent_answers) on first call. */
export function agentAnswerModel(connection: Connection): Model<AnswerFields> {
  const existing = connection.models.TwAgentAnswer as Model<AnswerFields> | undefined;
  return existing ?? connection.model<AnswerFields>('TwAgentAnswer', answerSchema(), AGENT_ANSWERS_COLLECTION);
}

export interface AnswerRecord {
  readonly questionId: string;
  readonly answer: QuestionAnswer;
  readonly noteId: string;
  readonly status: AnswerStatus;
  readonly updatedAt: Date;
}

/** One answer: the location and the question's id. */
export interface AnswerKey {
  readonly locationId: string;
  readonly questionId: string;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface AgentAnswerStore {
  /** Every answer of the location, newest first. */
  list(scope: OrgScope, locationId: string): Promise<AnswerRecord[]>;
  find(scope: OrgScope, key: AnswerKey): Promise<AnswerRecord | null>;
  /**
   * Claims the question for this answer: inserts it as `saving`, or moves a `saving` row (an earlier try that stopped)
   * to this answer, keeping its `noteId`. Null when it is already done.
   */
  claim(scope: OrgScope, key: AnswerKey, input: { answer: QuestionAnswer; now: Date }): Promise<AnswerRecord | null>;
  /** `saving` to `done`. True only for the call that moved it, so the answer is recorded once. */
  markDone(scope: OrgScope, key: AnswerKey, now: Date): Promise<boolean>;
  /** Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type AnswerDoc = AnswerFields & { _id: Types.ObjectId };

function toRecord(doc: AnswerDoc): AnswerRecord {
  return { questionId: doc.questionId, answer: doc.answer, noteId: doc.noteId.toHexString(), status: doc.status, updatedAt: doc.updatedAt };
}

export function createAgentAnswerStore(connection: Connection): AgentAnswerStore {
  const Answer = agentAnswerModel(connection);
  const ofLocation = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });
  const keyOf = (scope: OrgScope, key: AnswerKey) => ({ ...ofLocation(scope, key.locationId), questionId: key.questionId });
  return {
    async list(scope, locationId) {
      const docs = await Answer.find(ofLocation(scope, locationId)).sort({ updatedAt: -1, _id: -1 }).lean();
      return docs.map(toRecord);
    },
    async find(scope, key) {
      const doc = await Answer.findOne(keyOf(scope, key)).lean();
      return doc === null ? null : toRecord(doc);
    },
    async claim(scope, key, input) {
      // A done row matches nothing, so the insert fails on the unique index. The first of two concurrent inserts fails
      // the same way, so a duplicate is tried once more, and then matches the row the other made.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const doc = await Answer.findOneAndUpdate(
            { ...keyOf(scope, key), status: trusted({ $ne: 'done' }) },
            {
              $set: { answer: input.answer, status: 'saving', updatedAt: input.now },
              $setOnInsert: { noteId: new Types.ObjectId(), createdAt: input.now },
            },
            { upsert: true, returnDocument: 'after' },
          ).lean();
          return toRecord(doc);
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          if (attempt === 1) return null;
        }
      }
    },
    async markDone(scope, key, now) {
      const result = await Answer.updateOne({ ...keyOf(scope, key), status: 'saving' }, { $set: { status: 'done', updatedAt: now } });
      return result.modifiedCount === 1;
    },
    async removeForLocation(scope, locationId) {
      return (await Answer.deleteMany(ofLocation(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Answer.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
