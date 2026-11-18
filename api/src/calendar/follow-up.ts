// The deterministic follow-up of notes linked to owner-calendar events (openspec change calendar-event-suggestions,
// design decisions 3, 12 and 13). Where a replace switches in a calendar's events (the refresh loop, Refresh now and an
// add), followLinkedNotes compares the location's notes linked to that calendar with its current events and writes open
// suggestions for an org admin to accept or dismiss: a `move` when the event moved and the note is still on it, a
// `remove` when the event went and every guard holds, and an expiry of the note's open follow-up when neither applies.
// No model call and no budget: nothing leaves Townwise, so it runs whatever the weekly suggestions switch,
// TOWNWISE_WEEKLY_SUGGESTIONS and ANTHROPIC_API_KEY say. Every run recomputes from stored state, so a crash or a lost
// race costs nothing a later refresh does not redo. A note is "on its event" when its dates and hours equal its link's
// as a note holds them: Make a note leaves out the hours of a late night that ends after midnight (client
// noteRules.ts draftOfImported), since a note's end comes after its start, so such a link is compared, and a move
// proposed, with no hours. Logs carry the calendar id and counts only: never a title, a uid, a date or a guest count.
import type { Logger } from '@ckeith26/server-core';

import type { OrgScope } from '../access/policy.ts';
import { readNoteContent } from '../handlers/notes.ts';
import type { FollowContent, FollowUp } from '../stores/agent-suggestions.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent, NoteDates, NoteRecord } from '../stores/notes.ts';
import type { ReplaceResult, StoredEvent } from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { MAX_EVENTS } from './ics.ts';

/** What a refresh tells the follow-up beyond the events: the town's today, and how the replace went. */
export interface FollowGuards {
  readonly today: string;
  /** How many events the calendar holds: at 2,000 the cut may have dropped a linked one. */
  readonly eventCount: number;
  /** Of the replaced generation's keyed uids, how many the new events keep (stores/owner-calendars.ts replaceEvents). */
  readonly keptKeys: number;
  readonly hadKeys: number;
}

/** The follow-ups to write, and the notes whose open follow-up, if any, expires. */
export interface FollowUps {
  readonly follows: FollowContent[];
  readonly expire: string[];
}

/** A switched replace's answer. */
export type SwitchedReplace = Extract<ReplaceResult, { switched: true }>;

export interface FollowDeps {
  readonly stores: TownwiseStores;
  readonly logger: Logger;
}

function datesOf(dates: NoteDates): NoteDates {
  return { startDate: dates.startDate, endDate: dates.endDate, startTime: dates.startTime, endTime: dates.endTime };
}

/** Dates and hours as a note holds them: hours only when the start is before the end, as Make a note copies them. */
function asNote(dates: NoteDates): NoteDates {
  const timed = dates.startTime !== null && dates.endTime !== null && dates.startTime < dates.endTime;
  return { startDate: dates.startDate, endDate: dates.endDate, startTime: timed ? dates.startTime : null, endTime: timed ? dates.endTime : null };
}

function sameDates(a: NoteDates, b: NoteDates): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate && a.startTime === b.startTime && a.endTime === b.endTime;
}

function contentOf(note: NoteRecord): NoteContent {
  return {
    kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
    expectedGuests: note.expectedGuests, detail: note.detail, startTime: note.startTime, endTime: note.endTime,
  };
}

/** One linked note's follow-up, or null when there is nothing to suggest. */
function followUpOf(note: NoteRecord, event: StoredEvent | undefined, guards: FollowGuards): FollowContent | null {
  const link = note.fromEvent;
  if (link === null) return null;
  const from = datesOf(link);
  // A note edited off its event gets no suggestion.
  if (!sameDates(datesOf(note), asNote(from))) return null;
  const base: Omit<FollowUp, 'change' | 'to'> = { noteId: note.id, calendarId: link.calendarId, from, noteUpdatedAt: note.updatedAt };
  if (event !== undefined) {
    const to = datesOf(event);
    if (sameDates(to, from)) return null;
    // The event's exact new dates and hours, by Section 12's rules, starting after the town's today.
    const moved = readNoteContent({ ...contentOf(note), ...asNote(to) }, guards.today);
    if (moved === null || moved.startDate <= guards.today) return null;
    return { type: 'move', note: moved, follow: { ...base, change: 'moved', to } };
  }
  const gone = link.endDate >= guards.today && note.startDate > guards.today && guards.eventCount < MAX_EVENTS
    // A refresh that kept none of the keys the calendar had: the feed rewrote them, so nothing went.
    && (guards.hadKeys === 0 || guards.keptKeys > 0);
  return gone ? { type: 'remove', note: contentOf(note), follow: { ...base, change: 'gone', to: null } } : null;
}

/**
 * The follow-ups for the notes linked to one calendar, given its current keyed events: a `move` for a note still on an
 * event that moved, a `remove` for one whose event went (an event ending today or later, a note starting after today, a
 * calendar under 2,000 events, and a refresh that kept a key when the calendar had any), and an expiry for every other
 * linked note. Unlinked notes are left out. Pure.
 */
export function followUpsFor(links: readonly NoteRecord[], events: readonly StoredEvent[], guards: FollowGuards): FollowUps {
  const byUid = new Map(events.filter((event) => event.keyed).map((event) => [event.uid, event]));
  const follows: FollowContent[] = [];
  const expire: string[] = [];
  for (const note of links) {
    if (note.fromEvent === null) continue;
    const decided = followUpOf(note, byUid.get(note.fromEvent.uid), guards);
    if (decided === null) expire.push(note.id);
    else follows.push(decided);
  }
  return { follows, expire };
}

/** What one run wrote: follow-ups made or updated, by change, and open ones expired. */
interface FollowCounts {
  moved: number;
  gone: number;
  expired: number;
}

async function follow(
  deps: FollowDeps, scope: OrgScope, location: LocationRecord, calendarId: string, replaced: SwitchedReplace, now: Date,
): Promise<FollowCounts> {
  const { stores } = deps;
  const counts: FollowCounts = { moved: 0, gone: 0, expired: 0 };
  const links = await stores.notes.linkedTo(scope, location.id, calendarId);
  if (links.length === 0) return counts;
  const uids = [...new Set(links.flatMap((note) => (note.fromEvent === null ? [] : [note.fromEvent.uid])))];
  const read = await stores.ownerCalendars.eventsByUid(scope, location.id, calendarId, uids);
  // Gone, or a newer replace switched it since: that replace runs its own follow-up, with its own guards.
  if (read?.generation !== replaced.generation) return counts;
  const today = localDay(now, timeZoneOf(location.town).timeZone);
  const decided = followUpsFor(links, read.events, { today, eventCount: read.eventCount, keptKeys: replaced.keptKeys, hadKeys: replaced.hadKeys });
  for (const content of decided.follows) {
    const outcome = await stores.agentSuggestions.upsertFollow(scope, location.id, content, { today, now });
    if (outcome === 'made' || outcome === 'updated') counts[content.type === 'move' ? 'moved' : 'gone'] += 1;
  }
  for (const noteId of decided.expire) {
    if (await stores.agentSuggestions.expireFollow(scope, location.id, noteId, now)) counts.expired += 1;
  }
  // A location deleted while this ran keeps nothing it wrote, as the weekly pass does.
  if (decided.follows.length > 0 && (await stores.locations.find(scope, location.id)) === null) {
    await stores.agentSuggestions.removeForLocation(scope, location.id);
  }
  return counts;
}

/**
 * The follow-up after `replaced` switched in the calendar's events. Never throws: a failure is logged by the calendar's
 * id, and the refresh it follows stands.
 */
export async function followLinkedNotes(
  deps: FollowDeps, scope: OrgScope, location: LocationRecord, calendarId: string, replaced: SwitchedReplace, now: Date,
): Promise<void> {
  try {
    const counts = await follow(deps, scope, location, calendarId, replaced, now);
    if (counts.moved + counts.gone + counts.expired > 0) deps.logger.info({ calendarId, ...counts }, 'townwise.calendar_followups');
  } catch {
    deps.logger.warn({ calendarId }, 'townwise.calendar_followup_failed');
  }
}
