// The one writer of TownwiseAI's own changes (D59, openspec change auto-apply-agent-reads design decisions 5, 6, 7 and
// 9): every source calls applyChange with a typed candidate, and it answers `applied`, `duplicate`, `conflict` or
// `invalid`. It only adds: a note (`note.add`), a summary item (`item.add`), missing sales days (`sales_days.add`),
// (slice 2) the labels of a file calendar sorted on import (`booking.label`, one change per calendar, whose writer labels
// only a calendar nobody sorted, labeled or confirmed, and then confirms it for forecasts, so the confirm covers only its
// own labels) or (slice 3) a closure or hours rule (`rule.add`, through D31's rules: refused `invalid` at the 30-rule
// limit or when a rule with its words exists); it never changes or deletes anything else that exists. There are no transactions (DocumentDB), so the writes are ordered
// for retries: the ledger row is inserted `applying` under the planned target id and a dedupe key unique per location in
// every status; the target is written under that id (a second create fails on its primary key and counts as done); the
// row is set `applied` with the target's updatedAt by compare-and-set; the audit event is recorded only by the call
// whose compare-and-set lands; then the location is marked as wanting a refit when the change touches a training day. A
// retry finds the row by its key, sees its own planned target, and finishes the steps left. A weekly or sales change
// plans a new target id each pass, and a chat change's turn is never run again (slice 4), so no later candidate retries
// one: each weekly pass first finishes the location's weekly, sales and chat rows left `applying` for an hour or more
// (finishStaleChanges). A key another change holds, in any status (an
// undone one included), is a duplicate, so nothing undone is ever made again. Before the row, a note
// or a rule is checked against the notes and scheduled rules a person made on its days: one that decides a day
// differently is a conflict, and the candidate waits as a suggestion instead (the caller's choice). Logs and audit events carry ids,
// the action and the source kind only: never a title, a why, a file name or a figure.
import { createHash } from 'node:crypto';

import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter, TOWNWISE_AI_ACTOR } from '../audit.ts';
import { isBuyout, isClosure, saysOpen, type Entry } from '../closed-days.ts';
import { utcDay } from '../dates.ts';
import { isAgentNote } from '../forecasts/adjust.ts';
import { eachDay } from '../forecasts/file.ts';
import type {
  AgentChangeAction, AgentChangeRecord, AgentConfidence, AgentSourceKind,
} from '../stores/agent-changes.ts';
import { MAX_WHY_CHARS } from '../stores/agent-changes.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import { MAX_RULES, type BusinessRuleRecord, type RuleSchedule } from '../stores/business-rules.ts';
import type { AiSource } from '../stores/files.ts';
import type { NoteContent, NoteLink, NoteRecord } from '../stores/notes.ts';
import { closureKeyOf } from './closure-suggestions.ts';
import { noteCovers } from './questions.ts';
import { wantRefitFor } from './refit.ts';

/** The user id a note TownwiseAI saved on its own carries as its author (shown as "TownwiseAI"). */
export const TOWNWISE_AI_AUTHOR = 'townwise_ai';

export type ApplyOutcome = 'applied' | 'duplicate' | 'conflict' | 'invalid';

/** Who a change is recorded as (the audit actor): TownwiseAI, or the person who pressed for the read. */
export type ChangeActor = Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'>;

interface CandidateBase {
  readonly locationId: string;
  readonly sourceKind: AgentSourceKind;
  readonly sourceId: string | null;
  /** The id the target is written under, planned before any write, so a retry writes the same one. */
  readonly targetId: string;
  readonly confidence: AgentConfidence;
  readonly why: string | null;
  /** The person the source belongs to (the file's adder). */
  readonly onBehalfOf: string | null;
  readonly actor: ChangeActor;
}

/** A note to add, through the notes route's own rules (the caller made `note` with readNoteContent). */
export interface NoteCandidate extends CandidateBase {
  readonly action: 'note.add';
  readonly note: NoteContent;
  /** The note's author: TOWNWISE_AI_AUTHOR on its own, or the person who pressed for the read. */
  readonly createdBy: string;
  readonly byStaff?: boolean;
  readonly source?: AiSource;
  /** Slice 2: the calendar event a note for an upcoming booking is made from (D58's link). */
  readonly fromEvent?: NoteLink;
}

/**
 * Slice 3: a closure or hours rule to add, as TownwiseAI (`createdBy` and `addedVia` `townwise_ai`), through D31's rules
 * (the caller made `text` with ruleTextOf and `schedule` with readRuleSchedule).
 */
export interface RuleCandidate extends CandidateBase {
  readonly action: 'rule.add';
  readonly text: string;
  readonly schedule: RuleSchedule;
}

/**
 * An item, missing sales days or a calendar's labels, written by the caller's own writer under the planned id. `key` is
 * the content the dedupe key is made of. `write` is handed the ledger row (`applying`; a retry gets the same row, so its
 * `appliedAt` is a time planned before any write) and resolves the target's updatedAt, or null when it added nothing
 * after all (the row is then removed, and the answer is `invalid`); a second call must complete the first's write. A
 * writer that only knows what it added once written (a calendar's labels, only on events nobody labeled) resolves
 * WrittenFacts instead, and the row takes that count and those dates before it is marked applied.
 */
export interface WrittenCandidate extends CandidateBase {
  readonly action: 'item.add' | 'sales_days.add' | 'booking.label';
  readonly key: string;
  /** The dates the days (or a calendar's buyouts and parties) cover, for the activity and the refit; null for an item. */
  readonly dates: { readonly startDate: string; readonly endDate: string } | null;
  /** How many records it adds, for the activity's words (a calendar's labels); left out otherwise. */
  readonly count?: number;
  readonly write: (change: AgentChangeRecord) => Promise<Date | WrittenFacts | null>;
}

/** What a writer actually wrote: the target's updatedAt, how many records, and the dates they cover (or null). */
export interface WrittenFacts {
  readonly updatedAt: Date;
  readonly count: number;
  readonly dates: { readonly startDate: string; readonly endDate: string } | null;
}

export type ChangeCandidate = NoteCandidate | RuleCandidate | WrittenCandidate;

/** What applyChange reads and writes through: the stores, the clock, and the logger an audit failure is logged to. */
export type ApplyContext = Pick<TownwiseContext, 'stores' | 'now' | 'logger'>;

export interface ApplyResult {
  readonly outcome: ApplyOutcome;
  /** The ledger row: the one written (`applied`), or the one holding the key (`duplicate`); null otherwise. */
  readonly change: AgentChangeRecord | null;
}

/** Whether TownwiseAI works on its own for the organization now: TOWNWISE_AGENT_AUTO and its own switch both on. */
export async function agentAutoOn(ctx: Pick<TownwiseContext, 'config' | 'stores'>, orgId: string): Promise<boolean> {
  if (!ctx.config.agentAuto) return false;
  return (await ctx.stores.orgs.findById(orgId))?.agentAuto.on ?? false;
}

/** Lower case, each run of white space one space, trimmed. */
function folded(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A schedule's fields in a fixed order, its weekdays sorted (slice 3's rule key, for a schedule that is not a closure). */
function scheduleParts(schedule: RuleSchedule): unknown[] {
  const season = schedule.season ?? null;
  return [
    schedule.kind, schedule.startDate, schedule.endDate, schedule.weekdays === null ? null : [...schedule.weekdays].sort((a, b) => a - b),
    schedule.effect, schedule.expectedGuests, schedule.startTime, schedule.endTime, season === null ? null : [season.from, season.to],
  ];
}

/**
 * The dedupe key of a change (design decision 5): a hash of the action and its content normalized. A note's is its kind,
 * dates, weekdays (in order), effect and folded title, so the same event from a PDF and a photo is one change; a rule's
 * (slice 3) is a closure's key (agent/closure-suggestions.ts, which leaves out a standing closure's start, so "Closed on
 * Mondays" undone is never added again from a later week's history) or any other schedule's fields; an item's and days'
 * are the caller's key (the file they came from).
 */
export function dedupeKeyOf(candidate: { action: AgentChangeAction; note?: NoteContent; schedule?: RuleSchedule; key?: string }): string {
  const parts: unknown[] = [candidate.action];
  const { note, schedule } = candidate;
  if (note !== undefined) {
    parts.push(
      note.kind, note.startDate, note.endDate, note.weekdays === null ? null : [...note.weekdays].sort((a, b) => a - b), note.effect,
      note.title === null ? null : folded(note.title),
    );
  } else if (schedule !== undefined) {
    parts.push(...(schedule.kind === 'closure' ? [closureKeyOf(schedule)] : scheduleParts(schedule)));
  } else {
    parts.push(candidate.key ?? '');
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** How an entry decides a day: closed, booked (a buyout), open, or not at all. */
function decisionOf(entry: Entry): 'closed' | 'booked' | 'open' | null {
  if (isBuyout(entry)) return 'booked';
  if (isClosure(entry)) return 'closed';
  if (saysOpen(entry)) return 'open';
  return null;
}

/** A person's own notes and scheduled rules, as conflictsWith reads them. */
export interface PersonsEntries {
  readonly notes: readonly NoteRecord[];
  readonly rules: readonly RuleSchedule[];
}

/**
 * A closed note TownwiseAI saves spans at most this many days, and those one read or weekly pass saves at most this
 * many together (design decision 7's closure guards); a closure rule it adds closes at most CLOSED_SPAN_DAYS in a row.
 */
export const CLOSED_SPAN_DAYS = 14;
export const CLOSED_DAYS_PER_READ = 31;

/**
 * A candidate is checked on at most this many days from its start, or from today when that is later (a closure
 * TownwiseAI writes spans at most 14; a standing rule, up to 400 from today, its past days included).
 */
const CONFLICT_DAYS = 400;
/**
 * A weekly, sales or chat row `applying` this long is an attempt that died (a pass takes minutes, a chat turn at most 150
 * seconds); finishStaleChanges finishes it.
 */
export const STALE_APPLYING_MS = 60 * 60_000;

/** The last day a candidate's conflict check reads: its end, or at most 400 days from its start or `today`, the later. */
function conflictEnd(candidate: Pick<NoteContent, 'startDate'> & { readonly endDate: string | null }, today: string): string {
  const from = today > candidate.startDate ? today : candidate.startDate;
  const limit = utcDay(new Date(`${from}T00:00:00.000Z`), CONFLICT_DAYS - 1);
  return candidate.endDate === null || candidate.endDate > limit ? limit : candidate.endDate;
}

/**
 * Whether a note (slice 3: or a rule's schedule) conflicts with a person's (design decision 7): on a day it covers (a
 * schedule with no end, from its start to 400 days from its start or `today`, the later), a note a person made (not one
 * TownwiseAI saved and nobody edited) or a person's scheduled rule decides the day differently than the candidate does
 * (closed, booked or open). A candidate that decides nothing (an `other` note with an unknown effect) never conflicts.
 * Pure.
 */
export function conflictsWith(candidate: NoteContent | RuleSchedule, persons: PersonsEntries, today: string = candidate.startDate): boolean {
  const own = decisionOf(candidate);
  if (own === null) return false;
  const notes = persons.notes.filter((each) => !isAgentNote(each));
  const last = conflictEnd(candidate, today);
  const days = eachDay(candidate.startDate, last).filter((day) => noteCovers(candidate, day));
  return days.some((day) => [...notes.filter((each) => noteCovers(each, day)), ...persons.rules.filter((rule) => noteCovers(rule, day))]
    .some((entry) => {
      const theirs = decisionOf(entry);
      return theirs !== null && theirs !== own;
    }));
}

/** Slice 3: a rule TownwiseAI added on its own that nobody edited since (its updatedAt still the one it was applied at). */
export function isAgentRule(rule: Pick<BusinessRuleRecord, 'agent' | 'updatedAt'>): boolean {
  const agent = rule.agent ?? null;
  return agent !== null && agent.at.getTime() === rule.updatedAt.getTime();
}

/** The why, one line, at most 200 UTF-16 units and never between the two halves of a surrogate pair; null when empty. */
function cutWhy(why: string | null): string | null {
  if (why === null) return null;
  const line = why.replace(/\s+/g, ' ').trim();
  const end = line.length > MAX_WHY_CHARS && /[\ud800-\udbff]/.test(line.charAt(MAX_WHY_CHARS - 1)) ? MAX_WHY_CHARS - 1 : MAX_WHY_CHARS;
  const fitted = line.slice(0, end).trim();
  return fitted === '' ? null : fitted;
}

/**
 * Slice 3: the rule under the planned id, as TownwiseAI: written now, or found (an earlier attempt, or a racing one, wrote
 * it); null when D31 refuses it (the 30-rule limit, or a rule with its words in any case), so nothing was added.
 */
async function writeRule(ctx: ApplyContext, scope: OrgScope, candidate: RuleCandidate, change: AgentChangeRecord): Promise<BusinessRuleRecord | null> {
  const rules = ctx.stores.businessRules;
  const existing = await rules.find(scope, candidate.locationId, candidate.targetId);
  if (existing !== null) return existing;
  if (await rules.count(scope, candidate.locationId) >= MAX_RULES) return null;
  let rule: BusinessRuleRecord;
  try {
    rule = await rules.create(scope, candidate.locationId, {
      text: candidate.text, schedule: candidate.schedule, addedVia: 'townwise_ai', createdBy: TOWNWISE_AI_AUTHOR, now: ctx.now(),
      id: candidate.targetId, agent: { changeId: change.id },
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // The planned id (a racing attempt wrote it), or a rule with these words in any case (D31 refuses a second).
    return rules.find(scope, candidate.locationId, candidate.targetId);
  }
  // Two adds racing past the limit: the later one takes its rule back, as the rules route does.
  if (await rules.count(scope, candidate.locationId) > MAX_RULES) {
    await rules.remove(scope, candidate.locationId, rule.id);
    return null;
  }
  return rule;
}

/** The note under the planned id: written now, or found (an earlier attempt, or a racing one, wrote it). */
async function writeNote(ctx: ApplyContext, scope: OrgScope, candidate: NoteCandidate, change: AgentChangeRecord): Promise<NoteRecord | null> {
  const existing = await ctx.stores.notes.find(scope, candidate.locationId, candidate.targetId);
  if (existing !== null) return existing;
  try {
    return await ctx.stores.notes.create(scope, candidate.locationId, candidate.note, {
      createdBy: candidate.createdBy, now: ctx.now(), id: candidate.targetId, agent: { changeId: change.id },
      ...(candidate.byStaff === true ? { byStaff: true } : {}), ...(candidate.source === undefined ? {} : { source: candidate.source }),
      ...(candidate.fromEvent === undefined ? {} : { fromEvent: candidate.fromEvent }),
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return ctx.stores.notes.find(scope, candidate.locationId, candidate.targetId);
  }
}

/**
 * Slice 3: the weekdays a note or rule covers, sorted, for the activity's words (so "Closed on Mondays" does not read as
 * every day); null for every day, or a change of another kind.
 */
function weekdaysOf(candidate: ChangeCandidate): number[] | null {
  const weekdays = candidate.action === 'note.add' ? candidate.note.weekdays : candidate.action === 'rule.add' ? candidate.schedule.weekdays : null;
  return weekdays === null || weekdays.length === 0 || weekdays.length >= 7 ? null : [...new Set(weekdays)].sort((a, b) => a - b);
}

/** The dates a change covers, for its row; null for an item. A rule's end is null when it has none (slice 3). */
function datesOf(candidate: ChangeCandidate): { startDate: string; endDate: string | null } | null {
  if (candidate.action === 'note.add') return { startDate: candidate.note.startDate, endDate: candidate.note.endDate };
  if (candidate.action === 'rule.add') return { startDate: candidate.schedule.startDate, endDate: candidate.schedule.endDate };
  return candidate.dates;
}

/**
 * The days a change's refit check reads (agent/refit.ts): a note's dates; a rule's start, as a person's rule marks one
 * (handlers/rules.ts); a written change's row dates (its writer may set what it actually wrote). Null for none.
 */
function refitDates(candidate: ChangeCandidate, current: AgentChangeRecord): { startDate: string; endDate: string } | null {
  if (candidate.action === 'note.add') return { startDate: candidate.note.startDate, endDate: candidate.note.endDate };
  if (candidate.action === 'rule.add') return { startDate: candidate.schedule.startDate, endDate: candidate.schedule.startDate };
  return current.startDate === null || current.endDate === null ? null : { startDate: current.startDate, endDate: current.endDate };
}

/**
 * Applies one candidate (see the top). `persons` is read when left out; a caller applying many reads it once and passes
 * it. A conflict is checked only before the row exists, so a retry of a change already begun never turns into one.
 */
export async function applyChange(
  ctx: ApplyContext, scope: OrgScope, candidate: ChangeCandidate, persons?: PersonsEntries,
): Promise<ApplyResult> {
  const { stores } = ctx;
  const dedupeKey = dedupeKeyOf(candidate.action === 'note.add' ? { action: candidate.action, note: candidate.note }
    : candidate.action === 'rule.add' ? { action: candidate.action, schedule: candidate.schedule } : candidate);
  let row = await stores.agentChanges.findByKey(scope, candidate.locationId, dedupeKey);
  if (row !== null && row.targetId !== candidate.targetId) return { outcome: 'duplicate', change: row };
  if (row === null) {
    if (candidate.action === 'note.add' || candidate.action === 'rule.add') {
      const checked = candidate.action === 'note.add' ? candidate.note : candidate.schedule;
      const today = utcDay(ctx.now());
      const to = conflictEnd(checked, today);
      const entries = persons ?? {
        notes: await stores.notes.overlapping(scope, candidate.locationId, { from: checked.startDate, to }),
        // A person's rules: one TownwiseAI added and nobody edited since is not a person's (slice 3).
        rules: (await stores.businessRules.scheduled(scope, candidate.locationId))
          .flatMap((rule) => (rule.schedule === null || isAgentRule(rule) ? [] : [rule.schedule])),
      };
      if (conflictsWith(checked, entries, today)) return { outcome: 'conflict', change: null };
    }
    const dates = datesOf(candidate);
    const weekdays = weekdaysOf(candidate);
    const inserted = await stores.agentChanges.insertApplying(scope, {
      id: new Types.ObjectId().toHexString(), locationId: candidate.locationId, sourceKind: candidate.sourceKind, sourceId: candidate.sourceId,
      action: candidate.action, targetId: candidate.targetId, dedupeKey, confidence: candidate.confidence, why: cutWhy(candidate.why),
      onBehalfOf: candidate.onBehalfOf, startDate: dates?.startDate ?? null, endDate: dates?.endDate ?? null,
      ...(candidate.action === 'note.add' ? { noteKind: candidate.note.kind } : {}),
      ...(candidate.action === 'rule.add' ? { noteKind: candidate.schedule.kind } : {}),
      ...(weekdays === null ? {} : { weekdays }),
      ...((candidate.action === 'item.add' || candidate.action === 'sales_days.add' || candidate.action === 'booking.label') && candidate.count !== undefined
        ? { count: candidate.count } : {}),
      now: ctx.now(),
    });
    row = inserted.record;
    // Another change took the key between the read and the insert.
    if (!inserted.created && row.targetId !== candidate.targetId) return { outcome: 'duplicate', change: row };
  }
  const wantRefit = async (current: AgentChangeRecord): Promise<void> => {
    const dates = refitDates(candidate, current);
    if (dates !== null) {
      await wantRefitFor(ctx, scope, candidate.locationId, candidate.action === 'sales_days.add' ? 'always' : dates, 'townwise_ai');
    }
  };
  if (row.status !== 'applying') {
    // A retry of this change: an earlier attempt may have stopped between marking it applied and marking the refit.
    if (row.status === 'applied') await wantRefit(row);
    return { outcome: 'applied', change: row };
  }
  let updatedAt: Date | null;
  if (candidate.action === 'note.add') {
    updatedAt = (await writeNote(ctx, scope, candidate, row))?.updatedAt ?? null;
  } else if (candidate.action === 'rule.add') {
    updatedAt = (await writeRule(ctx, scope, candidate, row))?.updatedAt ?? null;
  } else {
    const wrote = await candidate.write(row);
    if (wrote === null || wrote instanceof Date) {
      updatedAt = wrote;
    } else {
      // What was actually written, before the row reads applied (the activity's count and dates, and the refit's).
      await stores.agentChanges.setWritten(scope, candidate.locationId, row.id, {
        count: wrote.count, startDate: wrote.dates?.startDate ?? null, endDate: wrote.dates?.endDate ?? null,
      });
      updatedAt = wrote.updatedAt;
    }
  }
  if (updatedAt === null) {
    // Nothing was added after all (a cap, or the target went): the key is freed, so a later read may try again.
    await stores.agentChanges.removeApplying(scope, candidate.locationId, row.id);
    return { outcome: 'invalid', change: null };
  }
  if (await stores.agentChanges.markApplied(scope, candidate.locationId, row.id, { targetUpdatedAt: updatedAt, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...candidate.actor, at: ctx.now(), orgId: scope.orgId, action: 'agent.change_applied', target: { type: 'location', id: candidate.locationId },
      details: { locationId: candidate.locationId, action: candidate.action, sourceKind: candidate.sourceKind },
    });
    await wantRefit((await stores.agentChanges.find(scope, candidate.locationId, row.id)) ?? row);
  }
  const after = await stores.agentChanges.find(scope, candidate.locationId, row.id);
  return { outcome: 'applied', change: after ?? row };
}

/**
 * The location's weekly, sales and chat changes left `applying` for an hour or more (their pass or turn died mid-apply;
 * those sources plan a new target id each pass, and a failed chat turn is never run again, so no later candidate retries
 * one): one whose note or rule was written, as it was written, is finished through applyChange under its own target
 * (marked applied, its audit event as TownwiseAI finishing it, the row's onBehalfOf naming whose it is, its refit); any
 * other (nothing written, or changed since) is removed, which frees its key. A weekly pass runs it first. A chat row's
 * claim in tw_chat_proposals is left as it is: its turn was not kept, so no card reads it.
 */
export async function finishStaleChanges(ctx: ApplyContext, scope: OrgScope, locationId: string): Promise<void> {
  const { stores } = ctx;
  const before = new Date(ctx.now().getTime() - STALE_APPLYING_MS);
  for (const row of await stores.agentChanges.listApplying(scope, locationId, { before })) {
    if (row.sourceKind !== 'weekly' && row.sourceKind !== 'sales' && row.sourceKind !== 'chat') continue;
    const base = {
      locationId, sourceKind: row.sourceKind, sourceId: row.sourceId, targetId: row.targetId, confidence: row.confidence, why: row.why,
      onBehalfOf: row.onBehalfOf, actor: TOWNWISE_AI_ACTOR,
    };
    let candidate: NoteCandidate | RuleCandidate | null = null;
    if (row.action === 'rule.add') {
      const rule = await stores.businessRules.find(scope, locationId, row.targetId);
      if (rule?.schedule != null) candidate = { ...base, action: 'rule.add', text: rule.text, schedule: rule.schedule };
    } else if (row.action === 'note.add') {
      const note = await stores.notes.find(scope, locationId, row.targetId);
      if (note !== null) {
        candidate = {
          ...base, action: 'note.add', createdBy: note.createdBy, ...(note.fromEvent === null ? {} : { fromEvent: note.fromEvent }),
          note: {
            kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
            expectedGuests: note.expectedGuests, detail: note.detail, title: note.title, startTime: note.startTime, endTime: note.endTime,
          },
        };
      }
    }
    const key = candidate === null ? null : dedupeKeyOf(candidate.action === 'note.add'
      ? { action: candidate.action, note: candidate.note } : { action: candidate.action, schedule: candidate.schedule });
    if (candidate !== null && key === row.dedupeKey) await applyChange(ctx, scope, candidate);
    else await stores.agentChanges.removeApplying(scope, locationId, row.id);
  }
}
