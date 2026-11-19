// Reading with TownwiseAI (spec 11A.9, D34): acting on a read's answer, as the reader's onRead (files/ai-reader.ts).
// The person opted the file in, so TownwiseAI writes without a second press, and DELETE .../data/:ref/ai undoes it
// all: the file's dated events become notes (never a closed span over 14 days, nor more than 31 closed days a read),
// its daily totals a sales upload that only adds days the location does not have, when the file's own text bears them
// out (files/ai-verify.ts), its summary and facts a reference item TownwiseAI can read in chat, and, when it wrote
// notes or days and the person who asked is an org admin now, a calibration starts as them. Nothing is written once the
// person who asked no longer belongs to the organization (or, as staff, their open-as-admin grant ended).
// [CONFIRM: TownwiseAI writes notes and days from an opted-in file without a second press, all undoable] [CONFIRM: a
// file read may start a calibration for the org admin who asked] [CONFIRM: a file read can close at most 31 days, 14
// in a row]
//
// D46: the closed patterns the file states, and a closure the guard refuses only for its span, become suggested closure
// rules (stores/agent-suggestions.ts), which change nothing until a member confirms one. [CONFIRM: a closure over 14
// days that a file read may not write as a note becomes a suggested rule] [CONFIRM: 5 suggested rules a file read, 10
// open per location from files]
//
// No multi-document transactions (DocumentDB): the ids are planned first and saved on the read by compare-and-set,
// each write is keyed by its planned id and skipped when it is already there, and the outcome is recorded last, so a
// retry (the reader calls onRead again on the saved answer, without another model call) completes the work once. Each
// stage, and each note, first checks that the read is still held under this claim with its original, since the file
// can be deleted (or its original purged) while it is read. An audit event is recorded after its write: a crash
// between the two loses the event (a known limit, api/README.md). Nothing here logs a title, a name or a figure; the
// reader's log line and audit event carry the outcome's counts.
//
// D59 (openspec change auto-apply-agent-reads, design decisions 5, 6, 7 and 13): while TownwiseAI works on its own
// (TOWNWISE_AGENT_AUTO and the organization's switch), and for every automatic read, each note, the days and the
// summary item go through the one writer (agent/apply.ts) with `sourceKind: 'file'`, each a ledger row a member can undo.
// A note is applied only when the event and the read are both `high`, it passes the checks above, conflicts with no note
// or rule a person made on its days, and its dedupe key was never used at the location; an event below that bar, or in
// conflict, becomes an open note suggestion from the file (tw_agent_suggestions, `source: 'file'`, `type: 'note'`),
// which any member decides as a file's suggested rule, at most 20 open per location from files and only while it ends
// today or later. [CONFIRM: TownwiseAI applies only what the model rated high and the code checks pass; everything else
// waits] [CONFIRM: a read someone asked for follows the same confidence bar] [CONFIRM: 20 open note suggestions from
// files per location] An automatic read writes as TownwiseAI (`createdBy: 'townwise_ai'`, the audit actor TownwiseAI),
// on behalf of the file's adder, whose seat is still checked first; it starts no calibration, and what it changed on
// training days wants a refit instead (agent/refit.ts). A pressed read keeps its requester as the author and its
// calibration. While the switch is off a pressed read is exactly D34's.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { agentAutoOn, applyChange, TOWNWISE_AI_AUTHOR, type PersonsEntries } from '../agent/apply.ts';
import { wantRefitFor } from '../agent/refit.ts';
import { closureKeyOf, closureRuleText, isSuggestable } from '../agent/closure-suggestions.ts';
import type { Role } from '../access/resolve.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter, TOWNWISE_AI_ACTOR } from '../audit.ts';
import { utcDay } from '../dates.ts';
import { MAX_NOTES, readNoteContent, readRuleSchedule } from '../handlers/notes.ts';
import { checkStart, launch, type StartRefusal, type StartRequest } from '../lab/service.ts';
import { DELETED_PERSON } from '../people.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type {
  AiActionPlan, AiActionsOutcome, AiCalibration, AiCalibrationStatus, AiDaysReason, AiEventEffect, AiItemReason, AiReadEvent,
  AiReadResult, AiRulesSkipped, FileAiRead, FileRecord,
} from '../stores/files.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { UploadRecord } from '../stores/uploads.ts';
import { MAX_NOTE_TITLE_CHARS, type NoteContent, type NoteEffect, type NoteRecord } from '../stores/notes.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import type { OnAiRead } from './ai-reader.ts';
import { salesDayOf } from './ai-verify.ts';
import { CLOSED_PATTERNS_MAX, eventConfidence } from './extract/reader-prompt.ts';
import { saveTextItem, TEXT_ITEM_TITLE_MAX } from './items.ts';

/** A note's detail, at most (spec 12). */
const NOTE_DETAIL_CHARS = 280;
/** Expected guests on a note (spec 12). */
const MAX_EXPECTED_GUESTS = 20_000;
/** The share of the answer's days the file's text must bear out before any is written. [CONFIRM: 95%] */
const VERIFIED_SHARE_PERCENT = 95;
/** A closed note (a closure, or closed) a read makes spans at most this many days, and all of them this many together. */
const CLOSED_SPAN_DAYS = 14;
const CLOSED_DAYS_PER_READ = 31;
/** D46: a read stores no suggested closure rule while the location has this many open from files. */
const OPEN_FILE_SUGGESTIONS = 10;
/** D59: and no note suggestion while it has this many open from files. */
const OPEN_FILE_NOTE_SUGGESTIONS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const EFFECTS: Readonly<Record<AiEventEffect, NoteEffect>> = {
  closed: 'closed', more: 'more_guests', fewer: 'fewer_guests', unknown: 'unknown',
};

const REFUSALS: Readonly<Record<StartRefusal, AiCalibrationStatus>> = {
  lab_unavailable: 'lab_unavailable', not_enough_history: 'not_enough_history', invalid_regime_start: 'regime',
  budget_exhausted: 'budget_spent', in_progress: 'in_progress', rate_limited: 'daily_limit', start_failed: 'start_failed',
};

/** `text` stopped at `max` characters, never between the two halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Lower case, each run of white space one space, trimmed: titles compared case- and whitespace-insensitively. */
function folded(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * D49: an event's title as a note's title. NFC, each run of white space (a line break included) one space, and every
 * control or format character removed rather than refused, since the person did not type them; trimmed; cut to the
 * note's 120 code points (NFC can lengthen a title the reader kept to 120), so the title is cut rather than the event
 * refused; null when nothing is left. The title backfill (files/note-titles.ts) names older notes with it too.
 */
export function eventNoteTitle(raw: string): string | null {
  const cleaned = raw.normalize('NFC').replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ {2,}/g, ' ').trim();
  const title = Array.from(cleaned).slice(0, MAX_NOTE_TITLE_CHARS).join('').trim();
  return title === '' ? null : title;
}

/** A note's detail from an event: its own detail, or null when it is empty or only repeats the title (D49). */
function noteDetailOf(event: AiReadEvent, title: string | null): string | null {
  const detail = event.detail.trim();
  return detail === '' || (title !== null && folded(detail) === folded(title)) ? null : cut(detail, NOTE_DETAIL_CHARS).trim();
}

/** The event as a note, through the notes route's own rules; null when it breaks one (its dates, say). */
function noteContentOf(event: AiReadEvent, today: string): NoteContent | null {
  const effect = EFFECTS[event.effect];
  const guests = event.expectedGuests;
  const title = eventNoteTitle(event.title);
  return readNoteContent({
    kind: event.kind, startDate: event.startDate, endDate: event.endDate, weekdays: null, effect,
    // A count the notes route would refuse (0, a crowd past a restaurant's, or one on a closed note that is not a
    // buyout) is left out rather than the event. A buyout keeps its party's size, which books the day (D30).
    expectedGuests: (effect === 'closed' && event.kind !== 'private_event') || guests === null || guests < 1
      || guests > MAX_EXPECTED_GUESTS ? null : guests,
    title, detail: noteDetailOf(event, title),
  }, today);
}

/** A note that closes the location: a closure, or one whose effect is closed. */
function closes(content: NoteContent): boolean {
  return content.kind === 'closure' || content.effect === 'closed';
}

/** The days from `startDate` to `endDate`, both counted. */
function spanDays(startDate: string, endDate: string): number {
  return Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS) + 1;
}

/**
 * An existing note says the same as the event: same kind, start and end, and its title is the event's (D49), or its
 * detail is the event's title (or starts with it and a colon, as a note TownwiseAI made before titles did).
 */
function duplicates(note: NoteRecord, event: AiReadEvent): boolean {
  if (note.kind !== event.kind || note.startDate !== event.startDate || note.endDate !== event.endDate) return false;
  const named = eventNoteTitle(event.title);
  if (named !== null && note.title !== null && folded(note.title) === folded(named)) return true;
  return detailSays(note.detail, event.title);
}

/** A note's detail still says the event's title, as a note from before titles wrote it: "title" or "title: detail". */
export function detailSays(detail: string | null, title: string): boolean {
  if (detail === null) return false;
  const said = folded(detail);
  const name = folded(title);
  return said === name || said.startsWith(`${name}:`);
}

/** The summary item's title: "TownwiseAI’s notes on" the file's name without its extension, at most 120 characters. */
export function summaryTitle(name: string): string {
  const dot = name.lastIndexOf('.');
  return cut(`TownwiseAI’s notes on ${dot > 0 ? name.slice(0, dot) : name}`, TEXT_ITEM_TITLE_MAX);
}

/** The summary item's text: the summary, then each fact on a "- " line. */
function summaryText(result: AiReadResult): string {
  return result.facts.length === 0 ? result.summary : `${result.summary}\n\n${result.facts.map((fact) => `- ${fact}`).join('\n')}`;
}

/** Why no day may be written from this read, in order; null when the days the file's text bears out may be. */
function daysRefusal(file: FileRecord, result: AiReadResult): AiDaysReason | null {
  if (result.kind !== 'sales') return 'not_sales';
  if (result.days.length === 0) return 'no_days';
  if (file.uploadId !== null || (file.result?.dayCount ?? 0) > 0) return 'file_wrote_days';
  // Never days from a picture: it has no text to check them against.
  if (result.daysBorneOut === null) return 'picture';
  if (result.confidence !== 'high') return 'not_high_confidence';
  return null;
}

function newPlan(events: number): AiActionPlan {
  const id = (): string => new Types.ObjectId().toHexString();
  return {
    noteIds: Array.from({ length: events }, id), uploadId: id(), itemId: id(), calibrationId: id(),
    suggestionIds: Array.from({ length: CLOSED_PATTERNS_MAX }, id),
  };
}

/** A closure schedule a read may suggest (D46), under its planned id. */
interface Candidate { readonly id: string; readonly schedule: RuleSchedule }

interface Written {
  readonly notes: string[];
  readonly notesSkipped: AiActionsOutcome['notesSkipped'];
  /** D46: closures the guard refused only for their span, ending today or later: suggestions under their note ids. */
  readonly spans: Candidate[];
  /** D59: the events kept as note suggestions, under their note ids; absent while TownwiseAI does not work on its own. */
  readonly notesSuggested?: string[];
}

/** D46: a closure the guard refused only for its span, as the closure rule a read suggests instead. */
function spanSchedule(content: NoteContent): RuleSchedule {
  return {
    kind: 'closure', startDate: content.startDate, endDate: content.endDate, weekdays: content.weekdays, effect: 'closed',
    expectedGuests: null, startTime: null, endTime: null,
  };
}

/** The Monday that starts `day`'s week. */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return utcDay(new Date(`${day}T00:00:00.000Z`), -((weekday + 6) % 7));
}

/**
 * The person who asked (or, D59, the file's adder an automatic read reads for), and their role now (org_admin for
 * Townwise staff open as admin). `ledger`: TownwiseAI works on its own, so writes go through agent/apply.ts.
 */
interface Requester { readonly ai: FileAiRead; readonly role: Role; readonly ledger: boolean }

/** The read's file, re-read, while the read is still held under this claim with its original; else null. */
type Held = () => Promise<FileRecord | null>;

export function createAiReadActions(ctx: TownwiseContext): OnAiRead {
  const { stores } = ctx;

  /** The person who asked, as the actor of the events a read records (as staff: superadmin, with the grant). */
  async function actorOf({ ai, role }: Requester): Promise<Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'>> {
    // D59: an automatic read's writes are TownwiseAI's own.
    if (ai.auto) return TOWNWISE_AI_ACTOR;
    const email = (await ctx.authStores.users.findById(ai.requestedBy))?.email ?? DELETED_PERSON;
    return { actorUserId: ai.requestedBy, actorEmail: email, actorRole: ai.requestedByStaff ? 'superadmin' : role, viewAsGrantId: ai.requestedGrantId };
  }

  /**
   * The role of the person who asked, now: their active seat's, or org_admin for Townwise staff while the open-as-admin
   * grant they asked under is live for this organization; null when they have no seat (or the grant ended).
   */
  async function roleNow(scope: OrgScope, ai: FileAiRead): Promise<Role | null> {
    if (!ai.requestedByStaff) return stores.members.activeRole(scope, ai.requestedBy);
    const grant = ai.requestedGrantId === null ? null : await stores.grants.findById(ai.requestedGrantId);
    const live = grant?.kind === 'open_as_admin' && grant.orgId === scope.orgId && grant.endedAt === null && grant.expiresAt > ctx.now();
    return live ? 'org_admin' : null;
  }

  /**
   * Events to notes, at most one a planned id (50 a file): a note already holding its id was written by an earlier
   * attempt; an event the notes route would refuse, one an existing note already says, a closed note over 14 days or
   * past 31 closed days this read (the guard), and any past the location's 1,000 notes are skipped and counted. Each
   * new note first checks the read is still held; once it is not, no more is written. D46: a closure (kind closure) the
   * guard refuses for its span, ending on or after the town's today, is handed on as a suggestion under its note id
   * instead, on a plan that has suggestion ids; it is not counted as skipped. D59, with `requester.ledger`: each note
   * goes through applyChange under its planned id, and an event below the bar, or in conflict with a person's note or
   * rule, is kept as an open note suggestion under that id (suggestNote); a duplicate key is a duplicate.
   */
  async function writeNotes(
    scope: OrgScope, file: FileRecord, requester: Requester, result: AiReadResult, plan: AiActionPlan, held: Held, townToday: string,
  ): Promise<Written> {
    const { ai, ledger } = requester;
    const existing = await stores.notes.list(scope, file.locationId);
    const ids = new Set(existing.map((note) => note.id));
    const notes: string[] = [];
    const spans: Candidate[] = [];
    const suggested: string[] = [];
    const skipped = { duplicate: 0, cap: 0, invalid: 0, guard: 0, notKept: 0 };
    let closedDays = 0;
    const today = utcDay(ctx.now());
    const actor = ledger ? await actorOf(requester) : null;
    const persons: PersonsEntries | null = ledger ? {
      notes: existing,
      rules: (await stores.businessRules.scheduled(scope, file.locationId)).flatMap((rule) => (rule.schedule === null ? [] : [rule.schedule])),
    } : null;
    let openNotes = ledger ? (await stores.agentSuggestions.listOpenFileNotes(scope, file.locationId, townToday)).length : 0;
    /** D59: the event as an open note suggestion from the file, or not kept (ended, or the location's 20 open). */
    const suggestNote = async (id: string, content: NoteContent): Promise<void> => {
      if (content.endDate < townToday || openNotes >= OPEN_FILE_NOTE_SUGGESTIONS) {
        skipped.notKept += 1;
        return;
      }
      const stored = await stores.agentSuggestions.insertFileNote(scope, {
        id, locationId: file.locationId, week: mondayOf(townToday), fileId: file.id, note: content, now: ctx.now(),
      });
      if (stored.created) openNotes += 1;
      suggested.push(id);
    };
    /** D59: the note through the one writer, as TownwiseAI (an automatic read) or as the person who asked. */
    const apply = async (id: string, content: NoteContent, event: AiReadEvent) => applyChange(ctx, scope, {
      action: 'note.add', locationId: file.locationId, sourceKind: 'file', sourceId: file.id, targetId: id,
      confidence: eventConfidence(event, result), why: event.detail === '' ? null : event.detail, onBehalfOf: ai.requestedBy,
      actor: actor ?? TOWNWISE_AI_ACTOR, note: content, createdBy: ai.auto ? TOWNWISE_AI_AUTHOR : ai.requestedBy,
      ...(!ai.auto && ai.requestedByStaff ? { byStaff: true } : {}), source: { via: 'ai_file', fileId: file.id },
    }, persons ?? undefined);
    for (const [index, event] of result.events.entries()) {
      const id = plan.noteIds[index];
      if (id === undefined) break;
      const content = noteContentOf(event, today);
      const closed = content !== null && closes(content) ? spanDays(content.startDate, content.endDate) : 0;
      if (ids.has(id)) {
        // An earlier attempt wrote it: its change (D59) is finished too.
        if (ledger && content !== null) await apply(id, content, event);
        notes.push(id);
        closedDays += closed;
        continue;
      }
      if (ledger && (await stores.agentSuggestions.find(scope, file.locationId, id))?.type === 'note') {
        // An earlier attempt kept it as a note suggestion.
        suggested.push(id);
        continue;
      }
      if (content === null) skipped.invalid += 1;
      else if (existing.some((note) => duplicates(note, event))) skipped.duplicate += 1;
      else if (closed > CLOSED_SPAN_DAYS && content.kind === 'closure' && content.endDate >= townToday && plan.suggestionIds !== undefined) {
        spans.push({ id, schedule: spanSchedule(content) });
      } else if (closed > CLOSED_SPAN_DAYS || closedDays + closed > CLOSED_DAYS_PER_READ) skipped.guard += 1;
      else if (existing.length >= MAX_NOTES) skipped.cap += 1;
      else if (ledger) {
        if (await held() === null) break;
        if (eventConfidence(event, result) !== 'high') {
          await suggestNote(id, content);
          continue;
        }
        const applied = await apply(id, content, event);
        if (applied.outcome === 'conflict') await suggestNote(id, content);
        else if (applied.outcome === 'duplicate') skipped.duplicate += 1;
        else if (applied.outcome === 'invalid') skipped.invalid += 1;
        else {
          const written = await stores.notes.find(scope, file.locationId, id);
          if (written !== null) existing.push(written);
          ids.add(id);
          notes.push(id);
          closedDays += closed;
        }
      } else {
        if (await held() === null) break;
        try {
          existing.push(await stores.notes.create(scope, file.locationId, content, {
            createdBy: ai.requestedBy, now: ctx.now(), id, ...(ai.requestedByStaff ? { byStaff: true } : {}),
            source: { via: 'ai_file', fileId: file.id },
          }));
        } catch (err) {
          // A takeover of this read wrote it meanwhile.
          if (!isDuplicateKeyError(err)) throw err;
        }
        ids.add(id);
        notes.push(id);
        closedDays += closed;
      }
    }
    const { notKept, ...counts } = skipped;
    return ledger
      ? { notes, notesSkipped: notKept > 0 ? { ...counts, notKept } : counts, spans, notesSuggested: suggested }
      : { notes, notesSkipped: counts, spans };
  }

  /**
   * D46: the answer's closed patterns, under the plan's suggestion ids, then the closures the guard refused for their
   * span, under their note ids, as open suggested closure rules from this file, in the requester's name only as the
   * read's: a member decides them. A planned id already stored was written by an earlier attempt and counts, before any
   * cap. Otherwise: a schedule the rule schedule rules refuse is `invalid`; one a rule of the location already covers or
   * words, or whose closure key a row already holds (in any status), is `duplicate`; past 10 open file suggestions at the
   * location is `cap` (two reads of one organization never run at once, so only a sales decide can race it, and the
   * unique key settles that). Each new one first checks the read is still held. A plan saved before suggestions had ids
   * makes none.
   */
  async function writeSuggestions(
    scope: OrgScope, file: FileRecord, result: AiReadResult, plan: AiActionPlan, spans: readonly Candidate[], held: Held, townToday: string,
  ): Promise<{ rulesSuggested: string[]; rulesSkipped: AiRulesSkipped }> {
    const rulesSuggested: string[] = [];
    const skipped = { duplicate: 0, cap: 0, invalid: 0 };
    const planned = plan.suggestionIds;
    if (planned === undefined) return { rulesSuggested, rulesSkipped: skipped };
    const patterns = (result.closedPatterns ?? []).slice(0, planned.length).flatMap((schedule, index) => {
      const id = planned[index];
      return id === undefined ? [] : [{ id, schedule }];
    });
    const candidates = [...patterns, ...spans];
    if (candidates.length === 0) return { rulesSuggested, rulesSkipped: skipped };
    const { agentSuggestions, businessRules } = stores;
    const rules = await businessRules.list(scope, file.locationId);
    let open = (await agentSuggestions.listOpenRules(scope, file.locationId, townToday)).filter((row) => row.source === 'file').length;
    for (const candidate of candidates) {
      const earlier = await agentSuggestions.find(scope, file.locationId, candidate.id);
      if (earlier !== null) {
        rulesSuggested.push(candidate.id);
        continue;
      }
      const schedule = readRuleSchedule(candidate.schedule, townToday);
      if (schedule === null) skipped.invalid += 1;
      else if (!isSuggestable(schedule, { rules })) skipped.duplicate += 1;
      else if (open >= OPEN_FILE_SUGGESTIONS) skipped.cap += 1;
      else {
        if (await held() === null) break;
        const stored = await agentSuggestions.insertOne(scope, {
          id: candidate.id, locationId: file.locationId, week: mondayOf(townToday), source: 'file', fileId: file.id,
          text: closureRuleText(schedule), schedule, closureKey: closureKeyOf(schedule), now: ctx.now(),
        });
        if (stored === null) skipped.duplicate += 1;
        else {
          rulesSuggested.push(candidate.id);
          if (stored.created) open += 1;
        }
      }
    }
    return { rulesSuggested, rulesSkipped: skipped };
  }

  /**
   * Daily totals to one new upload, through the upload route's store, when daysRefusal allows and at least 95% of the
   * answer's days are borne out by the file's text (checked when the answer was saved); then only those are written,
   * and only as new days for everyone: a day the location already has (from any upload, turned off or not) is never
   * replaced and no null is written over a figure, so it is left out and counted, and when every one is already there
   * no upload is made (`already_had_days`). The upload holds the planned id, so a retry finds it: one still `applying`
   * is applied again (the same days, so the same result), one `applied` is left as it is. Undo then removes exactly the
   * days this upload added. Applying it wants a refit (D59). With `requester.ledger` the upload is a `sales_days.add`
   * change through applyChange, keyed by the file, so a file whose days were undone never adds them again (`duplicate`).
   */
  async function writeDays(
    scope: OrgScope, file: FileRecord, requester: Requester, result: AiReadResult, plan: AiActionPlan,
  ): Promise<Pick<AiActionsOutcome, 'uploadId' | 'daysWritten' | 'daysAlreadyHad' | 'daysReason'>> {
    const none = (daysReason: AiDaysReason, daysAlreadyHad = 0): Pick<AiActionsOutcome, 'uploadId' | 'daysWritten' | 'daysAlreadyHad' | 'daysReason'> => (
      { uploadId: null, daysWritten: 0, daysAlreadyHad, daysReason }
    );
    const refusal = daysRefusal(file, result);
    if (refusal !== null) return none(refusal);
    const days = (result.daysBorneOut ?? []).flatMap((index) => {
      const day = result.days[index];
      return day === undefined ? [] : [salesDayOf(day)];
    });
    if (days.length === 0 || days.length * 100 < result.days.length * VERIFIED_SHARE_PERCENT) return none('days_not_verified');
    const had = await stores.salesDays.existingDates(scope, file.locationId, days.map((day) => day.date), plan.uploadId);
    if (had.size === days.length) return none('already_had_days', had.size);
    const now = ctx.now();
    const dates = days.map((day) => day.date).sort();
    const firstDate = dates[0] ?? '';
    const lastDate = dates.at(-1) ?? '';
    const { ai } = requester;
    const writeUpload = async (): Promise<UploadRecord> => {
      let upload = await stores.uploads.get(scope, file.locationId, plan.uploadId);
      if (upload === null) {
        try {
          upload = await stores.uploads.start(scope, file.locationId, {
            id: plan.uploadId, uploadedBy: ai.requestedBy, uploadedAt: now, dayCount: days.length, firstDate, lastDate,
            hasGuests: days.some((day) => day.guests !== null), hasNetSales: days.some((day) => day.netSalesCents !== null),
            ...(ai.requestedByStaff ? { byStaff: true } : {}), source: { via: 'ai_file', fileId: file.id },
          });
        } catch (err) {
          upload = isDuplicateKeyError(err) ? await stores.uploads.get(scope, file.locationId, plan.uploadId) : null;
          if (upload === null) throw err;
        }
      }
      if (upload.status === 'applying') {
        // Add-only: a day already stored is matched and left as it is, whoever wrote it.
        await stores.salesDays.apply(scope, file.locationId, { uploadId: upload.id, days, replace: false, now });
        // Applied again after a retry, its own days read as already there, so its counts come from the days it holds.
        const held = (await stores.salesDays.ownedDayCounts(scope, [upload.id])).get(upload.id) ?? 0;
        const counts = { inserted: held, replaced: 0, kept: days.length - held };
        await stores.uploads.finish(scope, upload.id, counts);
        ctx.logger.info({ orgId: scope.orgId, locationId: file.locationId, uploadId: upload.id, dayCount: days.length }, 'townwise.upload_applied');
        await recordAfter(ctx, {
          ...await actorOf(requester), at: ctx.now(), orgId: scope.orgId, action: 'sales.uploaded', target: { type: 'upload', id: upload.id },
          details: {
            locationId: file.locationId, dayCount: days.length, inserted: counts.inserted, replaced: 0, firstDate, lastDate,
            fileId: file.id, via: 'townwise_ai',
          },
        });
        await wantRefitFor(ctx, scope, file.locationId, 'always');
      }
      return upload;
    };
    let uploadId = plan.uploadId;
    if (requester.ledger) {
      const applied = await applyChange(ctx, scope, {
        action: 'sales_days.add', locationId: file.locationId, sourceKind: 'file', sourceId: file.id, targetId: plan.uploadId,
        confidence: result.confidence, why: null, onBehalfOf: ai.requestedBy, actor: await actorOf(requester), key: `file:${file.id}`,
        dates: { startDate: firstDate, endDate: lastDate }, write: async () => (await writeUpload()).uploadedAt,
      });
      if (applied.outcome === 'duplicate') return none('duplicate', had.size);
    } else {
      uploadId = (await writeUpload()).id;
    }
    const daysWritten = (await stores.salesDays.ownedDayCounts(scope, [uploadId])).get(uploadId) ?? 0;
    return { uploadId, daysWritten, daysAlreadyHad: had.size, daysReason: null };
  }

  /**
   * The summary and facts as a reference text item under the planned id (saveTextItem answers the item a retry finds),
   * added by the person who asked, `townwise_ai`, naming the file it was read from by its name now (`file` is re-read:
   * a rename while it was read counts). A cap that refuses it skips it. With `requester.ledger` (D59) it is an
   * `item.add` change through applyChange, keyed by the file.
   */
  async function keepSummary(
    scope: OrgScope, file: FileRecord, requester: Requester, result: AiReadResult, plan: AiActionPlan,
  ): Promise<Pick<AiActionsOutcome, 'itemId' | 'itemReason'>> {
    const blobs = ctx.files;
    if (blobs === null) throw new Error('stored files are off');
    if (result.summary.trim() === '') return { itemId: null, itemReason: 'no_summary' };
    const { ai } = requester;
    const save = async (): Promise<Pick<AiActionsOutcome, 'itemId' | 'itemReason'> & { at: Date | null }> => {
      const saved = await saveTextItem(stores, blobs, scope, file.locationId, {
        id: plan.itemId, title: summaryTitle(file.name), text: summaryText(result), uploadedBy: ai.requestedBy, uploaderRole: requester.role,
        ...(ai.requestedByStaff && ai.requestedGrantId !== null ? { openAsAdminGrantId: ai.requestedGrantId } : {}),
        addedVia: 'townwise_ai', source: { via: 'ai_file', fileId: file.id }, now: ctx.now(),
      });
      if (saved === 'storage_full' || saved === 'daily_upload_limit') return { itemId: null, itemReason: saved satisfies AiItemReason, at: null };
      if (saved.created) {
        const item = saved.file;
        await recordAfter(ctx, {
          ...await actorOf(requester), at: ctx.now(), orgId: scope.orgId, action: 'file.uploaded', target: { type: 'file', id: item.id },
          details: { locationId: item.locationId, kind: item.kind, sizeBytes: item.sizeBytes, purpose: item.purpose, via: 'townwise_ai' },
        });
        ctx.logger.info({ fileId: item.id, kind: item.kind, sizeBytes: item.sizeBytes, purpose: item.purpose, durationMs: 0 }, 'townwise.file_stored');
      }
      return { itemId: saved.file.id, itemReason: null, at: saved.file.uploadedAt };
    };
    if (!requester.ledger) {
      const saved = await save();
      return { itemId: saved.itemId, itemReason: saved.itemReason };
    }
    const kept: { refused: AiItemReason | null } = { refused: null };
    const applied = await applyChange(ctx, scope, {
      action: 'item.add', locationId: file.locationId, sourceKind: 'file', sourceId: file.id, targetId: plan.itemId,
      confidence: result.confidence, why: null, onBehalfOf: ai.requestedBy, actor: await actorOf(requester), key: `file:${file.id}`,
      dates: null, write: async () => {
        const saved = await save();
        kept.refused = saved.itemReason;
        return saved.at;
      },
    });
    if (applied.outcome === 'duplicate') return { itemId: null, itemReason: 'duplicate' };
    if (applied.outcome === 'invalid') return { itemId: null, itemReason: kept.refused ?? 'storage_full' };
    return { itemId: plan.itemId, itemReason: null };
  }

  /**
   * The model update: when the read wrote notes or days and the person who asked is an org admin now (their current
   * role decides, not the one they asked with), a calibration as them (staff open as admin start it as staff) through
   * the lab's own checks, under the planned id, so a retry finds the one it started. Publishing stays behind staff's
   * forecasts switch. A refusal is recorded, never a failure of the read.
   */
  async function calibrate(
    scope: OrgScope, requester: Requester, plan: AiActionPlan, location: LocationRecord, wrote: boolean,
  ): Promise<AiCalibration> {
    const { ai } = requester;
    if (!wrote) return { status: 'not_needed', id: null };
    // D59: an automatic read starts no calibration; what it changed on training days wants a refit (agent/refit.ts).
    if (ai.auto) return { status: 'refit_wanted', id: null };
    if (requester.role !== 'org_admin') return { status: 'not_admin', id: null };
    const earlier = await stores.calibrations.find(scope, plan.calibrationId);
    if (earlier !== null) return earlier.failure === 'start_failed' ? { status: 'start_failed', id: null } : { status: 'started', id: earlier.id };
    if ((await stores.orgs.findById(scope.orgId))?.status !== 'active') return { status: 'org_not_active', id: null };
    const request: StartRequest = {
      id: plan.calibrationId, scope, location,
      requester: { userId: ai.requestedBy, role: ai.requestedByStaff ? 'superadmin' : 'org_admin', via: 'file' },
      regimeStart: null, today: localDay(ctx.now(), timeZoneOf(location.town).timeZone),
    };
    const refusal = await checkStart(ctx, request);
    if (refusal !== null) return { status: REFUSALS[refusal], id: null };
    const launched = await launch(ctx, request);
    // A job that couldn't start leaves a calibration failed start_failed, so its request is recorded too.
    if (launched.ok || launched.code === 'start_failed') {
      await recordAfter(ctx, {
        ...await actorOf(requester), at: ctx.now(), orgId: scope.orgId, action: 'calibration.requested', target: { type: 'calibration', id: request.id },
        details: { locationId: location.id, calibrationId: request.id, via: 'file', hasRegime: false },
      });
    }
    return launched.ok ? { status: 'started', id: launched.calibration.id } : { status: REFUSALS[launched.code], id: null };
  }

  /**
   * onRead: nothing more when an earlier attempt recorded the outcome; `requester_gone`, writing nothing, when the
   * person who asked no longer may act for the organization; else the plan saved (or an earlier attempt's found), then
   * notes, days, the summary item and the model update, each only while the read is still held under this claim with
   * its original, then the outcome. A read no longer held writes nothing more.
   */
  return async (scope, file, read) => {
    const ai = file.ai;
    if (ai === null || (ai.actions?.outcome ?? null) !== null) return null;
    const role = await roleNow(scope, ai);
    if (role === null) return 'requester_gone';
    // D59: through the one writer while TownwiseAI works on its own, and always for a read it started on its own.
    const requester: Requester = { ai, role, ledger: ai.auto || await agentAutoOn(ctx, scope.orgId) };
    const attempt = ai.attempts;
    const plan = (await stores.files.planAiActions(scope, file.id, attempt, newPlan(read.result.events.length)))?.ai?.actions?.plan;
    if (plan === undefined) return null;
    const held: Held = async () => {
      const now = await stores.files.get(scope, file.locationId, file.id);
      const holds = now !== null && now.status !== 'deleting' && now.rawDeletedAt === null && now.ai?.status === 'reading' && now.ai.attempts === attempt;
      return holds ? now : null;
    };
    const location = await stores.locations.find(scope, file.locationId);
    if (location === null) return null;
    const townToday = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
    const { result } = read;
    const { spans, ...written } = await writeNotes(scope, file, requester, result, plan, held, townToday);
    if (await held() === null) return null;
    const suggested = await writeSuggestions(scope, file, result, plan, spans, held, townToday);
    if (await held() === null) return null;
    const days = await writeDays(scope, file, requester, result, plan);
    const current = await held();
    if (current === null) return null;
    const item = await keepSummary(scope, current, requester, result, plan);
    if (await held() === null) return null;
    const calibration = await calibrate(scope, requester, plan, location, written.notes.length > 0 || days.daysWritten > 0);
    await stores.files.recordAiActions(scope, file.id, attempt, { ...written, ...days, ...item, calibration, ...suggested });
    return null;
  };
}
