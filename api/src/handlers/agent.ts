// TownwiseAI's side panel (spec 10.12, docs/portal/tuning-chat.md section 8): GET .../agent reads the questions and
// the activity, both computed at read time from the location's own records; POST .../agent/questions/:questionId
// answers one question. There are no transactions, so an answer is ordered for retries: claim the question
// (tw_agent_answers, which gives it its note id once), write the closure note a `closed` answer makes with that id,
// then mark the answer done. A retry, a crash between the steps or a second tab end with one note. A `closed` try whose
// note is written stands over a different answer (the note exists); any other answer stands only if the row still holds
// it when it is marked done, else the request answers with what the row holds. Logs and the audit event carry ids and
// the answer only.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { activityFor, type ActivityItem } from '../agent/activity.ts';
import {
  closureNoteOf, parseQuestionId, QUESTION_ANSWERS, questionsFor, questionWindow, type Question, type QuestionAnswer,
} from '../agent/questions.ts';
import { utcDay } from '../dates.ts';
import { currentEmail } from '../people.ts';
import type { AnswerKey, AnswerRecord } from '../stores/agent-answers.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import { loadLocation, memberOf } from './locations.ts';
import { addNote, noteContent, noteView, type NoteView } from './notes.ts';
import { actorOf } from './team.ts';

/** A question id: dates and a weekday number only, never text. */
const questionIdSchema = z.string().regex(/^(gap|weekday)_[0-9_-]{10,40}$/);
const answerBody = z.object({ answer: z.enum(QUESTION_ANSWERS) });

export interface AgentPanel { questions: Question[]; activity: ActivityItem[] }

export interface AnswerResult {
  question: { id: string; answer: QuestionAnswer };
  /** The closure note a `closed` answer saved, or null (any other answer, or the note was deleted since). */
  note: NoteView | null;
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The questions currently asked at the location, with the records they came from. */
async function currentQuestions(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord): Promise<{
  questions: Question[]; notes: NoteRecord[]; answers: AnswerRecord[];
}> {
  const { scope } = caller;
  const [coverage, notes, answers] = await Promise.all([
    ctx.stores.salesDays.coverage(scope, location.id),
    ctx.stores.notes.list(scope, location.id),
    ctx.stores.agentAnswers.list(scope, location.id),
  ]);
  const window = questionWindow(coverage);
  // D28: a turned-off upload's days are left out of `days` and explained by `turnedOff`, so they are never asked about.
  const [days, turnedOff] = window === null ? [[], []] : await Promise.all([
    ctx.stores.salesDays.days(scope, location.id, window),
    ctx.stores.salesDays.disabledDates(scope, location.id, window),
  ]);
  // A save still in progress is not answered yet: the question stays until its answer is done.
  const answered = answers.filter((row) => row.status === 'done').map((row) => row.questionId);
  return { questions: questionsFor({ coverage, days, notes, answered, turnedOff }), notes, answers };
}

/** GET /api/org/locations/:locationId/agent. */
export async function getAgent(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const { questions, notes, answers } = await currentQuestions(ctx, caller, location);
  const activity = await activityFor({ ctx, scope: caller.scope, locationId: location.id, userId: caller.userId, notes, answers });
  const body: AgentPanel = { questions, activity };
  res.status(200).json(body);
}

async function answerNote(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, row: AnswerRecord): Promise<NoteView | null> {
  if (row.answer !== 'closed') return null;
  const note = await ctx.stores.notes.find(caller.scope, location.id, row.noteId);
  return note === null ? null : noteView(note, await currentEmail(ctx, note.createdBy), caller);
}

/** POST /api/org/locations/:locationId/agent/questions/:questionId { answer }. */
export async function answerQuestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const { answer } = parseInput(answerBody, req.body);
  const questionId = parseInput(questionIdSchema, req.params.questionId);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const asked = parseQuestionId(questionId);
  if (asked === null) throw notFound();
  const answers = ctx.stores.agentAnswers;
  const key: AnswerKey = { locationId: location.id, questionId };

  const existing = await answers.find(scope, key);
  let result: AnswerResult;
  if (existing?.status === 'done') {
    // Answered already, by an earlier press, another tab or a colleague: answer with that.
    result = { question: { id: questionId, answer: existing.answer }, note: await answerNote(ctx, caller, location, existing) };
  } else {
    // An earlier `closed` try that wrote its note and stopped before `done` is finished as `closed`, whatever this answer
    // is: the note exists. Otherwise only a question the panel asks now, so a stale panel cannot answer days that
    // have since gained sales or a note.
    const noteWritten = existing?.answer === 'closed'
      && (await ctx.stores.notes.find(scope, location.id, existing.noteId)) !== null;
    if (!noteWritten && !(await currentQuestions(ctx, caller, location)).questions.some((q) => q.id === questionId)) {
      throw notFound();
    }
    const claimed = await answers.claim(scope, key, { answer: noteWritten ? 'closed' : answer, now: ctx.now() });
    if (claimed !== null && claimed.answer === 'closed') {
      await addNote(ctx, caller, location, noteContent(closureNoteOf(asked), utcDay(ctx.now())), { id: claimed.noteId });
    }
    if (claimed !== null && await answers.markDone(scope, key, { answer: claimed.answer, now: ctx.now() })) {
      await recordAfter(ctx, {
        ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.question_answered',
        target: { type: 'location', id: location.id },
        details: { locationId: location.id, questionId, answer: claimed.answer },
      });
    }
    // Answer with what the row holds now: this answer, or the one another tab or colleague stored first.
    const row = await answers.find(scope, key);
    if (row === null) throw notFound();
    result = { question: { id: questionId, answer: row.answer }, note: await answerNote(ctx, caller, location, row) };
  }
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, answer: result.question.answer }, 'townwise.agent_answer');
  res.status(200).json(result);
}
