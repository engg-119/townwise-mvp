// The one writer of TownwiseAI's own changes (D59, openspec change auto-apply-agent-reads design decisions 5, 6, 7 and
// 9): every source calls applyChange with a typed candidate, and it answers `applied`, `duplicate`, `conflict` or
// `invalid`. It only adds: a note (`note.add`), a summary item (`item.add`), missing sales days (`sales_days.add`) or
// (slice 2) the labels of a file calendar sorted on import (`booking.label`, one change per calendar, whose writer labels
// only events nobody labeled); it never changes or deletes anything that exists. There are no transactions (DocumentDB), so the writes are ordered
// for retries: the ledger row is inserted `applying` under the planned target id and a dedupe key unique per location in
// every status; the target is written under that id (a second create fails on its primary key and counts as done); the
// row is set `applied` with the target's updatedAt by compare-and-set; the audit event is recorded only by the call
// whose compare-and-set lands; then the location is marked as wanting a refit when the change touches a training day. A
// retry finds the row by its key, sees its own planned target, and finishes the steps left. A key another change holds,
// in any status (an undone one included), is a duplicate, so nothing undone is ever made again. Before the row, a note
// is checked against the notes and scheduled rules a person made on its days: one that decides a day differently is a
// conflict, and the candidate waits as a suggestion instead (the caller's choice). Logs and audit events carry ids,
// the action and the source kind only: never a title, a why, a file name or a figure.
import { createHash } from 'node:crypto';

import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter } from '../audit.ts';
import { isBuyout, isClosure, saysOpen, type Entry } from '../closed-days.ts';
import { isAgentNote } from '../forecasts/adjust.ts';
import { eachDay } from '../forecasts/file.ts';
import type {
  AgentChangeAction, AgentChangeRecord, AgentConfidence, AgentSourceKind,
} from '../stores/agent-changes.ts';
import { MAX_WHY_CHARS } from '../stores/agent-changes.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { AiSource } from '../stores/files.ts';
import type { NoteContent, NoteLink, NoteRecord } from '../stores/notes.ts';
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
 * An item, missing sales days or a calendar's labels, written by the caller's own writer under the planned id. `key` is
 * the content the dedupe key is made of. `write` is handed the ledger row (`applying`; a retry gets the same row, so its
 * `appliedAt` is a time planned before any write) and resolves the target's updatedAt, or null when it added nothing
 * after all (the row is then removed, and the answer is `invalid`); a second call must complete the first's write.
 */
export interface WrittenCandidate extends CandidateBase {
  readonly action: 'item.add' | 'sales_days.add' | 'booking.label';
  readonly key: string;
  /** The dates the days (or a calendar's buyouts and parties) cover, for the activity and the refit; null for an item. */
  readonly dates: { readonly startDate: string; readonly endDate: string } | null;
  /** How many records it adds, for the activity's words (a calendar's labels); left out otherwise. */
  readonly count?: number;
  readonly write: (change: AgentChangeRecord) => Promise<Date | null>;
}

export type ChangeCandidate = NoteCandidate | WrittenCandidate;

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

/**
 * The dedupe key of a change (design decision 5): a hash of the action and its content normalized. A note's is its kind,
 * dates, weekdays (in order), effect and folded title, so the same event from a PDF and a photo is one change; an item's
 * and days' are the caller's key (the file they came from).
 */
export function dedupeKeyOf(candidate: { action: AgentChangeAction; note?: NoteContent; key?: string }): string {
  const parts: unknown[] = [candidate.action];
  const { note } = candidate;
  if (note !== undefined) {
    parts.push(
      note.kind, note.startDate, note.endDate, note.weekdays === null ? null : [...note.weekdays].sort((a, b) => a - b), note.effect,
      note.title === null ? null : folded(note.title),
    );
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

/** A note covers at most this many days for the conflict check (a closure TownwiseAI writes spans at most 14). */
const CONFLICT_DAYS = 400;

/**
 * Whether a note conflicts with a person's (design decision 7): on a day it covers, a note a person made (not one
 * TownwiseAI saved and nobody edited) or a person's scheduled rule decides the day differently than the candidate does
 * (closed, booked or open). A candidate that decides nothing (an `other` note with an unknown effect) never conflicts.
 * Pure.
 */
export function conflictsWith(note: NoteContent, persons: PersonsEntries): boolean {
  const own = decisionOf(note);
  if (own === null) return false;
  const notes = persons.notes.filter((each) => !isAgentNote(each));
  const days = eachDay(note.startDate, note.endDate).slice(0, CONFLICT_DAYS).filter((day) => noteCovers(note, day));
  return days.some((day) => [...notes.filter((each) => noteCovers(each, day)), ...persons.rules.filter((rule) => noteCovers(rule, day))]
    .some((entry) => {
      const theirs = decisionOf(entry);
      return theirs !== null && theirs !== own;
    }));
}

/** The why, one line, at most 200 UTF-16 units and never between the two halves of a surrogate pair; null when empty. */
function cutWhy(why: string | null): string | null {
  if (why === null) return null;
  const line = why.replace(/\s+/g, ' ').trim();
  const end = line.length > MAX_WHY_CHARS && /[\ud800-\udbff]/.test(line.charAt(MAX_WHY_CHARS - 1)) ? MAX_WHY_CHARS - 1 : MAX_WHY_CHARS;
  const fitted = line.slice(0, end).trim();
  return fitted === '' ? null : fitted;
}

/** The note under the planned id: written now, or found (an earlier attempt, or a racing one, wrote it). */
async function writeNote(ctx: TownwiseContext, scope: OrgScope, candidate: NoteCandidate, change: AgentChangeRecord): Promise<NoteRecord | null> {
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

/** The dates a change covers, for its row and the refit; null for an item. */
function datesOf(candidate: ChangeCandidate): { startDate: string; endDate: string } | null {
  if (candidate.action === 'note.add') return { startDate: candidate.note.startDate, endDate: candidate.note.endDate };
  return candidate.dates;
}

/**
 * Applies one candidate (see the top). `persons` is read when left out; a caller applying many reads it once and passes
 * it. A conflict is checked only before the row exists, so a retry of a change already begun never turns into one.
 */
export async function applyChange(
  ctx: TownwiseContext, scope: OrgScope, candidate: ChangeCandidate, persons?: PersonsEntries,
): Promise<ApplyResult> {
  const { stores } = ctx;
  const dedupeKey = dedupeKeyOf(candidate.action === 'note.add' ? { action: candidate.action, note: candidate.note } : candidate);
  let row = await stores.agentChanges.findByKey(scope, candidate.locationId, dedupeKey);
  if (row !== null && row.targetId !== candidate.targetId) return { outcome: 'duplicate', change: row };
  if (row === null) {
    if (candidate.action === 'note.add') {
      const entries = persons ?? {
        notes: await stores.notes.overlapping(scope, candidate.locationId, { from: candidate.note.startDate, to: candidate.note.endDate }),
        rules: (await stores.businessRules.scheduled(scope, candidate.locationId)).flatMap((rule) => (rule.schedule === null ? [] : [rule.schedule])),
      };
      if (conflictsWith(candidate.note, entries)) return { outcome: 'conflict', change: null };
    }
    const dates = datesOf(candidate);
    const inserted = await stores.agentChanges.insertApplying(scope, {
      id: new Types.ObjectId().toHexString(), locationId: candidate.locationId, sourceKind: candidate.sourceKind, sourceId: candidate.sourceId,
      action: candidate.action, targetId: candidate.targetId, dedupeKey, confidence: candidate.confidence, why: cutWhy(candidate.why),
      onBehalfOf: candidate.onBehalfOf, startDate: dates?.startDate ?? null, endDate: dates?.endDate ?? null,
      ...(candidate.action === 'note.add' ? { noteKind: candidate.note.kind } : {}),
      ...(candidate.action !== 'note.add' && candidate.count !== undefined ? { count: candidate.count } : {}), now: ctx.now(),
    });
    row = inserted.record;
    // Another change took the key between the read and the insert.
    if (!inserted.created && row.targetId !== candidate.targetId) return { outcome: 'duplicate', change: row };
  }
  const wantRefit = async (): Promise<void> => {
    const dates = datesOf(candidate);
    if (dates !== null) await wantRefitFor(ctx, scope, candidate.locationId, candidate.action === 'sales_days.add' ? 'always' : dates);
  };
  if (row.status !== 'applying') {
    // A retry of this change: an earlier attempt may have stopped between marking it applied and marking the refit.
    if (row.status === 'applied') await wantRefit();
    return { outcome: 'applied', change: row };
  }
  let updatedAt: Date | null;
  if (candidate.action === 'note.add') {
    updatedAt = (await writeNote(ctx, scope, candidate, row))?.updatedAt ?? null;
  } else {
    updatedAt = await candidate.write(row);
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
    await wantRefit();
  }
  const after = await stores.agentChanges.find(scope, candidate.locationId, row.id);
  return { outcome: 'applied', change: after ?? row };
}
