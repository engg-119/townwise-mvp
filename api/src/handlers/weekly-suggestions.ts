// TownwiseAI's weekly suggestions (openspec change weekly-forecast-suggestions, spec 10.12, P25): the org admin's
// switches (weekly suggestions, and sending the calendars' event titles, calendar-event-suggestions), and accepting or dismissing a suggestion the weekly pass made (lab/suggestions.ts). Suggestions are listed by
// GET .../agent (handlers/agent.ts) through suggestionsPanel below.
//
// Accepting writes the note or the business rule through the notes and rules code, as written by that admin, with the
// suggestion's id as the note's or rule's id, then marks the suggestion accepted by compare-and-set. There are no
// transactions, so a retry, a crash between the steps or a second tab end with one note or rule, and only the request
// whose compare-and-set lands records `agent.suggestion_accepted`. A dismiss racing an accept that already wrote its
// note loses to it: the note exists, so the dismiss finishes the accept instead (an accept that died between its two
// steps included). A suggestion whose first date is today or past in the town is gone (404), as an
// unknown id or another organization's is. Only org admins decide, outside view-as (staff open as admin among them, D25);
// members read.
// Logs and audit events carry ids, the type and the switch's state only.
//
// Three kinds came with owner-calendar events (openspec change calendar-event-suggestions, design decisions 4, 5 and
// 10): `event`, a private event the weekly pass spotted, and the follow-ups `move` and `remove` of a note linked to an
// event that moved or went. Their words are written here at read time, never by the model and never stored: a follow-up
// reads from its note's kind and dates only, and a spotted event names its title from the live event row, which staff
// (under view-as or open as admin) read as "Google calendar event" when its calendar is a Google one, as on the
// Calendar. The panel neither lists nor counts one whose calendar is gone, a follow-up whose note is gone, or a spotted
// event no longer at its dates or stale (another note linked to it, or a private-event or closure note over its days),
// and accepting one whose calendar or (a `move`) note is gone answers 404 and expires it. Accepting a follow-up is a
// compare-and-set on the note's updatedAt as the follow-up recorded it (409 note_changed when it differs, the
// suggestion left open), after reading the suggestion again (409 note_changed when a refresh rewrote it since the accept
// read it), and it is marked accepted only while its last write is the one read, or from expired when the accept's own
// note write landed; a spotted event is read again (409 event_changed and expired when it moved, went or is stale) and
// written as a private-event note with the suggestion's id, linked to the event, with no detail.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { applyRecorded, recordAfter, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { clockWords, scheduleSummary } from '../forecasts/reasons.ts';
import { authorEmail } from '../people.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { SuggestionRecord } from '../stores/agent-suggestions.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent, NoteDates, NoteRecord } from '../stores/notes.ts';
import type { OwnerCalendarRecord, StoredEvent } from '../stores/owner-calendars.ts';
import { SUGGESTIONS_SEEN_MS } from '../lab/schedule.ts';
import { coversEvent } from '../lab/suggestions.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { townEvents } from '../town-calendar.ts';
import { utcDay } from '../dates.ts';
import { GOOGLE_EVENT_TITLE } from './google-calendars.ts';
import { loadLocation } from './locations.ts';
import { addNote, linkTo, noteDetails, noteView, readNoteContent, type NoteView } from './notes.ts';
import { staffReads } from './owner-calendars.ts';
import { addRule, ruleView, type RuleView } from './rules.ts';
import { actorOf, assertOpenAsAdminTab, orgAdmin } from './team.ts';

/** `orgId`, the organization the page shows, is required in open as admin (D25), as renaming the organization's is. */
const switchBody = z.strictObject({ on: z.boolean(), orgId: objectId.optional() });
/** Accept and dismiss carry nothing, but accepting a spotted event. */
const decideBody = z.strictObject({});
/** Accepting a spotted event: the whole restaurant (a buyout) or alongside regular service, and the guest count. */
const eventBody = z.strictObject({
  effect: z.enum(['closed', 'more_guests']), expectedGuests: z.number().int().min(1).max(20_000).nullable(),
});

/** A calendar entry a suggestion rests on, as the panel names it: public data only. */
export interface SuggestionCalendarView { id: string; title: string; start: string; end: string }

/**
 * A spotted owner-calendar event as its card names it, read from the live event row: its title, or "Google calendar
 * event" to staff when its calendar is a Google one (`titleHidden`). Its dates and hours are the event's.
 */
export interface SuggestionEventView extends NoteDates {
  calendarId: string; title: string; titleHidden: boolean;
}

/**
 * A suggestion as the panel shows it (open, its first date after today in the town). `why` is TownwiseAI's on a note
 * or rule; on the owner-calendar kinds it is null, and `words` is the card's sentence, written here.
 */
export type SuggestionView = {
  id: string; calendar: SuggestionCalendarView[]; createdAt: string;
} & (
  | { type: 'note'; why: string; note: NoteContent }
  | { type: 'rule'; why: string; text: string; schedule: RuleSchedule; scheduleSummary: string }
  /** `note` is the note accepting writes: a private event with effect `unknown` and the guest count to prefill. */
  | { type: 'event'; why: null; words: string; note: NoteContent; event: SuggestionEventView }
  /** `from` is the note's dates and hours now; `note` is the note as accepting leaves it. */
  | { type: 'move'; why: null; words: string; noteId: string; note: NoteContent; from: NoteDates }
  /** `note` is the note accepting deletes. */
  | { type: 'remove'; why: null; words: string; noteId: string; note: NoteContent }
);

/** Whether weekly suggestions run for the organization, whether they can run at all here, and whether the caller decides. */
export interface WeeklySuggestionsView {
  /** The organization's switch: on unless an org admin turned it off. */
  on: boolean;
  /**
   * Passes run here: TOWNWISE_WEEKLY_SUGGESTIONS is true, the weekly worker ran them within the last 3 hours (the
   * schedule document's `suggestionsAt`, which only a worker with its own ANTHROPIC_API_KEY sets), and staff have not
   * paused it.
   */
  available: boolean;
  /** An org admin outside view-as: turns the switch and accepts or dismisses suggestions. */
  canChange: boolean;
  /**
   * Whether the weekly call also reads the location calendars' event titles, dates and hours to spot private events
   * (calendar-event-suggestions): on unless an org admin turned it off.
   */
  calendarTitles: boolean;
}

export interface DecideResult {
  suggestion: { id: string; status: 'accepted' | 'dismissed' };
  /** The note or rule an accepted suggestion wrote, or null (dismissed, or deleted since). */
  note: NoteView | null;
  rule: RuleView | null;
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** An org admin outside view-as (staff open as admin borrow the org admin role, D25). */
export function decides(caller: MemberPrincipal): boolean {
  return caller.role === 'org_admin' && caller.viewAs === null;
}

/** The calendar entries the views name, by id: the town's, from a year back to 400 days on. */
function calendarById(location: LocationRecord, today: string): Map<string, SuggestionCalendarView> {
  const at = (days: number): string => utcDay(new Date(`${today}T00:00:00.000Z`), days);
  return new Map(townEvents(location.town.townId, { from: at(-366), to: at(400) })
    .map((event) => [event.id, { id: event.id, title: event.title, start: event.start, end: event.end }]));
}

type EventRecord = Extract<SuggestionRecord, { type: 'event' }>;
type FollowRecord = Extract<SuggestionRecord, { type: 'move' | 'remove' }>;

/** What a card of an owner-calendar kind rests on, read for the panel: the location's calendars, notes and events. */
interface Footing {
  readonly calendars: ReadonlyMap<string, OwnerCalendarRecord>;
  /** A follow-up's note by its id, or null when it is gone. */
  readonly notes: ReadonlyMap<string, NoteRecord | null>;
  /** A spotted event's live row by the suggestion's id, or null when it is gone. */
  readonly events: ReadonlyMap<string, StoredEvent | null>;
  /** The location's notes, read only when a spotted event is open (spotStale). */
  readonly spotNotes: readonly NoteRecord[];
}

/**
 * A spotted event is stale once a note other than its own is linked to the same event, or a private-event or closure
 * note covers its dates (lab/suggestions.ts coversEvent, as the pass checks before spotting it).
 */
function spotStale(record: EventRecord, notes: readonly NoteRecord[]): boolean {
  const { event } = record;
  return notes.some((note) => note.id !== record.id
    && ((note.fromEvent !== null && note.fromEvent.calendarId === event.calendarId && note.fromEvent.uid === event.uid) || coversEvent(note, event)));
}

const NOTE_NOUN: Readonly<Record<NoteContent['kind'], string>> = {
  closure: 'closure', private_event: 'private event', opening: 'opening', other: 'note',
};

/** "Sat, Dec 5", in the town's calendar (the date is already local). */
function dayWords(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Sat, Dec 5" or "Fri, Dec 4 to Sun, Dec 6", then ", 6 pm to 9 pm" when `hours` and the dates have hours. */
function datesWords(dates: NoteDates, hours: boolean): string {
  const days = dates.endDate === dates.startDate ? dayWords(dates.startDate) : `${dayWords(dates.startDate)} to ${dayWords(dates.endDate)}`;
  const { startTime, endTime } = dates;
  return hours && startTime !== null && endTime !== null ? `${days}, ${clockWords(startTime)} to ${clockWords(endTime)}` : days;
}

function datesOf(dates: NoteDates): NoteDates {
  return { startDate: dates.startDate, endDate: dates.endDate, startTime: dates.startTime, endTime: dates.endTime };
}

function sameDates(a: NoteDates, b: NoteDates): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate && a.startTime === b.startTime && a.endTime === b.endTime;
}

/** A follow-up's words, from its note's kind and dates only: never a title. Hours show when the move changed them. */
function followWords(record: FollowRecord, from: NoteDates): string {
  const what = `The ${NOTE_NOUN[record.note.kind]}`;
  if (record.type === 'remove') return `${what} on ${datesWords(from, false)} is no longer on your calendar.`;
  const hours = from.startTime !== record.note.startTime || from.endTime !== record.note.endTime;
  return `${what} on ${datesWords(from, hours)} moved to ${datesWords(record.note, hours)} on your calendar.`;
}

/**
 * A spotted event as the caller may read it: to staff under view-as or open as admin, a Google calendar's event is
 * "Google calendar event", with a word to ask the organization (design decision 10).
 */
function eventView(caller: MemberPrincipal, record: EventRecord, calendar: OwnerCalendarRecord, live: StoredEvent): SuggestionView {
  const hidden = staffReads(caller) && calendar.kind === 'google';
  const event: SuggestionEventView = { calendarId: calendar.id, title: hidden ? GOOGLE_EVENT_TITLE : live.title, titleHidden: hidden, ...datesOf(live) };
  const words = `From your calendar: ${event.title}, ${datesWords(live, true)}${hidden ? '. Ask your client’s team what this event is.' : ''}`;
  return { id: record.id, calendar: [], createdAt: record.createdAt.toISOString(), type: 'event', why: null, words, note: record.note, event };
}

/** The note a follow-up's words read: the note's dates and hours as it holds them now. */
function followView(record: FollowRecord, note: NoteRecord): SuggestionView {
  const from = datesOf(note);
  const shared = { id: record.id, calendar: [], createdAt: record.createdAt.toISOString(), why: null, words: followWords(record, from), noteId: note.id };
  return record.type === 'move'
    ? { ...shared, type: 'move', note: record.note, from }
    : { ...shared, type: 'remove', note: record.note };
}

/** The panel's view of a suggestion, or null when what it rests on is gone (it is then neither listed nor counted). */
function suggestionView(
  caller: MemberPrincipal, record: SuggestionRecord, calendar: ReadonlyMap<string, SuggestionCalendarView>, footing: Footing,
): SuggestionView | null {
  if (record.type === 'event') {
    const source = footing.calendars.get(record.event.calendarId);
    const live = footing.events.get(record.id) ?? null;
    if (source === undefined || live === null || !sameDates(live, record.event) || spotStale(record, footing.spotNotes)) return null;
    return eventView(caller, record, source, live);
  }
  if (record.type === 'move' || record.type === 'remove') {
    const note = footing.notes.get(record.follow.noteId) ?? null;
    return !footing.calendars.has(record.follow.calendarId) || note === null ? null : followView(record, note);
  }
  const shared = {
    id: record.id, why: record.why ?? '', createdAt: record.createdAt.toISOString(),
    calendar: record.calendarIds.flatMap((id) => {
      const entry = calendar.get(id);
      return entry === undefined ? [] : [entry];
    }),
  };
  return record.type === 'note'
    ? { ...shared, type: 'note', note: record.note }
    : { ...shared, type: 'rule', text: record.text, schedule: record.schedule, scheduleSummary: scheduleSummary(record.schedule) };
}

/** What the owner-calendar kinds among `records` rest on: the location's calendars, their follow-ups' notes and live events. */
async function footingOf(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, records: readonly SuggestionRecord[]): Promise<Footing> {
  const { scope } = caller;
  const follows = records.filter((record): record is FollowRecord => record.type === 'move' || record.type === 'remove');
  const spotted = records.filter((record): record is EventRecord => record.type === 'event');
  if (follows.length === 0 && spotted.length === 0) return { calendars: new Map(), notes: new Map(), events: new Map(), spotNotes: [] };
  const [calendars, notes, events, spotNotes] = await Promise.all([
    ctx.stores.ownerCalendars.list(scope, location.id),
    Promise.all([...new Set(follows.map((record) => record.follow.noteId))].map(async (noteId) => [noteId, await ctx.stores.notes.find(scope, location.id, noteId)] as const)),
    Promise.all(spotted.map(async (record) => [
      record.id, await ctx.stores.ownerCalendars.findEvent(scope, location.id, record.event.calendarId, record.event.uid),
    ] as const)),
    spotted.length === 0 ? Promise.resolve([]) : ctx.stores.notes.list(scope, location.id),
  ]);
  return { calendars: new Map(calendars.map((each) => [each.id, each])), notes: new Map(notes), events: new Map(events), spotNotes };
}

/** The town's today for a location. */
function todayAt(ctx: TownwiseContext, location: LocationRecord): string {
  return localDay(ctx.now(), timeZoneOf(location.town).timeZone);
}

/** GET .../agent's suggestions part: the open suggestions whose first date is after today, and the switch. */
export async function suggestionsPanel(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord,
): Promise<{ suggestions: SuggestionView[]; weeklySuggestions: WeeklySuggestionsView }> {
  const today = todayAt(ctx, location);
  const [org, open, worker] = await Promise.all([
    ctx.stores.orgs.findById(caller.scope.orgId),
    ctx.stores.agentSuggestions.listOpen(caller.scope, location.id, today),
    ctx.stores.forecastSchedule.suggestionsState(),
  ]);
  const seen = worker.ranAt !== null && ctx.now().getTime() - worker.ranAt.getTime() <= SUGGESTIONS_SEEN_MS;
  const calendar = calendarById(location, today);
  const footing = await footingOf(ctx, caller, location, open);
  return {
    suggestions: open.flatMap((record) => suggestionView(caller, record, calendar, footing) ?? []),
    weeklySuggestions: {
      on: org?.weeklySuggestions.on ?? true,
      available: ctx.config.weeklySuggestions && seen && !worker.paused,
      canChange: decides(caller),
      calendarTitles: org?.calendarTitlesToAi.on ?? true,
    },
  };
}

/**
 * PATCH /api/org/weekly-suggestions { on, orgId? } (org admin, outside view-as): 200 { weeklySuggestions }. A
 * change records `org.weekly_suggestions_changed` before it is applied; the same state again writes nothing. In open as
 * admin a missing or other `orgId` answers 409 open_as_admin_active (assertOpenAsAdminTab).
 */
export async function switchWeeklySuggestions(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const { on } = parseInput(switchBody, req.body);
  assertOpenAsAdminTab(admin, req.body);
  const org = await ctx.stores.orgs.findById(scope.orgId);
  // Only a deletion racing this request gets here; the client re-reads /api/me.
  if (org === null) throw new AppError(403, 'no_access', 'No access');
  if (org.weeklySuggestions.on !== on) {
    const now = ctx.now();
    const event: AuditEventInput = {
      ...actorOf(admin), at: now, orgId: scope.orgId, action: 'org.weekly_suggestions_changed', target: { type: 'org', id: scope.orgId },
      details: { on },
    };
    const eventId = await recordBefore(ctx, event);
    if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.orgs.setWeeklySuggestions(scope, { on, at: now, by: admin.userId })))) {
      await recordNotApplied(ctx, event, eventId, 'not_found');
      throw new AppError(403, 'no_access', 'No access');
    }
  }
  ctx.logger.info({ orgId: scope.orgId, on }, 'townwise.weekly_suggestions_switched');
  res.status(200).json({ weeklySuggestions: { on } });
}

/**
 * PATCH /api/org/weekly-suggestions/calendar-titles { on, orgId? } (org admin, outside view-as): 200 { calendarTitles:
 * { on } }. A change records `org.calendar_titles_ai_changed` before it is applied; the same state again writes nothing.
 * Turning it on is the organization's consent to sending its customers' names to Anthropic, so staff open as admin may
 * turn it off only: `on: true` answers them 403 open_as_admin_refused (owner, 2026-11-17). In open as admin a missing or
 * other `orgId` answers 409 open_as_admin_active.
 */
export async function switchCalendarTitles(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const { on } = parseInput(switchBody, req.body);
  assertOpenAsAdminTab(admin, req.body);
  if (on && admin.openAsAdmin !== null) throw new AppError(403, 'open_as_admin_refused', 'Only the organization’s own admin can turn this on');
  const org = await ctx.stores.orgs.findById(scope.orgId);
  // Only a deletion racing this request gets here; the client re-reads /api/me.
  if (org === null) throw new AppError(403, 'no_access', 'No access');
  if (org.calendarTitlesToAi.on !== on) {
    const now = ctx.now();
    const event: AuditEventInput = {
      ...actorOf(admin), at: now, orgId: scope.orgId, action: 'org.calendar_titles_ai_changed', target: { type: 'org', id: scope.orgId },
      details: { on },
    };
    const eventId = await recordBefore(ctx, event);
    if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.orgs.setCalendarTitlesToAi(scope, { on, at: now, by: admin.userId })))) {
      await recordNotApplied(ctx, event, eventId, 'not_found');
      throw new AppError(403, 'no_access', 'No access');
    }
  }
  ctx.logger.info({ orgId: scope.orgId, on }, 'townwise.calendar_titles_switched');
  res.status(200).json({ calendarTitles: { on } });
}

/** A follow-up's note is where its accepted move put it: the move's dates, the link's new ones, changed since the snapshot. */
function moveLanded(record: Extract<SuggestionRecord, { type: 'move' }>, note: NoteRecord): boolean {
  const { follow } = record;
  return follow.to !== null && note.fromEvent !== null && sameDates(note, record.note) && sameDates(note.fromEvent, follow.to)
    && note.updatedAt.getTime() > follow.noteUpdatedAt.getTime();
}

/** The calendar an owner-calendar kind rests on is gone, or (a `move` or `remove`) its note is. False for a note or a rule. */
async function footingGone(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: SuggestionRecord): Promise<boolean> {
  const { scope } = caller;
  if (record.type === 'note' || record.type === 'rule') return false;
  const calendarId = record.type === 'event' ? record.event.calendarId : record.follow.calendarId;
  if ((await ctx.stores.ownerCalendars.find(scope, location.id, calendarId)) === null) return true;
  return record.type !== 'event' && (await ctx.stores.notes.find(scope, location.id, record.follow.noteId)) === null;
}

/** Whether what an accept writes for this suggestion exists: the note or rule with its id, or a follow-up's move. */
async function wasWritten(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: SuggestionRecord): Promise<boolean> {
  const { scope } = caller;
  if (record.type === 'rule') return (await ctx.stores.businessRules.find(scope, location.id, record.id)) !== null;
  if (record.type === 'note' || record.type === 'event') return (await ctx.stores.notes.find(scope, location.id, record.id)) !== null;
  if (record.type === 'remove') return false;
  const note = await ctx.stores.notes.find(scope, location.id, record.follow.noteId);
  return note !== null && moveLanded(record, note);
}

/**
 * Marks it accepted by compare-and-set (`cas` as the store's markAccepted takes it); only the request whose
 * compare-and-set lands records `agent.suggestion_accepted`. True when it landed.
 */
async function markAccepted(
  ctx: TownwiseContext, admin: MemberPrincipal, location: LocationRecord, record: SuggestionRecord, cas: { updatedAt?: Date; orExpired?: boolean } = {},
): Promise<boolean> {
  const { scope } = admin;
  if (!(await ctx.stores.agentSuggestions.markAccepted(scope, location.id, record.id, { by: admin.userId, now: ctx.now(), ...cas }))) return false;
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'agent.suggestion_accepted',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, suggestionId: record.id, type: record.type },
  });
  return true;
}

/**
 * The note or rule an accepted suggestion wrote, as the caller sees it; null when it was deleted since. A `move` answers
 * its note, a `remove` nothing.
 */
async function writtenView(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: SuggestionRecord,
): Promise<Pick<DecideResult, 'note' | 'rule'>> {
  const { scope } = caller;
  if (record.type === 'rule') {
    const rule = await ctx.stores.businessRules.find(scope, location.id, record.id);
    return { note: null, rule: rule === null ? null : ruleView(rule, await authorEmail(ctx, rule.createdBy, rule.byStaff), caller) };
  }
  if (record.type === 'remove') return { note: null, rule: null };
  const note = await ctx.stores.notes.find(scope, location.id, record.type === 'move' ? record.follow.noteId : record.id);
  return { note: note === null ? null : noteView(note, await authorEmail(ctx, note.createdBy, note.byStaff), caller), rule: null };
}

/** The suggestion named by the path, of this location; 404 for anything else. */
async function suggestionOf(ctx: TownwiseContext, caller: MemberPrincipal, req: Request): Promise<{ location: LocationRecord; record: SuggestionRecord }> {
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const id = parseInput(objectId, req.params.suggestionId);
  const record = await ctx.stores.agentSuggestions.find(caller.scope, location.id, id);
  if (record === null) throw notFound();
  return { location, record };
}

/** Open, and its first date is still after today in the town. */
function isOpen(ctx: TownwiseContext, location: LocationRecord, record: SuggestionRecord): boolean {
  return record.status === 'open' && record.firstDate > todayAt(ctx, location);
}

function noteChanged(): AppError {
  return new AppError(409, 'note_changed', 'The note changed since this was suggested');
}

/** What it rests on is gone: it expires, and the request answers 404 as for an unknown id. */
async function expired(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, record: SuggestionRecord): Promise<AppError> {
  await ctx.stores.agentSuggestions.markExpired(caller.scope, location.id, record.id, ctx.now());
  return notFound();
}

/**
 * The note a spotted event's accept writes: a private event on the event's dates, with its hours when Section 12 allows
 * them (else all day), every day, no detail (never a title), and the admin's effect and count. Null when even all day
 * the note rules refuse it.
 */
function eventNote(event: NoteDates, choice: z.infer<typeof eventBody>, today: string): NoteContent | null {
  const base = {
    kind: 'private_event', startDate: event.startDate, endDate: event.endDate, weekdays: null, effect: choice.effect,
    expectedGuests: choice.expectedGuests, detail: null,
  };
  return readNoteContent({ ...base, startTime: event.startTime, endTime: event.endTime }, today)
    ?? readNoteContent({ ...base, startTime: null, endTime: null }, today);
}

/**
 * Accepting a spotted event { effect, expectedGuests }: alongside regular service needs a count (400 invalid_request).
 * Its calendar gone answers 404 and expires it; the event gone or at other dates, or stale (spotStale: another note is
 * linked to it or covers its days), 409 event_changed and expires it. Otherwise the note is written with the
 * suggestion's id and linked to the event, so a retry finds the one written.
 */
async function acceptEvent(ctx: TownwiseContext, admin: MemberPrincipal, location: LocationRecord, record: EventRecord, choice: z.infer<typeof eventBody>): Promise<void> {
  const { scope } = admin;
  if (choice.effect === 'more_guests' && choice.expectedGuests === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  if ((await ctx.stores.notes.find(scope, location.id, record.id)) === null) {
    if ((await ctx.stores.ownerCalendars.find(scope, location.id, record.event.calendarId)) === null) throw await expired(ctx, admin, location, record);
    const { event } = record;
    const [link, overlapping, linked] = await Promise.all([
      linkTo(ctx, admin, location, { calendarId: event.calendarId, uid: event.uid }, ctx.now()),
      ctx.stores.notes.overlapping(scope, location.id, { from: event.startDate, to: event.endDate }),
      ctx.stores.notes.linkedTo(scope, location.id, event.calendarId),
    ]);
    const content = link === null || !sameDates(link, event) ? null : eventNote(link, choice, utcDay(ctx.now()));
    if (link === null || content === null || spotStale(record, [...overlapping, ...linked])) {
      await ctx.stores.agentSuggestions.markExpired(scope, location.id, record.id, ctx.now());
      throw new AppError(409, 'event_changed', 'The event changed on your calendar');
    }
    await addNote(ctx, admin, location, content, { id: record.id, fromEvent: link });
  }
  await markAccepted(ctx, admin, location, record);
}

/**
 * Accepting a follow-up, by compare-and-set on the note's updatedAt as the follow-up recorded it: a `move` sets only
 * the note's dates and hours and its link's (recording `note.updated`), a `remove` deletes it (recording `note.deleted`).
 * A changed note answers 409 note_changed, the suggestion left open; a retry after the accept's own write is accepted
 * with no second note event. Its calendar gone, or a move's note gone, answers 404 and expires it. The suggestion is
 * read again right before the note write, and marked accepted only while its last write is the one this accept read
 * (or, when this accept's own write landed, from expired too): a follow-up a refresh rewrote meanwhile answers 409
 * note_changed, so no move or removal is accepted under a choice the admin did not see.
 */
async function acceptFollow(ctx: TownwiseContext, admin: MemberPrincipal, location: LocationRecord, record: FollowRecord): Promise<void> {
  const { scope } = admin;
  const { follow } = record;
  if ((await ctx.stores.ownerCalendars.find(scope, location.id, follow.calendarId)) === null) throw await expired(ctx, admin, location, record);
  const fresh = await ctx.stores.agentSuggestions.find(scope, location.id, record.id);
  if (fresh === null) throw notFound();
  if (fresh.updatedAt.getTime() !== record.updatedAt.getTime()) throw noteChanged();
  /** This accept's own note write landed (or, a move, the note is already at its target). */
  let own = true;
  const noteEvent = (action: 'note.updated' | 'note.deleted', note: NoteContent) => recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action, target: { type: 'note', id: follow.noteId }, details: noteDetails(location.id, note),
  });
  if (record.type === 'move') {
    const moved = follow.to === null ? null : await ctx.stores.notes.moveIf(scope, location.id, follow.noteId, {
      updatedAt: follow.noteUpdatedAt, dates: datesOf(record.note), link: follow.to, now: ctx.now(),
    });
    if (moved !== null) await noteEvent('note.updated', moved);
    else {
      const note = await ctx.stores.notes.find(scope, location.id, follow.noteId);
      if (note === null) throw await expired(ctx, admin, location, record);
      if (!moveLanded(record, note)) throw noteChanged();
    }
  } else if (await ctx.stores.notes.removeIf(scope, location.id, follow.noteId, follow.noteUpdatedAt)) {
    await noteEvent('note.deleted', record.note);
  } else if ((await ctx.stores.notes.find(scope, location.id, follow.noteId)) !== null) {
    throw noteChanged();
  } else {
    // The note is already gone: a retry after this accept's own delete, or someone else's.
    own = false;
  }
  if (await markAccepted(ctx, admin, location, record, { updatedAt: record.updatedAt, orExpired: own })) return;
  // Not marked: another accept got there first (fine), or a refresh rewrote it after the write (409).
  if ((await ctx.stores.agentSuggestions.find(scope, location.id, record.id))?.status !== 'accepted') throw noteChanged();
}

/**
 * POST /api/org/locations/:locationId/agent/suggestions/:suggestionId/accept (org admin): 200 DecideResult. The body is
 * {} but for a spotted event, { effect: 'closed' | 'more_guests', expectedGuests: 1 to 20,000 | null }. An accepted one
 * answers what it wrote; a dismissed or expired one, or an unknown id, 404. The note limit (409 note_limit), the rule
 * limit (409 rule_limit) and a rule already saved in other case (409 rule_exists) leave it open, as 409 note_changed
 * does; 409 event_changed and a 404 for a calendar or note gone expire it.
 */
export async function acceptSuggestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const { location, record } = await suggestionOf(ctx, admin, req);
  const choice = record.type === 'event' ? parseInput(eventBody, req.body) : null;
  if (record.type !== 'event') parseInput(decideBody, req.body);
  if (record.status !== 'accepted') {
    if (!isOpen(ctx, location, record)) throw notFound();
    if (record.type === 'event') {
      if (choice !== null) await acceptEvent(ctx, admin, location, record, choice);
    } else if (record.type === 'move' || record.type === 'remove') {
      await acceptFollow(ctx, admin, location, record);
    } else {
      // The note or rule takes the suggestion's id, so a retry or a second tab finds the one already written.
      if (record.type === 'note') await addNote(ctx, admin, location, record.note, { id: record.id });
      else await addRule(ctx, admin, location, record.text, { id: record.id, via: 'townwise_ai', schedule: record.schedule });
      await markAccepted(ctx, admin, location, record);
    }
  }
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, suggestionId: record.id, decision: 'accepted' }, 'townwise.agent_suggestion');
  const body: DecideResult = { suggestion: { id: record.id, status: 'accepted' }, ...await writtenView(ctx, admin, location, record) };
  res.status(200).json(body);
}

/**
 * POST /api/org/locations/:locationId/agent/suggestions/:suggestionId/dismiss {} (org admin): 200 DecideResult. One
 * an accept got to first answers as accepted, with what it wrote: also one whose note or rule an accept wrote without
 * reaching its compare-and-set (it died, or a store error answered 500), which this finishes accepting, recording
 * `agent.suggestion_accepted`. An expired one or an unknown id, 404; so is one whose calendar or (a follow-up) note is
 * gone, which this expires.
 */
export async function dismissSuggestion(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  parseInput(decideBody, req.body);
  const { location, record } = await suggestionOf(ctx, admin, req);
  if (record.status === 'open' && !isOpen(ctx, location, record)) throw notFound();
  if (record.status === 'expired') throw notFound();
  if (record.status === 'open' && await footingGone(ctx, admin, location, record)) throw await expired(ctx, admin, location, record);
  if (record.status !== 'accepted' && await wasWritten(ctx, admin, location, record)) await markAccepted(ctx, admin, location, record);
  else if (await ctx.stores.agentSuggestions.markDismissed(scope, location.id, record.id, { by: admin.userId, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'agent.suggestion_dismissed',
      target: { type: 'location', id: location.id },
      details: { locationId: location.id, suggestionId: record.id, type: record.type },
    });
  }
  const now = await ctx.stores.agentSuggestions.find(scope, location.id, record.id);
  if (now === null) throw notFound();
  const status = now.status === 'accepted' ? 'accepted' : 'dismissed';
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, suggestionId: record.id, decision: status }, 'townwise.agent_suggestion');
  const written = status === 'accepted' ? await writtenView(ctx, admin, location, now) : { note: null, rule: null };
  const body: DecideResult = { suggestion: { id: record.id, status }, ...written };
  res.status(200).json(body);
}
