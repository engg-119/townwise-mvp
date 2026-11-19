// A file calendar's booking labels (openspec change learn-from-calendar-bookings, D58, design decisions 7, 8, 10, 11 and
// 14): Sort with TownwiseAI, a person's label, and Use for forecasts. Only an org admin writes them (the route table's
// org_admin policy; members read the labels through the calendars list and the events read), never under view-as (the
// chain refuses the writes), and staff open as admin may label and confirm but not sort, which sends customers' names
// to Anthropic (the sort's route has no openAsAdmin, so the chain refuses it 403 open_as_admin_refused). A link or a
// Google calendar answers 409 not_a_file_calendar, and a calendar of another location or organization 404, as an
// unknown id does. An event is named by its uid in the body, never the path or query.
// Confirming, and a later label set to buyout or party on a confirmed calendar, makes a linked private-event note for
// each such event ending on or after the town's today that is keyed, linked to no note and covered by no private-event
// or closure note, as D53's accept writes one (handlers/weekly-suggestions.ts eventNote: effect closed for a buyout or
// more guests for a party, no guest count, no title or detail, the event's dates and, when Section 12 allows them, its
// hours), at most 100 a confirm, soonest first, within the location's note limit. Each such note's id comes from its
// calendar and uid, so a retry or a racing request finds the one written and makes none twice. A label set away from
// buyout or party leaves the note (`noteKept`). Confirming also starts a calibration as the admin when the lab and its
// checks allow, as a TownwiseAI file read does (files/ai-actions.ts).
// Logs carry the calendar's id and counts only, and the audit events counts and the label set; never a title, uid, an
// event's date, a label per event or anything the model answered.
import { createHash } from 'node:crypto';

import { objectId } from '@ckeith26/mongo';
import { createRateLimiter, RateLimiterUnavailableError, type RateLimiter } from '@ckeith26/rate-limit';
import { AppError, parseInput } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { MemberPrincipal, Principal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter } from '../audit.ts';
import { BOOKING_SORT_TIME_MS, bookingSortBatches, bookingSortReserveMicroUsd, runBookingSort } from '../calendar/booking-sort.ts';
import { MAX_KEY_CHARS } from '../calendar/ics.ts';
import { checkStart, launch, type StartRefusal, type StartRequest } from '../lab/service.ts';
import { coversEvent } from '../lab/suggestions.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent } from '../stores/notes.ts';
import { BOOKINGS, type Booking, type LabeledEvent, type OwnerCalendarRecord } from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { utcDay } from '../dates.ts';
import { addNote, linkTo, MAX_NOTES, readNoteContent } from './notes.ts';
import { loadLocation, memberOf } from './locations.ts';
import { ownerCalendarView, type OwnerCalendarView } from './owner-calendars.ts';
import { actorOf } from './team.ts';

/** Each calendar's sorts: 3 an hour. [CONFIRM: 3 sorts a calendar an hour] */
export const BOOKING_SORT_BUDGET = { name: 'townwise:calendar-booking-sorts', limit: 3, windowSeconds: 3600 } as const;
/** At most this many notes one confirm makes. [CONFIRM: confirming makes a linked note for each upcoming buyout or party event, at most 100 a confirm] */
export const MAX_CONFIRM_NOTES = 100;
const sortBudgets = new WeakMap<TownwiseContext['redis'], RateLimiter>();

const labelBody = z.strictObject({ uid: z.string().min(1).max(MAX_KEY_CHARS), booking: z.enum(BOOKINGS).nullable() });

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The town's today at the location. */
function todayAt(ctx: TownwiseContext, location: LocationRecord): string {
  return localDay(ctx.now(), timeZoneOf(location.town).timeZone);
}

/** This location's file calendar named by the path: 404 for any other id, 409 not_a_file_calendar for a link or Google calendar. */
async function fileCalendarOf(ctx: TownwiseContext, caller: MemberPrincipal, req: Request): Promise<{ location: LocationRecord; calendar: OwnerCalendarRecord }> {
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const calendar = await ctx.stores.ownerCalendars.find(caller.scope, location.id, parseInput(objectId, req.params.calendarId));
  if (calendar === null) throw notFound();
  if (calendar.kind !== 'file') throw new AppError(409, 'not_a_file_calendar', 'Only an imported calendar file has bookings');
  return { location, calendar };
}

/** The calendar as answered now, with its label counts. */
async function viewOf(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, calendarId: string): Promise<OwnerCalendarView> {
  const [calendar, counts] = await Promise.all([
    ctx.stores.ownerCalendars.find(caller.scope, location.id, calendarId), ctx.stores.ownerCalendars.labelCounts(caller.scope, location.id),
  ]);
  if (calendar === null) throw notFound();
  return ownerCalendarView(calendar, false, counts.get(calendar.id));
}

/** One of the calendar's 3 sorts an hour: 429 rate_limited when they are used up, 503 when the store can't count them. */
async function spendSort(ctx: TownwiseContext, calendarId: string): Promise<void> {
  let limiter = sortBudgets.get(ctx.redis);
  if (limiter === undefined) {
    limiter = createRateLimiter({ redis: ctx.redis, ...BOOKING_SORT_BUDGET });
    sortBudgets.set(ctx.redis, limiter);
  }
  let decision;
  try {
    decision = await limiter.consume(`calendar:${calendarId}`);
  } catch (err) {
    if (!(err instanceof RateLimiterUnavailableError)) throw err;
    throw new AppError(503, 'chat_unavailable', 'TownwiseAI isn’t available right now');
  }
  if (!decision.allowed) {
    throw new AppError(429, 'rate_limited', 'This calendar was sorted 3 times in the last hour', { retryAfterSeconds: decision.retryAfterSeconds });
  }
}

/** The tuning chat's month (UTC), which the sort is charged to. */
function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * POST /api/org/locations/:locationId/owner-calendars/:calendarId/bookings/sort: Sort with TownwiseAI (design decision 8).
 * After the calendar (404, 409 not_a_file_calendar): 503 chat_unavailable without a model; one of the calendar's 3
 * sorts an hour (429 rate_limited); the calendar's unlabeled events in batches (booking-sort.ts); the most every batch
 * can cost reserved from the organization's TownwiseAI month (409 chat_budget_exhausted when it can't, before any call),
 * settled to what the calls cost; the labels kept written only where no one labeled meanwhile, and the calendar marked
 * sorted. 200 { calendar, sent, labeled, batchesFailed }.
 */
export async function sortCalendarBookings(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const { location, calendar } = await fileCalendarOf(ctx, caller, req);
  const model = ctx.chat;
  if (model === null) throw new AppError(503, 'chat_unavailable', 'TownwiseAI isn’t turned on yet');
  await spendSort(ctx, calendar.id);
  const store = ctx.stores.ownerCalendars;
  const events = await store.labeledEvents(scope, location.id, calendar.id, { unlabeled: true });
  if (events === null) throw notFound();
  const batches = bookingSortBatches(events);
  const month = monthOf(ctx.now());
  const reserve = bookingSortReserveMicroUsd(batches);
  const budget = Math.round(ctx.config.chatMonthlyBudgetUsd * 1_000_000);
  if (batches.length > 0 && !(await ctx.stores.chatUsage.reserve(scope, month, reserve, budget, ctx.now()))) {
    throw new AppError(409, 'chat_budget_exhausted', 'Your organization’s TownwiseAI budget for this month is used up');
  }
  let costMicroUsd = 0;
  let outcome;
  try {
    outcome = await runBookingSort(model, batches, AbortSignal.timeout(BOOKING_SORT_TIME_MS));
    ({ costMicroUsd } = outcome);
  } finally {
    // The reservation becomes what the calls cost.
    if (batches.length > 0 && costMicroUsd !== reserve) await ctx.stores.chatUsage.add(scope, month, costMicroUsd - reserve, ctx.now());
  }
  const labeled = await store.setLabels(scope, location.id, calendar.id, outcome.labels, ctx.now());
  if (labeled === null) throw notFound();
  const sent = events.length;
  if (batches.length > 0 && outcome.batchesFailed === batches.length) {
    ctx.logger.info({ calendarId: calendar.id }, 'townwise.calendar_bookings_sort_failed');
  } else {
    ctx.logger.info({ calendarId: calendar.id, sent, labeled, batchesFailed: outcome.batchesFailed }, 'townwise.calendar_bookings_sorted');
  }
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'owner_calendar.bookings_sorted',
    target: { type: 'owner_calendar', id: calendar.id }, details: { locationId: location.id, calendarId: calendar.id, sent, labeled },
  });
  res.status(200).json({ calendar: await viewOf(ctx, caller, location, calendar.id), sent, labeled, batchesFailed: outcome.batchesFailed });
}

function isBooked(booking: Booking | null): booking is 'buyout' | 'party' {
  return booking === 'buyout' || booking === 'party';
}

/** A booking note's id, from its calendar and uid: a retry or a racing request finds the one written. */
function noteIdOf(calendarId: string, uid: string): string {
  return createHash('sha256').update(`booking-note\u0000${calendarId}\u0000${uid}`).digest('hex').slice(0, 24);
}

/** The note an upcoming booking gets, as D53's accept writes one; null when even all day the note rules refuse it. */
function bookingNote(event: LabeledEvent & { booking: 'buyout' | 'party' }, today: string): NoteContent | null {
  const base = {
    kind: 'private_event', startDate: event.startDate, endDate: event.endDate, weekdays: null,
    effect: event.booking === 'buyout' ? 'closed' : 'more_guests', expectedGuests: null, detail: null, title: null,
  };
  return readNoteContent({ ...base, startTime: event.startTime, endTime: event.endTime }, today)
    ?? readNoteContent({ ...base, startTime: null, endTime: null }, today);
}

/**
 * Notes for the upcoming buyouts and parties among `events` that need one (keyed, ending today or later, linked to no
 * note, covered by no private-event or closure note), soonest first, at most `limit` and within the note limit. Resolves
 * how many were made and how many still need one.
 */
async function noteBookings(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, calendarId: string, events: readonly LabeledEvent[], limit: number,
): Promise<{ made: number; left: number }> {
  const today = todayAt(ctx, location);
  const notes = await ctx.stores.notes.list(caller.scope, location.id);
  const linked = new Set(notes.flatMap((note) => (note.fromEvent?.calendarId === calendarId ? [note.fromEvent.uid] : [])));
  const due = events.filter((event): event is LabeledEvent & { booking: 'buyout' | 'party' } => isBooked(event.booking)
    && event.keyed && event.endDate >= today && !linked.has(event.uid)
    && !notes.some((note) => coversEvent(note, event)))
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  let made = 0;
  let count = notes.length;
  for (const event of due.slice(0, limit)) {
    if (count >= MAX_NOTES) break;
    const content = bookingNote(event, utcDay(ctx.now()));
    const link = content === null ? null : await linkTo(ctx, caller, location, { calendarId, uid: event.uid }, ctx.now());
    if (content === null || link === null) continue;
    await addNote(ctx, caller, location, content, { id: noteIdOf(calendarId, event.uid), fromEvent: link });
    made += 1;
    count += 1;
  }
  return { made, left: due.length - made };
}

/**
 * PATCH /api/org/locations/:locationId/owner-calendars/:calendarId/bookings { uid, booking }: a person's label (null
 * clears it; the sort still leaves it), audited with the label only. On a confirmed calendar an upcoming event set to
 * buyout or party gets its note (`noteMade`), and one moved off a label with a linked note keeps it (`noteKept`). 404 for
 * an unknown uid. 200 { calendar, noteMade, noteKept }.
 */
export async function labelCalendarBooking(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(labelBody, req.body);
  const { location, calendar } = await fileCalendarOf(ctx, caller, req);
  const before = await ctx.stores.ownerCalendars.setLabel(scope, location.id, calendar.id, body.uid, body.booking, ctx.now());
  if (before === null) throw notFound();
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'owner_calendar.booking_labeled',
    target: { type: 'owner_calendar', id: calendar.id }, details: { locationId: location.id, calendarId: calendar.id, booking: body.booking ?? 'none' },
  });
  let noteMade = false;
  let noteKept = false;
  if (calendar.bookings?.state === 'confirmed' && before.endDate >= todayAt(ctx, location) && body.booking !== before.booking) {
    noteMade = isBooked(body.booking)
      && (await noteBookings(ctx, caller, location, calendar.id, [{ ...before, booking: body.booking, bookingBy: 'person' }], 1)).made === 1;
    noteKept = !noteMade && (await ctx.stores.notes.linkedTo(scope, location.id, calendar.id)).some((note) => note.fromEvent?.uid === before.uid);
  }
  res.status(200).json({ calendar: await viewOf(ctx, caller, location, calendar.id), noteMade, noteKept });
}

/** What a confirm's calibration did: started, or why not (a StartRefusal, or the organization not active). */
type ConfirmCalibration = { status: 'started'; id: string } | { status: StartRefusal | 'org_not_active'; id: null };

/** A calibration as the confirming admin (staff open as admin start it as staff), through the lab's own checks. */
async function calibrateAfterConfirm(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord): Promise<ConfirmCalibration> {
  const { scope } = caller;
  if ((await ctx.stores.orgs.findById(scope.orgId))?.status !== 'active') return { status: 'org_not_active', id: null };
  const request: StartRequest = {
    id: new Types.ObjectId().toHexString(), scope, location,
    requester: { userId: caller.userId, role: caller.openAsAdmin === null ? 'org_admin' : 'superadmin', via: 'file' },
    regimeStart: null, today: todayAt(ctx, location),
  };
  const refusal = await checkStart(ctx, request);
  if (refusal !== null) return { status: refusal, id: null };
  const launched = await launch(ctx, request);
  if (launched.ok || launched.code === 'start_failed') {
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'calibration.requested', target: { type: 'calibration', id: request.id },
      details: { locationId: location.id, calibrationId: request.id, via: 'file', hasRegime: false },
    });
  }
  return launched.ok ? { status: 'started', id: launched.calibration.id } : { status: launched.code, id: null };
}

/**
 * POST /api/org/locations/:locationId/owner-calendars/:calendarId/bookings/confirm, Use for forecasts: the calendar's
 * bookings confirmed by compare-and-set (a second press finds them confirmed and still makes any note missing), the
 * upcoming bookings' notes (at most 100), and, when this press confirmed them, a calibration as the admin (null when it
 * did not try). Audited with counts only. 200 { calendar, notesMade, notesLeft, calibration }.
 */
export async function confirmCalendarBookings(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const { location, calendar } = await fileCalendarOf(ctx, caller, req);
  const store = ctx.stores.ownerCalendars;
  const confirmed = await store.confirmBookings(scope, location.id, calendar.id, { by: caller.userId, now: ctx.now() });
  if (confirmed === null) throw notFound();
  const events = await store.labeledEvents(scope, location.id, calendar.id);
  if (events === null) throw notFound();
  const notes = await noteBookings(ctx, caller, location, calendar.id, events, MAX_CONFIRM_NOTES);
  const calibration = confirmed === 'confirmed' ? await calibrateAfterConfirm(ctx, caller, location) : null;
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'owner_calendar.bookings_confirmed',
    target: { type: 'owner_calendar', id: calendar.id },
    details: {
      locationId: location.id, calendarId: calendar.id, buyouts: events.filter((event) => event.booking === 'buyout').length,
      parties: events.filter((event) => event.booking === 'party').length, notes: notes.made,
    },
  });
  res.status(200).json({
    calendar: await viewOf(ctx, caller, location, calendar.id), notesMade: notes.made, notesLeft: notes.left, calibration,
  });
}
