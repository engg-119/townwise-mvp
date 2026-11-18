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
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { activityFor, type ActivityItem } from '../agent/activity.ts';
import {
  answerOfNote, noteFor, parseQuestionId, QUESTION_ANSWERS, questionsFor, questionWindow, type AskedQuestion, type Question,
  type QuestionAnswer,
} from '../agent/questions.ts';
import { TYPICAL_LOOKBACK_DAYS } from '../closed-days.ts';
import { utcDay } from '../dates.ts';
import { authorEmail } from '../people.ts';
import type { AnswerKey, AnswerRecord } from '../stores/agent-answers.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { loadLocation, memberOf } from './locations.ts';
import { addNote, noteContent, noteView, type NoteView } from './notes.ts';
import { actorOf } from './team.ts';
import { ruleSuggestionViews, type RuleSuggestionView } from '../agent/rule-suggestion-views.ts';
import { suggestionsPanel, type SuggestionView, type WeeklySuggestionsView } from './weekly-suggestions.ts';

/** A question id: dates and a weekday number only, never text. */
const questionIdSchema = z.string().regex(/^(gap|weekday|likely_closed)_[0-9_-]{10,40}$/);
/** The answer and nothing else: any other key, the person's words included, is refused. */
const answerBody = z.strictObject({ answer: z.enum(QUESTION_ANSWERS) });

/**
 * The panel: the questions, the activity, (openspec change weekly-forecast-suggestions) the open weekly suggestions
 * with the organization's switch, and (D46) the open suggested closure rules from files and the sales history.
 */
export interface AgentPanel {
  questions: Question[]; activity: ActivityItem[]; suggestions: SuggestionView[]; weeklySuggestions: WeeklySuggestionsView;
  ruleSuggestions: RuleSuggestionView[];
}

export interface AnswerResult {
  question: { id: string; answer: QuestionAnswer };
  /**
   * The note the stored answer saved (a closure note, or a likely-closed question's open-day note), or null (an answer
   * that saves none, or the note was deleted since).
   */
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
  const [coverage, notes, answers, scheduled] = await Promise.all([
    ctx.stores.salesDays.coverage(scope, location.id),
    ctx.stores.notes.list(scope, location.id),
    ctx.stores.agentAnswers.list(scope, location.id),
    ctx.stores.businessRules.scheduled(scope, location.id),
  ]);
  const window = questionWindow(coverage);
  // The days read reach 56 days before the window, for each day's typical guests (D32). D28: a turned-off upload's days
  // are left out of `days` and explained by `turnedOff`, so they are never asked about.
  const [days, turnedOff] = window === null ? [[], []] : await Promise.all([
    ctx.stores.salesDays.days(scope, location.id, {
      from: utcDay(new Date(`${window.from}T00:00:00.000Z`), -TYPICAL_LOOKBACK_DAYS), to: window.to,
    }),
    ctx.stores.salesDays.disabledDates(scope, location.id, window),
  ]);
  // A save still in progress is not answered yet: the question stays until its answer is done.
  const answered = answers.filter((row) => row.status === 'done').map((row) => row.questionId);
  // D31: a business rule's schedule explains a day only as it decides it (questions.ts); a rule with none, nothing.
  const rules = scheduled.flatMap((rule) => (rule.schedule === null ? [] : [rule.schedule]));
  return { questions: questionsFor({
    coverage, days, notes, rules, answered, turnedOff, today: localDay(ctx.now(), timeZoneOf(location.town).timeZone),
  }), notes, answers };
}

/** GET /api/org/locations/:locationId/agent. */
export async function getAgent(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const { questions, notes, answers } = await currentQuestions(ctx, caller, location);
  const [activity, suggested, ruleSuggestions] = await Promise.all([
    activityFor({ ctx, scope: caller.scope, locationId: location.id, userId: caller.userId, notes, answers }),
    suggestionsPanel(ctx, caller, location),
    ruleSuggestionViews(ctx, caller, location),
  ]);
  const body: AgentPanel = { questions, activity, ...suggested, ruleSuggestions };
  res.status(200).json(body);
}

async function answerNote(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, asked: AskedQuestion, row: AnswerRecord,
): Promise<NoteView | null> {
  if (noteFor(asked, row.answer) === null) return null;
  const note = await ctx.stores.notes.find(caller.scope, location.id, row.noteId);
  return note === null ? null : noteView(note, await authorEmail(ctx, note.createdBy, note.byStaff), caller);
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
    result = { question: { id: questionId, answer: existing.answer }, note: await answerNote(ctx, caller, location, asked, existing) };
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
    result = { question: { id: questionId, answer: row.answer }, note: await answerNote(ctx, caller, location, asked, row) };
  }
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, answer: result.question.answer }, 'townwise.agent_answer');
  res.status(200).json(result);
}
