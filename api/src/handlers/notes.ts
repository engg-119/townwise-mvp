// Notes, the tuning step (spec 10.5, 12, P14): structured notes per location for what sales can't show. The forecast
// reader and the tuning chat read them. Authors edit and delete their own; org admins edit and delete any. `detail`,
// hours and guests are never logged and never copied into an audit event.
import { isDuplicateKeyError, objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { daysBetween, EARLIEST_DATE, isoDate, plusYears, utcDay } from '../dates.ts';
import { authorEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent, NoteRecord } from '../stores/notes.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** Spec 12. */
export interface NoteView extends NoteContent {
  id: string; createdByEmail: string; createdAt: string; updatedAt: string; canEdit: boolean;
}

/** Spec 6.7. [CONFIRM: 1,000 notes] */
const MAX_NOTES = 1000;
/** An end date at most 366 days after the start. */
const MAX_SPAN_DAYS = 366;
const MAX_EXPECTED_GUESTS = 20_000;
/** Local wall-clock time, 24-hour 'HH:MM'. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** The fields a note and a business rule's schedule (D31) share. */
const sharedFields = {
  kind: z.enum(['closure', 'private_event', 'opening', 'other']),
  startDate: isoDate,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullish(),
  effect: z.enum(['closed', 'more_guests', 'fewer_guests', 'unknown']),
  expectedGuests: z.number().int().min(1).max(MAX_EXPECTED_GUESTS).nullish(),
  startTime: clockTime.nullish(),
  endTime: clockTime.nullish(),
};

const noteBody = z.object({ ...sharedFields, endDate: isoDate, detail: z.string().trim().max(280).nullish() });

/** A rule's schedule: strict, with no detail (the rule's text is its words), and no end when `endDate` is null or left out. */
const scheduleBody = z.strictObject({ ...sharedFields, endDate: isoDate.nullish() });

type SharedBody = z.infer<z.ZodObject<typeof sharedFields>>;

/** The shared fields as stored: a missing optional field reads as null, and weekdays sort ascending. */
function sharedContentOf(body: SharedBody): Omit<RuleSchedule, 'endDate'> {
  return {
    kind: body.kind,
    startDate: body.startDate,
    weekdays: body.weekdays === undefined || body.weekdays === null ? null : [...body.weekdays].sort((a, b) => a - b),
    effect: body.effect,
    expectedGuests: body.expectedGuests ?? null,
    startTime: body.startTime ?? null,
    endTime: body.endTime ?? null,
  };
}

/**
 * The rules a note and a rule's schedule share (spec 12): the start date runs from 2010-01-01 to today plus two years;
 * the end is on or after it, at most 366 days later, unless it is null (a schedule with no end); weekdays are unique;
 * expected guests is null when the effect is `closed`, except on a buyout (a private event, closed), where it is the
 * party's size; hours are both set or both null, start before end on the same day, and null on a closure.
 */
function validDays(content: RuleSchedule, today: string): boolean {
  const { startTime, endTime, endDate } = content;
  // 'HH:MM' strings order as the times do. [CONFIRM: an event with hours ends by midnight on its own day]
  const validHours = startTime === null || endTime === null
    ? startTime === endTime
    : startTime < endTime && content.kind !== 'closure';
  return content.startDate >= EARLIEST_DATE && content.startDate <= plusYears(today, 2)
    && (endDate === null || (endDate >= content.startDate && daysBetween(content.startDate, endDate) <= MAX_SPAN_DAYS))
    && (content.weekdays === null || new Set(content.weekdays).size === content.weekdays.length)
    && (content.effect !== 'closed' || content.kind === 'private_event' || content.expectedGuests === null)
    && validHours;
}

function invalid(): AppError {
  return new AppError(400, 'invalid_request', 'Invalid request');
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/**
 * Spec 12 NoteInput. A missing optional field reads as null, and an empty detail as none. The shared rules (validDays),
 * and an `other` note needs a detail. Null when any rule fails. The tuning chat validates its note proposals with this too.
 */
export function readNoteContent(raw: unknown, today: string): NoteContent | null {
  const parsed = noteBody.safeParse(raw);
  if (!parsed.success) return null;
  const body = parsed.data;
  const content: NoteContent = {
    ...sharedContentOf(body),
    endDate: body.endDate,
    detail: body.detail === undefined || body.detail === null || body.detail === '' ? null : body.detail,
  };
  return validDays(content, today) && (content.kind !== 'other' || content.detail !== null) ? content : null;
}

/**
 * A business rule's schedule (D31, spec 10.16): a note's fields and rules (validDays) but the detail, which a schedule
 * never has (an Other schedule needs none: the rule's text is its words), and an `endDate` that may be null or left out
 * for no end. Strict: any other key, a detail included, is refused. Null when any rule fails.
 */
export function readRuleSchedule(raw: unknown, today: string): RuleSchedule | null {
  const parsed = scheduleBody.safeParse(raw);
  if (!parsed.success) return null;
  const schedule: RuleSchedule = { ...sharedContentOf(parsed.data), endDate: parsed.data.endDate ?? null };
  return validDays(schedule, today) ? schedule : null;
}

/** True when the two notes say the same thing, field by field. */
export function sameNoteContent(a: NoteContent, b: NoteContent): boolean {
  return a.kind === b.kind && a.startDate === b.startDate && a.endDate === b.endDate && a.effect === b.effect
    && a.expectedGuests === b.expectedGuests && a.detail === b.detail && a.startTime === b.startTime && a.endTime === b.endTime
    && JSON.stringify(a.weekdays) === JSON.stringify(b.weekdays);
}

/** The note in a request body; 400 invalid_request when any rule fails. */
export function noteContent(raw: unknown, today: string): NoteContent {
  const content = readNoteContent(raw, today);
  if (content === null) throw invalid();
  return content;
}

function canEdit(caller: MemberPrincipal, note: NoteRecord): boolean {
  return caller.role === 'org_admin' || note.createdBy === caller.userId;
}

export function noteView(note: NoteRecord, createdByEmail: string, caller: MemberPrincipal): NoteView {
  return {
    id: note.id,
    kind: note.kind,
    startDate: note.startDate,
    endDate: note.endDate,
    weekdays: note.weekdays,
    effect: note.effect,
    expectedGuests: note.expectedGuests,
    detail: note.detail,
    startTime: note.startTime,
    endTime: note.endTime,
    createdByEmail,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    canEdit: canEdit(caller, note),
  };
}

/** Audit details for a note: never the detail text, hours or guests (spec 9.2). */
function noteDetails(locationId: string, note: NoteContent): Record<string, string> {
  return { locationId, kind: note.kind, startDate: note.startDate, endDate: note.endDate };
}

/** The note on this location, and the caller may change it: 404 before 403, so another location's note reads as absent. */
async function editableNote(ctx: TownwiseContext, caller: MemberPrincipal, locationId: string, rawId: unknown): Promise<NoteRecord> {
  const note = await ctx.stores.notes.find(caller.scope, locationId, parseInput(objectId, rawId));
  if (note === null) throw notFound();
  if (!canEdit(caller, note)) throw new AppError(403, 'forbidden', 'Forbidden');
  return note;
}

/** GET /api/org/locations/:locationId/notes, sorted by start date. */
export async function listNotes(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const notes = await ctx.stores.notes.list(caller.scope, location.id);
  const authors = [...new Set(notes.filter((note) => !note.byStaff).map((note) => note.createdBy))];
  const emails = new Map(await Promise.all(authors.map(async (userId) => [userId, await authorEmail(ctx, userId, false)] as const)));
  res.status(200).json({
    notes: notes.map((note) => noteView(note, note.byStaff ? TOWNWISE_STAFF : emails.get(note.createdBy) ?? DELETED_PERSON, caller)),
  });
}

/**
 * Adds a note to the location as the caller: the note limit (409 note_limit), the write, and `note.created`. With
 * `id` (a TownwiseAI proposal's save), a note that already holds it, made by an earlier try or a racing request, is
 * returned as it is, and only the request that wrote it records the event.
 */
export async function addNote(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, content: NoteContent, opts: { id?: string } = {},
): Promise<NoteRecord> {
  const { scope } = caller;
  const { notes } = ctx.stores;
  const { id } = opts;
  const existing = id === undefined ? null : await notes.find(scope, location.id, id);
  if (existing !== null) return existing;
  if (await notes.count(scope, location.id) >= MAX_NOTES) {
    throw new AppError(409, 'note_limit', 'This location has reached its note limit');
  }
  const now = ctx.now();
  let note: NoteRecord;
  try {
    note = await notes.create(scope, location.id, content, {
      createdBy: caller.userId, now, ...(id === undefined ? {} : { id }), ...(caller.openAsAdmin !== null ? { byStaff: true } : {}),
    });
  } catch (err) {
    const raced = id !== undefined && isDuplicateKeyError(err) ? await notes.find(scope, location.id, id) : null;
    if (raced !== null) return raced;
    throw err;
  }
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'note.created',
    target: { type: 'note', id: note.id },
    details: noteDetails(location.id, note),
  });
  return note;
}

/** POST /api/org/locations/:locationId/notes. */
export async function createNote(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const content = noteContent(req.body, utcDay(ctx.now()));
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const note = await addNote(ctx, caller, location, content);
  res.status(201).json({ note: noteView(note, note.byStaff ? TOWNWISE_STAFF : caller.email, caller) });
}

/** PATCH /api/org/locations/:locationId/notes/:noteId: a full replace, by the author or an org admin. */
export async function updateNote(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const now = ctx.now();
  const content = noteContent(req.body, utcDay(now));
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const existing = await editableNote(ctx, caller, location.id, req.params.noteId);
  const note = await ctx.stores.notes.replace(scope, location.id, existing.id, content, now);
  if (note === null) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'note.updated',
    target: { type: 'note', id: note.id },
    details: noteDetails(location.id, note),
  });
  res.status(200).json({ note: noteView(note, await authorEmail(ctx, note.createdBy, note.byStaff), caller) });
}

/** DELETE /api/org/locations/:locationId/notes/:noteId, by the author or an org admin. */
export async function deleteNote(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const note = await editableNote(ctx, caller, location.id, req.params.noteId);
  if (!(await ctx.stores.notes.remove(scope, location.id, note.id))) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'note.deleted',
    target: { type: 'note', id: note.id },
    details: noteDetails(location.id, note),
  });
  res.status(204).end();
}
