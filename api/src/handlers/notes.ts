// Notes, the tuning step (spec 10.5, 12, P14): structured notes per location for what sales can't show. The forecast
// reader and the tuning chat read them. Authors edit and delete their own; org admins edit and delete any. `detail`,
// hours and guests are never logged and never copied into an audit event.
// Make a note links the note to the owner-calendar event it came from (openspec change calendar-event-suggestions,
// design decision 2): only a keyed event of this location's calendar, read from its current events, with the stored
// row's dates and hours; an event that is gone, unkeyed or not this location's leaves the note unlinked, still saved.
// A link's uid travels only in the JSON body and the answer, never in a log line or an audit event.
import { isDuplicateKeyError, objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { daysBetween, EARLIEST_DATE, isCalendarDate, isoDate, plusYears, utcDay } from '../dates.ts';
import { authorEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import type { RuleSchedule, RuleSeason } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { MAX_LINK_UID_CHARS, type NoteContent, type NoteLink, type NoteRecord } from '../stores/notes.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** A note's link as answered: the calendar's id, the event's uid and its dates and hours when linked. No title. */
export interface NoteLinkView {
  calendarId: string; uid: string; startDate: string; endDate: string; startTime: string | null; endTime: string | null; linkedAt: string;
}

/**
 * Spec 12. `source` is `{ via: 'ai_file', fileId }` on a note TownwiseAI made from a file someone let it read (spec
 * 11A.9), else null; `fromEvent` the owner-calendar event a note was made from, else null.
 */
export interface NoteView extends NoteContent {
  id: string; createdByEmail: string; createdAt: string; updatedAt: string; canEdit: boolean;
  source: { via: 'ai_file'; fileId: string } | null;
  fromEvent: NoteLinkView | null;
}

/** Spec 6.7. [CONFIRM: 1,000 notes] */
export const MAX_NOTES = 1000;
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

/** A note never has a season (D46: seasons are for rules only). */
const noteBody = z.object({ ...sharedFields, endDate: isoDate, detail: z.string().trim().max(280).nullish(), season: z.null().optional() });

/** Make a note's event, beside the note's fields in a create body: strict, its dates never taken from the request. */
const linkBody = z.object({
  fromEvent: z.strictObject({ calendarId: objectId, uid: z.string().min(1).max(MAX_LINK_UID_CHARS) }).nullish(),
});

/** 'MM-DD': a month and a day. Whether it is a real one is checked by validSeason. */
const monthDay = z.string().regex(/^\d{2}-\d{2}$/);

/** A rule's yearly season (D46). */
const seasonBody = z.strictObject({ repeat: z.literal('yearly'), from: monthDay, to: monthDay });

/**
 * A rule's schedule: strict, with no detail (the rule's text is its words), no end when `endDate` is null or left out,
 * and a yearly season or none.
 */
const scheduleBody = z.strictObject({ ...sharedFields, endDate: isoDate.nullish(), season: seasonBody.nullish() });

/** A non-leap year, to count a season's days in. */
const SEASON_YEAR = '2027';
/** A season lasts at most this many days, counted in a non-leap year: shorter than a year. */
const MAX_SEASON_DAYS = 364;

/**
 * D46: a season's months and days are real ones, neither Feb 29, and it lasts less than a year (at most 364 days in a
 * non-leap year, `to` before `from` crossing the new year).
 */
function validSeason(season: RuleSeason): boolean {
  const from = `${SEASON_YEAR}-${season.from}`;
  const to = `${SEASON_YEAR}-${season.to}`;
  if (!isCalendarDate(from) || !isCalendarDate(to)) return false;
  const days = (daysBetween(from, to) + 365) % 365 + 1;
  return days <= MAX_SEASON_DAYS;
}

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
  const season = content.season ?? null;
  // 'HH:MM' strings order as the times do. [CONFIRM: an event with hours ends by midnight on its own day]
  const validHours = startTime === null || endTime === null
    ? startTime === endTime
    : startTime < endTime && content.kind !== 'closure';
  return content.startDate >= EARLIEST_DATE && content.startDate <= plusYears(today, 2)
    && (endDate === null || (endDate >= content.startDate && daysBetween(content.startDate, endDate) <= MAX_SPAN_DAYS))
    && (season === null || (endDate === null && validSeason(season)))
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
  const { season } = parsed.data;
  const schedule: RuleSchedule = {
    ...sharedContentOf(parsed.data), endDate: parsed.data.endDate ?? null,
    ...(season === undefined || season === null ? {} : { season: { repeat: season.repeat, from: season.from, to: season.to } }),
  };
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
    source: note.source === null ? null : { via: note.source.via, fileId: note.source.fileId },
    fromEvent: note.fromEvent === null ? null : {
      calendarId: note.fromEvent.calendarId, uid: note.fromEvent.uid, startDate: note.fromEvent.startDate, endDate: note.fromEvent.endDate,
      startTime: note.fromEvent.startTime, endTime: note.fromEvent.endTime, linkedAt: note.fromEvent.linkedAt.toISOString(),
    },
  };
}

/** Audit details for a note: never the detail text, hours or guests (spec 9.2). */
export function noteDetails(locationId: string, note: NoteContent): Record<string, string> {
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
 * returned as it is, and only the request that wrote it records the event. `fromEvent` links the note to an
 * owner-calendar event the caller has already read (linkTo).
 */
export async function addNote(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, content: NoteContent, opts: { id?: string; fromEvent?: NoteLink } = {},
): Promise<NoteRecord> {
  const { scope } = caller;
  const { notes } = ctx.stores;
  const { id, fromEvent } = opts;
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
      ...(fromEvent === undefined ? {} : { fromEvent }),
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

/**
 * The link to an owner-calendar event of this location, read from its calendar's current events under the caller's
 * scope, with the stored row's dates and hours; null when the event is gone, unkeyed, or another location's.
 */
export async function linkTo(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, event: { calendarId: string; uid: string }, now: Date,
): Promise<NoteLink | null> {
  const found = await ctx.stores.ownerCalendars.findEvent(caller.scope, location.id, event.calendarId, event.uid);
  if (found?.keyed !== true) return null;
  return {
    calendarId: event.calendarId, uid: found.uid, startDate: found.startDate, endDate: found.endDate, startTime: found.startTime,
    endTime: found.endTime, linkedAt: now,
  };
}

/** POST /api/org/locations/:locationId/notes, with Make a note's optional `fromEvent: { calendarId, uid }`. */
export async function createNote(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const content = noteContent(req.body, utcDay(ctx.now()));
  const { fromEvent: asked } = parseInput(linkBody, req.body);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const fromEvent = asked === undefined || asked === null ? null : await linkTo(ctx, caller, location, asked, ctx.now());
  const note = await addNote(ctx, caller, location, content, fromEvent === null ? {} : { fromEvent });
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
