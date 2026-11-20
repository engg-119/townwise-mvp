// TownwiseAI's side panel (spec 10.12, docs/portal/tuning-chat.md section 8): GET .../agent reads the questions and
// the activity, both computed at read time from the location's own records, and the weekly suggestions still open
// (handlers/weekly-suggestions.ts); POST .../agent/questions/:questionId
// answers one question. There are no transactions, so an answer is ordered for retries: claim the question
// (tw_agent_answers, which gives it its note id once), write the note the answer saves (a closure note, or a likely-closed
// day's open-day note) with that id, then mark the answer done. A retry, a crash between the steps or a second tab end
// with one note, and the note with the row's id decides the answer: a try whose note is written stands over a different
// answer (the note exists); any other answer stands only if the row still holds it when it is marked done, else the
// request answers with what the row holds. The body is the answer alone: Something else (`other`) never carries the
// person's words, which go to the chat. Logs and the audit event carry ids and the answer only.
//
// D71: a past private event's guests (`party_guests_<noteId>`). The body is `{ answer: 'guests', guests }` or Skip's
// `{ answer: 'not_sure' }`. The note is read under the caller's scope (another organization's, or a gone one, is 404);
// the row is claimed with the note's id; the count is written into that note by a compare-and-set on its `updatedAt`
// (notes.ts editNote: the notes rules, `note.updated`, the refit mark), so a concurrent edit is never overwritten and
// the first of two counts wins; then the row is done. Any member may answer, the note's author or not (the owner's
// call), and the edit sets that note's expectedGuests only. A count already in the note (written by an earlier try, or
// typed on the Notes page) is never written again. Neither the log nor either audit event carries the count.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { activityFor, type ActivityItem } from '../agent/activity.ts';
import { agentAutoView, type AgentAutoView } from './agent-changes.ts';
import { questionInputAt } from '../agent/question-input.ts';
import {
  answerOfNote, DAY_ANSWERS, guestCountQuestionsFor, hasGuestCount, noteFor, panelQuestionsFor, parseQuestionId, questionsFor,
  wantsGuestCount, type DayAsked, type PanelQuestion, type QuestionAnswer,
} from '../agent/questions.ts';
import { utcDay } from '../dates.ts';
import { authorEmail } from '../people.ts';
import type { AnswerKey, AnswerRecord } from '../stores/agent-answers.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import { loadLocation, memberOf } from './locations.ts';
import { addNote, editNote, MAX_EXPECTED_GUESTS, noteContent, noteView, type NoteView } from './notes.ts';
import { actorOf } from './team.ts';
import {
  noteSuggestionViews, ruleSuggestionViews, type NoteSuggestionView, type RuleSuggestionView,
} from '../agent/rule-suggestion-views.ts';
import { suggestionsPanel, type SuggestionView, type WeeklySuggestionsView } from './weekly-suggestions.ts';

/** A question id: dates and a weekday number, or (D71) a note's id, only; never text. */
const questionIdSchema = z.string().regex(/^((gap|weekday|likely_closed)_[0-9_-]{10,40}|party_guests_[0-9a-f]{24})$/);
/**
 * The answer and nothing else: any other key, the person's words included, is refused. D71: `guests` carries the count
 * a private event's question asks for, a whole number of guests as a note takes.
 */
const answerBody = z.union([
  z.strictObject({ answer: z.enum(DAY_ANSWERS) }),
  z.strictObject({ answer: z.literal('guests'), guests: z.number().int().min(1).max(MAX_EXPECTED_GUESTS) }),
]);
/** D71: the answers a private event's question takes: its count, or Skip. */
const PARTY_ANSWERS: readonly QuestionAnswer[] = ['guests', 'not_sure'];

/**
 * The panel: the questions, the activity, (openspec change weekly-forecast-suggestions) the open weekly suggestions
 * with the organization's switch, and (D46) the open suggested closure rules from files and the sales history.
 */
export interface AgentPanel {
  questions: PanelQuestion[]; activity: ActivityItem[]; suggestions: SuggestionView[]; weeklySuggestions: WeeklySuggestionsView;
  ruleSuggestions: RuleSuggestionView[];
  /** D59: whether TownwiseAI works on its own here, and whether the caller turns it. */
  agentAuto: AgentAutoView;
  /** D59: the events files stated that TownwiseAI was not sure of, waiting for a member. */
  noteSuggestions: NoteSuggestionView[];
  /** D59: how many things TownwiseAI was not sure of are waiting: these note suggestions and the suggested rules. */
  waiting: number;
}

export interface AnswerResult {
  question: { id: string; answer: QuestionAnswer };
  /**
   * The note the stored answer saved (a closure note, or a likely-closed question's open-day note), or (D71) the private
   * event's note a `guests` answer wrote its count into; null for an answer that saves none, or a note deleted since.
   */
  note: NoteView | null;
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/**
 * The questions currently asked at the location, with the records they came from (agent/question-input.ts; D59 slice 5:
 * days a calendar plainly says were closed are explained), the private events' guests among them (D71).
 */
async function currentQuestions(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord): Promise<{
  questions: PanelQuestion[]; notes: NoteRecord[]; answers: AnswerRecord[];
  /** D71: every private event asked about, before the panel's cap. */
  parties: PanelQuestion[];
}> {
  const { input, notes, answers } = await questionInputAt(ctx, caller.scope, location);
  const parties = guestCountQuestionsFor({ coverage: input.coverage, notes, answered: input.answered, today: input.today });
  return { questions: panelQuestionsFor(questionsFor(input), parties), notes, answers, parties };
}

/** GET /api/org/locations/:locationId/agent. */
export async function getAgent(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const { questions, notes, answers } = await currentQuestions(ctx, caller, location);
  const [activity, suggested, ruleSuggestions, agentAuto, noteSuggestions] = await Promise.all([
    activityFor({ ctx, scope: caller.scope, locationId: location.id, userId: caller.userId, caller, notes, answers }),
    suggestionsPanel(ctx, caller, location),
    ruleSuggestionViews(ctx, caller, location),
    agentAutoView(ctx, caller),
    noteSuggestionViews(ctx, caller, location),
  ]);
  const body: AgentPanel = {
    questions, activity, ...suggested, ruleSuggestions, agentAuto, noteSuggestions, waiting: noteSuggestions.length + ruleSuggestions.length,
  };
  res.status(200).json(body);
}

async function answerNote(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, saved: boolean, row: AnswerRecord,
): Promise<NoteView | null> {
  if (!saved) return null;
  const note = await ctx.stores.notes.find(caller.scope, location.id, row.noteId);
  return note === null ? null : noteView(note, await authorEmail(ctx, note.createdBy, note.byStaff), caller);
}

function invalid(): AppError {
  return new AppError(400, 'invalid_request', 'Invalid request');
}

/**
 * D71: a private event's guests. Every step is ordered for retries, as a day's answer is: the note's count is written
 * once, by the try that finds it still uncounted, and any later try finishes the row as `guests`.
 */
async function answerParty(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, questionId: string, noteId: string, body: z.infer<typeof answerBody>,
): Promise<AnswerResult> {
  const { scope } = caller;
  const answers = ctx.stores.agentAnswers;
  const key: AnswerKey = { locationId: location.id, questionId };
  const result = async (row: AnswerRecord): Promise<AnswerResult> => ({
    question: { id: questionId, answer: row.answer }, note: await answerNote(ctx, caller, location, row.answer === 'guests', row),
  });
  const existing = await answers.find(scope, key);
  if (existing?.status === 'done') return result(existing);
  let note = await ctx.stores.notes.find(scope, location.id, noteId);
  if (note === null) throw notFound();
  // A try that claimed `guests` and wrote its count before it stopped is finished as `guests`, whatever this answer is.
  // Otherwise only a private event asked about now (before the panel's cap): a count typed on the Notes page has ended it.
  const counted = existing?.answer === 'guests' && hasGuestCount(note);
  if (!counted && !(await currentQuestions(ctx, caller, location)).parties.some((q) => q.id === questionId)) throw notFound();
  const claimed = await answers.claim(scope, key, { answer: counted ? 'guests' : body.answer, now: ctx.now(), noteId: note.id });
  if (claimed !== null) {
    if (claimed.answer === 'guests' && body.answer === 'guests') {
      // The compare-and-set, once more after a concurrent edit that left the note still uncounted and still a party.
      for (let attempt = 0; attempt < 2 && note !== null && wantsGuestCount(note); attempt += 1) {
        const raw = {
          kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
          expectedGuests: body.guests, detail: note.detail, title: note.title, startTime: note.startTime, endTime: note.endTime,
        };
        const edited = await editNote(ctx, caller, location, note, raw, { ifUpdatedAt: note.updatedAt });
        note = edited ?? await ctx.stores.notes.find(scope, location.id, noteId);
        if (edited !== null) break;
      }
    }
    // The count is in the note when this or any earlier try (or a colleague's) wrote one: then `guests` stands.
    const written = claimed.answer === 'guests' && note !== null && hasGuestCount(note);
    if (claimed.answer !== 'guests' || written) {
      if (await answers.markDone(scope, key, { answer: claimed.answer, now: ctx.now(), noteWritten: written })) {
        await recordAfter(ctx, {
          ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.question_answered',
          target: { type: 'location', id: location.id },
          details: { locationId: location.id, questionId, answer: claimed.answer },
        });
      }
    }
  }
  const row = await answers.find(scope, key);
  if (row === null) throw notFound();
  // Not done: the note changed into something else, or went, before a count could be written, so the question is no
  // longer asked; or another tab's answer is still being saved. Either way the client reads the panel again.
  if (row.status !== 'done') throw notFound();
  return result(row);
}

/** POST /api/org/locations/:locationId/agent/questions/:questionId { answer } (D71: and `guests`). */
export async function answerQuestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(answerBody, req.body);
  const questionId = parseInput(questionIdSchema, req.params.questionId);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const asked = parseQuestionId(questionId);
  if (asked === null) throw notFound();
  if (asked.kind === 'party_guests') {
    if (!PARTY_ANSWERS.includes(body.answer)) throw invalid();
    const result = await answerParty(ctx, caller, location, questionId, asked.noteId, body);
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, answer: result.question.answer }, 'townwise.agent_answer');
    res.status(200).json(result);
    return;
  }
  // A count answers a private event's question only.
  if (body.answer === 'guests') throw invalid();
  const { answer } = body;
  const result = await answerDays(ctx, caller, location, questionId, asked, answer);
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, answer: result.question.answer }, 'townwise.agent_answer');
  res.status(200).json(result);
}

/** A question about days: the steps at the top of this file. */
async function answerDays(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, questionId: string, asked: DayAsked, answer: QuestionAnswer,
): Promise<AnswerResult> {
  const { scope } = caller;
  const answers = ctx.stores.agentAnswers;
  const key: AnswerKey = { locationId: location.id, questionId };

  const existing = await answers.find(scope, key);
  let result: AnswerResult;
  if (existing?.status === 'done') {
    // Answered already, by an earlier press, another tab or a colleague: answer with that.
    result = {
      question: { id: questionId, answer: existing.answer },
      note: await answerNote(ctx, caller, location, noteFor(asked, existing.answer) !== null, existing),
    };
  } else {
    // An earlier try that wrote its note and stopped before `done` is finished as the answer that note stands for,
    // whatever this answer is: the note exists. Otherwise only a question the panel asks now, so a stale panel cannot
    // answer days that have since gained sales or a note.
    const written = existing === null ? null : await ctx.stores.notes.find(scope, location.id, existing.noteId);
    if (written === null && !(await currentQuestions(ctx, caller, location)).questions.some((q) => q.id === questionId)) {
      throw notFound();
    }
    const claimed = await answers.claim(scope, key, { answer: written === null ? answer : answerOfNote(asked, written), now: ctx.now() });
    if (claimed !== null) {
      // Every try writes with the row's one note id, so a note another try wrote first is returned, and decides the answer.
      const content = noteFor(asked, claimed.answer);
      const note = content === null
        ? null
        : await addNote(ctx, caller, location, noteContent(content, utcDay(ctx.now())), { id: claimed.noteId });
      const stored = note === null ? claimed.answer : answerOfNote(asked, note);
      if (await answers.markDone(scope, key, { answer: stored, now: ctx.now(), noteWritten: note !== null })) {
        await recordAfter(ctx, {
          ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.question_answered',
          target: { type: 'location', id: location.id },
          details: { locationId: location.id, questionId, answer: stored },
        });
      }
    }
    // Answer with what the row holds now: this answer, or the one another tab or colleague stored first.
    const row = await answers.find(scope, key);
    if (row === null) throw notFound();
    result = { question: { id: questionId, answer: row.answer }, note: await answerNote(ctx, caller, location, noteFor(asked, row.answer) !== null, row) };
  }
  return result;
}
