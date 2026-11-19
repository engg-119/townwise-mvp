// A calendar answers TownwiseAI's open closure questions and suggestions (D59 slice 5, openspec change
// auto-apply-agent-reads design decision 16). Code only: no model call, no budget, nothing leaves Townwise. It runs for a
// whole location right after followLinkedNotes wherever a calendar's events switch (an add, the refresh loop, Refresh
// now), after a file read or a sales upload (which may make a suggestion), and after the location's weekly pass
// whatever its outcome:
//   1. The location's closed events (calendar/closed-events.ts: keyed, all day, a title that plainly says closed) are
//      read across its calendars.
//   2. planAnswers (pure) finds the open suggestions they answer: a closure rule or closure note with dates every day of
//      which is covered, and a standing closed weekday (the sales history's, computed or stored, or a file's or the
//      weekly pass's) whose next 8 days of each weekday from tomorrow are covered. Never a season, a booking, more or
//      fewer guests or a D53 kind, and never one a person's own note or rule decides differently (owner beats agent).
//      Gap and likely-closed questions are answered on read (agent/question-input.ts), and need nothing stored.
//   3. While TownwiseAI works on its own (TOWNWISE_AGENT_AUTO and the organization's agentAuto), the forecast is made to
//      follow first, through the one writer (agent/apply.ts, `sourceKind: 'calendar'`): a closure note for each answering
//      event whose days no closure notes all close yet, linked to its event (D53's follow-up then moves or removes it), with
//      an id planned from the calendar and uid so a retry writes one; the same for the events covering days a current
//      question asks about, so the lab reads what the panel stops asking; and, for a standing weekday, the suggestion's
//      own rule. An event counts as in the forecast already only when closure notes cover every one of its days (a
//      note over part of it, or a booking's note, does not). At most 20 notes a run. A suggestion is answered only when
//      everything it needs is written and still applied (or was made before by another source and is still applied,
//      `duplicate`); a conflict, a limit, a change a person undid or one they changed since leaves it open.
//   4. The suggestion is marked `answered` by compare-and-set (a computed sales suggestion is stored `answered` under its
//      closure key). While TownwiseAI does not work on its own, nothing is written before it, and a standing weekday
//      stays open: a calendar shows only its next weeks, so it never stands in for the rule a person would confirm.
//      [CONFIRM: while TownwiseAI does not work on its own, a standing closed weekday a calendar covers stays open]
// A location deleted while this ran keeps nothing it wrote. When a calendar is removed (or its Google access ends),
// takeBackAnswers takes back the closure notes its answers saved that nobody changed since, as TownwiseAI. [CONFIRM:
// removing a calendar, or its Google access ending, takes back the closure notes its answers saved that nobody changed
// since]
// Never throws: a failure is logged by the location's id, and the switch it follows stands. Logs and the audit event
// carry ids and counts only: never a title, a uid or a date.
import { createHash } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { applyChange, conflictsWith, isAgentRule, TOWNWISE_AI_AUTHOR, type ApplyOutcome, type PersonsEntries } from '../agent/apply.ts';
import { closureKeyOf, closureRuleText } from '../agent/closure-suggestions.ts';
import { wantRefitFor } from '../agent/refit.ts';
import { questionInputAt } from '../agent/question-input.ts';
import { noteCovers, questionsFor, type Question, type SalesSuggestion } from '../agent/questions.ts';
import { salesSuggestions } from '../agent/rule-suggestion-views.ts';
import { recordAfter, TOWNWISE_AI_ACTOR } from '../audit.ts';
import { isBuyout, isClosure } from '../closed-days.ts';
import { utcDay } from '../dates.ts';
import { eachDay } from '../forecasts/file.ts';
import { MAX_NOTES } from '../handlers/notes.ts';
import type { AgentChangeRecord } from '../stores/agent-changes.ts';
import type { SalesEvidence, SuggestionRecord } from '../stores/agent-suggestions.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent, NoteRecord } from '../stores/notes.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { closedDaysOf, closedEventsOf, closureNoteOfEvent, type CalendarEvent } from './closed-events.ts';
import { FILE_HISTORY_DAYS, WINDOW_DAYS } from './ics.ts';

/** A standing closed weekday is answered when this many of each of its weekdays, from tomorrow, are covered. [CONFIRM: 8 upcoming days of a weekday covered answer a standing closed weekday] */
export const UPCOMING_WEEKDAYS = 8;
/** At most this many notes from calendar answers a run per location; the rest at the next run. [CONFIRM: at most 20 notes from calendar answers a run] */
export const MAX_ANSWER_NOTES = 20;

/** What an open suggestion proposes, as a calendar may answer it. */
export type AnswerableContent =
  | { readonly type: 'note'; readonly note: NoteContent }
  | { readonly type: 'rule'; readonly text: string; readonly schedule: RuleSchedule };

/** An open suggestion: a stored row, or the sales history's for a weekday, computed on read and not stored yet. */
export interface Answerable {
  readonly ref: { readonly kind: 'stored'; readonly id: string } | { readonly kind: 'sales'; readonly weekday: number; readonly evidence: SalesEvidence };
  readonly content: AnswerableContent;
}

/**
 * A suggestion the calendars answer: the closed events covering its days (for a dated one each makes a note; for a
 * standing weekday, the first names the calendar its rule is from), and a standing weekday's rule.
 */
export interface PlannedAnswer {
  readonly ref: Answerable['ref'];
  readonly events: readonly CalendarEvent[];
  readonly rule: { readonly text: string; readonly schedule: RuleSchedule } | null;
}

/** A closure that is not a buyout: what a title that plainly says closed can answer. */
function closesOnly(entry: Pick<NoteContent, 'kind' | 'effect'>): boolean {
  return isClosure(entry) && !isBuyout(entry);
}

/** The next `count` days of `weekday` on or after `from`. */
function nextOf(weekday: number, from: string, count: number): string[] {
  const at = new Date(`${from}T00:00:00.000Z`);
  const first = utcDay(at, (weekday - at.getUTCDay() + 7) % 7);
  return Array.from({ length: count }, (_, i) => utcDay(new Date(`${first}T00:00:00.000Z`), 7 * i));
}

/**
 * The days a calendar must cover to answer a suggestion: every day a dated closure closes (its weekdays only), or the
 * next 8 days of each weekday of a standing closure from tomorrow or its start (the later); null for what a calendar
 * never answers (a season, a standing closure of every day, a booking, more or fewer guests, any other kind). Pure.
 */
export function daysToCover(content: AnswerableContent, today: string): string[] | null {
  const entry = content.type === 'note' ? content.note : content.schedule;
  if (!closesOnly(entry)) return null;
  if (content.type === 'rule' && (content.schedule.season ?? null) !== null) return null;
  if (entry.endDate !== null) {
    const days = eachDay(entry.startDate, entry.endDate).filter((day) => noteCovers(entry, day));
    return days.length === 0 ? null : days;
  }
  const weekdays = entry.weekdays;
  if (weekdays === null || weekdays.length === 0 || weekdays.length >= 7) return null;
  const tomorrow = utcDay(new Date(`${today}T00:00:00.000Z`), 1);
  const from = entry.startDate > tomorrow ? entry.startDate : tomorrow;
  return [...new Set(weekdays)].flatMap((weekday) => nextOf(weekday, from, UPCOMING_WEEKDAYS)).sort();
}

/** The open stored suggestions and the sales history's computed ones, as answerables (the kinds a calendar may answer). */
export function answerablesOf(records: readonly SuggestionRecord[], sales: readonly SalesSuggestion[]): Answerable[] {
  const stored = records.flatMap((record): Answerable[] => {
    if (record.type === 'note') return [{ ref: { kind: 'stored', id: record.id }, content: { type: 'note', note: record.note } }];
    if (record.type === 'rule') return [{ ref: { kind: 'stored', id: record.id }, content: { type: 'rule', text: record.text, schedule: record.schedule } }];
    return [];
  });
  const computed = sales.map((each): Answerable => ({
    ref: { kind: 'sales', weekday: each.weekday, evidence: each.evidence },
    content: { type: 'rule', text: closureRuleText(each.schedule), schedule: each.schedule },
  }));
  return [...stored, ...computed];
}

/**
 * The suggestions the closed events answer (see the top), and how many the events cover but a person's own note or rule
 * decides differently (`held`). Pure.
 */
export function planAnswers(input: {
  readonly items: readonly Answerable[]; readonly closed: readonly CalendarEvent[]; readonly persons: PersonsEntries; readonly today: string;
}): { answers: PlannedAnswer[]; held: number } {
  const days = closedDaysOf(input.closed);
  const answers: PlannedAnswer[] = [];
  let held = 0;
  for (const item of input.items) {
    const needed = daysToCover(item.content, input.today);
    if (needed === null) continue;
    if (!needed.every((day) => days.has(day))) continue;
    const entry = item.content.type === 'note' ? item.content.note : item.content.schedule;
    if (conflictsWith(entry, input.persons, input.today)) {
      held += 1;
      continue;
    }
    const events = new Map<string, CalendarEvent>();
    for (const day of needed) for (const event of days.get(day) ?? []) events.set(`${event.calendarId}\u0000${event.uid}`, event);
    const standing = item.content.type === 'rule' && item.content.schedule.endDate === null
      ? { text: item.content.text, schedule: item.content.schedule } : null;
    answers.push({ ref: item.ref, events: [...events.values()], rule: standing });
  }
  return { answers, held };
}

/** The id of the note an answering event makes: the same on every run, so a retry writes one. */
export function answerNoteId(calendarId: string, uid: string): string {
  return createHash('sha256').update(`calendar-answer\u0000${calendarId}\u0000${uid}`).digest('hex').slice(0, 24);
}

/** The id of the rule a standing weekday's answer adds. */
function answerRuleId(locationId: string, closureKey: string): string {
  return createHash('sha256').update(`calendar-answer-rule\u0000${locationId}\u0000${closureKey}`).digest('hex').slice(0, 24);
}

/**
 * Whether closure notes (not a buyout's or any other kind's) already close every day of the event, each on its own
 * weekdays: only then is the event in the forecast already, so no note is written for it. Pure.
 */
export function closedAlready(notes: readonly NoteContent[], event: Pick<CalendarEvent, 'startDate' | 'endDate'>): boolean {
  const closing = notes.filter(closesOnly);
  return eachDay(event.startDate, event.endDate).every((day) => closing.some((note) => noteCovers(note, day)));
}

/**
 * Whether a ledger row is one a calendar's answer saved: a closure note from a calendar. Slice 2's sort saves only
 * private-event notes (handlers/calendar-bookings.ts bookingNote), so its Undo per calendar leaves these alone.
 */
export function isAnswerChange(row: Pick<AgentChangeRecord, 'sourceKind' | 'action' | 'noteKind'>): boolean {
  return row.sourceKind === 'calendar' && row.action === 'note.add' && row.noteKind === 'closure';
}

/** The days a question asks about. */
function askedDays(question: Question): string[] {
  return question.kind === 'likely_closed' ? [question.date] : eachDay(question.from, question.to);
}

/** The Monday that starts `day`'s week. */
function mondayOf(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  return utcDay(at, -((at.getUTCDay() + 6) % 7));
}

export interface AnswerDeps {
  readonly stores: TownwiseStores;
  readonly logger: Logger;
  readonly now: () => Date;
  /** TOWNWISE_AGENT_AUTO: with the organization's own switch, whether TownwiseAI writes the answers. */
  readonly agentAuto: boolean;
}

/** What one run did, in counts. */
interface AnswerCounts {
  answered: number;
  notes: number;
  rules: number;
  held: number;
}

const WRITTEN: ReadonlySet<ApplyOutcome> = new Set(['applied', 'duplicate']);

/** Whether applyChange's answer leaves the change in place: written (or made before) and neither undone nor changed since. */
function inPlace(result: { readonly outcome: ApplyOutcome; readonly change: AgentChangeRecord | null }): boolean {
  return WRITTEN.has(result.outcome) && result.change?.status === 'applied';
}

async function answer(deps: AnswerDeps, scope: OrgScope, location: LocationRecord): Promise<AnswerCounts> {
  const { stores } = deps;
  const counts: AnswerCounts = { answered: 0, notes: 0, rules: 0, held: 0 };
  const now = deps.now();
  const today = localDay(now, timeZoneOf(location.town).timeZone);
  const at = new Date(`${today}T00:00:00.000Z`);
  const events = await stores.ownerCalendars.keyedEventsBetween(scope, location.id, { from: utcDay(at, -FILE_HISTORY_DAYS), to: utcDay(at, WINDOW_DAYS) });
  const closed = closedEventsOf(events, today);
  if (closed.length === 0) return counts;
  const suggestions = stores.agentSuggestions;
  const [weekly, rules, fileNotes, computed, notes, scheduled] = await Promise.all([
    suggestions.listOpen(scope, location.id, today), suggestions.listOpenRules(scope, location.id, today),
    suggestions.listOpenFileNotes(scope, location.id, today), salesSuggestions({ stores }, scope, location.id),
    stores.notes.list(scope, location.id), stores.businessRules.scheduled(scope, location.id),
  ]);
  // A computed sales suggestion a row already holds (stored when someone decided it, or a file's) is that row's.
  const unstored: SalesSuggestion[] = [];
  for (const each of computed) if (await suggestions.findByKey(scope, location.id, closureKeyOf(each.schedule)) === null) unstored.push(each);
  const persons: PersonsEntries = {
    notes, rules: scheduled.flatMap((rule) => (rule.schedule === null || isAgentRule(rule) ? [] : [rule.schedule])),
  };
  const plan = planAnswers({ items: answerablesOf([...weekly, ...rules, ...fileNotes], unstored), closed, persons, today });
  counts.held = plan.held;
  const org = deps.agentAuto ? await stores.orgs.findById(scope.orgId) : null;
  const auto = org?.agentAuto.on === true;

  /** Whether an event's note is in place: written now and still applied, made before, or closure notes close all its days. */
  const noted = new Map<string, boolean>();
  const adders = auto
    ? new Map((await stores.ownerCalendars.list(scope, location.id)).map((calendar) => [calendar.id, calendar.createdBy]))
    : new Map<string, string>();
  if (auto) {
    const keyOf = (event: CalendarEvent): string => `${event.calendarId}\u0000${event.uid}`;
    const placed = (event: CalendarEvent, all: readonly NoteRecord[]): boolean => closedAlready(all, event);
    // The events covering days a current question asks about (read without the calendar), so the lab reads them too.
    const { input } = await questionInputAt({ stores, now: deps.now }, scope, location);
    const asked = new Set(questionsFor({ ...input, calendarClosed: [] }).flatMap(askedDays));
    const questionEvents = closed.filter((event) => eachDay(event.startDate, event.endDate).some((day) => asked.has(day)));
    const wanted = new Map<string, CalendarEvent>();
    for (const event of [...plan.answers.flatMap((each) => (each.rule === null ? each.events : [])), ...questionEvents]) wanted.set(keyOf(event), event);
    let count = notes.length;
    for (const event of [...wanted.values()].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))) {
      if (placed(event, notes)) {
        noted.set(keyOf(event), true);
        continue;
      }
      const content = closureNoteOfEvent(event, utcDay(now));
      if (content === null || counts.notes >= MAX_ANSWER_NOTES || count >= MAX_NOTES) {
        noted.set(keyOf(event), false);
        continue;
      }
      const result = await applyChange(deps, scope, {
        action: 'note.add', locationId: location.id, sourceKind: 'calendar', sourceId: event.calendarId, targetId: answerNoteId(event.calendarId, event.uid),
        confidence: 'high', why: null, onBehalfOf: adders.get(event.calendarId) ?? null, actor: TOWNWISE_AI_ACTOR, note: content,
        createdBy: TOWNWISE_AI_AUTHOR,
        fromEvent: {
          calendarId: event.calendarId, uid: event.uid, startDate: event.startDate, endDate: event.endDate, startTime: null, endTime: null,
          linkedAt: deps.now(),
        },
      }, persons);
      // An undone or changed row under this event's planned id (or key) is not in place: what it needs stays open.
      noted.set(keyOf(event), inPlace(result));
      if (result.outcome === 'applied' && inPlace(result)) {
        counts.notes += 1;
        count += 1;
      }
    }
  }

  let resolved = 0;
  for (const each of plan.answers) {
    // While TownwiseAI does not work on its own, a standing weekday stays open (see the top).
    if (!auto && each.rule !== null) continue;
    if (auto) {
      if (each.rule !== null) {
        const closureKey = closureKeyOf(each.rule.schedule);
        const from = each.events[0]?.calendarId ?? null;
        const result = await applyChange(deps, scope, {
          action: 'rule.add', locationId: location.id, sourceKind: 'calendar', sourceId: from,
          targetId: answerRuleId(location.id, closureKey), confidence: 'high', why: null,
          onBehalfOf: from === null ? null : adders.get(from) ?? null, actor: TOWNWISE_AI_ACTOR, text: each.rule.text, schedule: each.rule.schedule,
        }, persons);
        if (!inPlace(result)) {
          counts.held += 1;
          continue;
        }
        if (result.outcome === 'applied') counts.rules += 1;
      } else if (!each.events.every((event) => noted.get(`${event.calendarId}\u0000${event.uid}`) === true)) {
        counts.held += 1;
        continue;
      }
    }
    if (each.ref.kind === 'stored') {
      if (await suggestions.markAnswered(scope, location.id, each.ref.id, deps.now())) resolved += 1;
      continue;
    }
    const content = each.rule ?? null;
    if (content === null) continue;
    const stored = await suggestions.insertOne(scope, {
      id: new Types.ObjectId().toHexString(), locationId: location.id, week: mondayOf(today), source: 'sales', text: content.text,
      schedule: content.schedule, closureKey: closureKeyOf(content.schedule), evidence: each.ref.evidence, now: deps.now(), answered: true,
    });
    if (stored?.created === true) resolved += 1;
  }
  counts.answered = resolved;
  if ((await stores.locations.find(scope, location.id)) === null) {
    // A location deleted while this ran keeps nothing it wrote: its delete may have swept before these writes landed, so
    // they are swept again (as removeLocation does).
    await stores.notes.removeForLocation(scope, location.id);
    await stores.businessRules.removeForLocation(scope, location.id);
    await suggestions.removeForLocation(scope, location.id);
    await stores.agentChanges.removeForLocation(scope, location.id);
    return counts;
  }
  if (resolved > 0) {
    await recordAfter(deps, {
      ...TOWNWISE_AI_ACTOR, at: deps.now(), orgId: scope.orgId, action: 'agent.calendar_answered', target: { type: 'location', id: location.id },
      details: { locationId: location.id, count: resolved },
    });
  }
  return counts;
}

/** Answers the location's open closure suggestions from its calendars (see the top). Never throws. */
export async function answerFromCalendars(deps: AnswerDeps, scope: OrgScope, location: LocationRecord): Promise<void> {
  try {
    const counts = await answer(deps, scope, location);
    if (counts.answered + counts.notes + counts.rules + counts.held > 0) {
      deps.logger.info({ locationId: location.id, ...counts }, 'townwise.calendar_answers');
    }
  } catch {
    deps.logger.warn({ locationId: location.id }, 'townwise.calendar_answers_failed');
  }
}

/**
 * Takes back, as TownwiseAI, the closure notes a removed calendar's answers saved (isAnswerChange, sourceId the calendar)
 * that nobody changed since: the note is removed by compare-and-set on its updatedAt and the row reads `undone`, with
 * `agent.change_undone` and a refit wanted for its days, as an Undo does. One a person changed since reads `adopted`
 * and stays theirs. So the forecast stops closing days only that calendar said were closed, and the read-time question
 * comes back. Never throws: a failure is logged by the location's and calendar's ids.
 */
export async function takeBackAnswers(deps: Omit<AnswerDeps, 'agentAuto'>, scope: OrgScope, locationId: string, calendarId: string): Promise<void> {
  const { stores } = deps;
  try {
    let undone = 0;
    for (const row of await stores.agentChanges.listBySource(scope, locationId, { kind: 'calendar', id: calendarId })) {
      if (!isAnswerChange(row) || (row.status !== 'applied' && row.status !== 'undoing')) continue;
      const change = row.status === 'applied'
        ? await stores.agentChanges.markUndoing(scope, locationId, row.id, { by: TOWNWISE_AI_AUTHOR, now: deps.now() })
        : row;
      if (change?.status !== 'undoing') continue;
      const note = await stores.notes.find(scope, locationId, change.targetId);
      if (note !== null && (change.targetUpdatedAt?.getTime() !== note.updatedAt.getTime()
        || !(await stores.notes.removeIf(scope, locationId, note.id, note.updatedAt)))) {
        await stores.agentChanges.markAdopted(scope, locationId, change.id, { now: deps.now() });
        continue;
      }
      if (!(await stores.agentChanges.markUndone(scope, locationId, change.id, { by: TOWNWISE_AI_AUTHOR, now: deps.now() }))) continue;
      undone += 1;
      await recordAfter(deps, {
        ...TOWNWISE_AI_ACTOR, at: deps.now(), orgId: scope.orgId, action: 'agent.change_undone', target: { type: 'location', id: locationId },
        details: { locationId, action: change.action, sourceKind: change.sourceKind },
      });
      if (change.startDate !== null && change.endDate !== null) {
        await wantRefitFor(deps, scope, locationId, { startDate: change.startDate, endDate: change.endDate });
      }
    }
    if (undone > 0) deps.logger.info({ locationId, calendarId, undone }, 'townwise.calendar_answers_taken_back');
  } catch {
    deps.logger.warn({ locationId, calendarId }, 'townwise.calendar_answers_take_back_failed');
  }
}
