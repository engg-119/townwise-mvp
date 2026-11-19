// Sorting on import (D59 slice 2, openspec change auto-apply-agent-reads design decisions 1, 3, 6, 7, 10 and 13): a file
// calendar (CSV or .ics) imported while TownwiseAI works on its own is sorted by D58's Sort with TownwiseAI with no
// press, and the labels are used for forecasts at once. queueAutoSort marks it on import (only while TOWNWISE_AGENT_AUTO,
// the organization's own switch and its calendar titles switch are all on, a model key is set, and the person who
// imported it is not Townwise staff open as admin, who may not sort, since a sort sends customers' names to Anthropic),
// at most once per calendar. The TownwiseAI reader's loop (files/ai-reader.ts) claims it as it claims a file read: one
// job per organization at a time, a 90-second lease it renews, three attempts with 1, 2 and 4 minute waits. Then run():
//   1. A sort not yet begun: the switches and the importer's seat checked again (else skipped), D58's batches of the
//      unlabeled events reserved from the TownwiseAI month (else skipped `budget_spent`; the page still offers the
//      press) and sent, the charge settled; every batch failing puts the attempt back.
//   2. One `booking.label` change through agent/apply.ts for the whole calendar (the dedupe key is the calendar's, so
//      it is sorted on its own once): the ledger row first, then every label the model gave (`unsure` stays unlabeled,
//      D58's rule; a label counts as sure, the answer having no confidence of its own) written as TownwiseAI's with the
//      row's planned time as its bookingAt, only on events nobody labeled, then the calendar confirmed by TownwiseAI
//      (D58's confirmBookings, confirmedBy `townwise_ai`). A retry finds the row and finishes it without another call.
//   3. A linked note for each upcoming buyout or party, as D58's confirm makes them (at most 100, within the note limit),
//      each its own `note.add` change, so a person's note on the day, an undone note or the same note from elsewhere
//      keeps it from being written. No calibration starts: a label on a past day wants a refit (agent/refit.ts).
// Undo per calendar is handlers/agent-changes.ts. Logs carry the calendar's id, codes and counts only; never a title,
// a uid, an event's date or a label per event. [CONFIRM: a calendar file imported while TownwiseAI works on its own is
// sorted and its labels used for forecasts with no press] [CONFIRM: a label other than unsure counts as sure, so an
// import's labels are used for forecasts at once] [CONFIRM: a calendar file staff import with an organization open as
// its admin is not sorted on its own]
import type { OrgScope } from '../access/policy.ts';
import { agentAutoOn, applyChange, dedupeKeyOf, TOWNWISE_AI_AUTHOR } from '../agent/apply.ts';
import type { TownwiseContext } from '../app.ts';
import { TOWNWISE_AI_ACTOR } from '../audit.ts';
import { utcDay } from '../dates.ts';
import { MAX_ATTEMPTS } from '../files/limits.ts';
import { bookingNote, isBooked, MAX_CONFIRM_NOTES, noteIdOf } from '../handlers/calendar-bookings.ts';
import { MAX_NOTES } from '../handlers/notes.ts';
import { coversEvent } from '../lab/suggestions.ts';
import type { AgentChangeRecord } from '../stores/agent-changes.ts';
import type { ClaimedCalendarSort } from '../stores/cross-tenant.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { Booking, LabeledEvent, OwnerCalendarRecord } from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { BOOKING_SORT_TIME_MS, bookingSortBatches, bookingSortReserveMicroUsd, runBookingSort } from './booking-sort.ts';

/** Why an automatic sort was skipped (`autoSort.reason`). */
export type AutoSortSkip = 'agent_auto_off' | 'titles_off' | 'ai_unavailable' | 'requester_gone' | 'budget_spent' | 'calendar_gone';

/**
 * The reader loop's seam (files/ai-reader.ts): it claims a sort and holds its lease; this does the work and records the
 * end. `run` throws to put the attempt back in the queue.
 */
export interface CalendarSorts {
  run(scope: OrgScope, claim: ClaimedCalendarSort): Promise<void>;
  renew(scope: OrgScope, claim: ClaimedCalendarSort, until: Date): Promise<boolean>;
  release(scope: OrgScope, claim: ClaimedCalendarSort, notBefore: Date): Promise<boolean>;
}

/** The dedupe key of a calendar's sort on import: one per calendar, in every status. */
export function autoSortKeyOf(calendarId: string): string {
  return dedupeKeyOf({ action: 'booking.label', key: `calendar:${calendarId}` });
}

/**
 * Queues the calendar's automatic sort when it qualifies (the top). Never throws: a failure is logged by the calendar's
 * id, and the calendar's page still offers Sort with TownwiseAI. Resolves whether it queued.
 */
export async function queueAutoSort(
  ctx: TownwiseContext, scope: OrgScope, calendar: OwnerCalendarRecord, by: { readonly openAsAdmin: boolean },
): Promise<boolean> {
  const reads = ctx.aiReads;
  if (calendar.kind !== 'file' || calendar.eventCount === 0 || by.openAsAdmin || reads === null || ctx.chat === null || !ctx.config.agentAuto) return false;
  try {
    const org = await ctx.stores.orgs.findById(scope.orgId);
    if (org?.status !== 'active' || !org.agentAuto.on || !org.calendarTitlesToAi.on) return false;
    if (!(await ctx.stores.ownerCalendars.queueAutoSort(scope, calendar.locationId, calendar.id, ctx.now()))) return false;
    ctx.logger.info({ orgId: scope.orgId, locationId: calendar.locationId, calendarId: calendar.id }, 'townwise.calendar_auto_sort_queued');
    reads.nudge();
    return true;
  } catch (err) {
    ctx.logger.warn({ calendarId: calendar.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.calendar_auto_sort_queue_failed');
    return false;
  }
}

/** What step 1 got: the events it sent and the labels it kept, by uid. */
interface Sorted {
  readonly sent: number;
  readonly batchesFailed: number;
  readonly labels: { uid: string; booking: Booking }[];
  readonly events: readonly LabeledEvent[];
}

/** The first and last day of the buyouts and parties among `labels`, for the activity and the refit; null with none. */
function bookedDates(labels: readonly { uid: string; booking: Booking }[], events: readonly LabeledEvent[]): { startDate: string; endDate: string } | null {
  const byUid = new Map(events.map((event) => [event.uid, event]));
  const booked = labels.flatMap((label) => {
    const event = byUid.get(label.uid);
    return isBooked(label.booking) && event !== undefined ? [event] : [];
  });
  if (booked.length === 0) return null;
  return {
    startDate: booked.reduce((min, event) => (event.startDate < min ? event.startDate : min), booked[0]?.startDate ?? ''),
    endDate: booked.reduce((max, event) => (event.endDate > max ? event.endDate : max), booked[0]?.endDate ?? ''),
  };
}

/** A change's dates, both or none. */
function rowDates(change: AgentChangeRecord): { startDate: string; endDate: string } | null {
  return change.startDate === null || change.endDate === null ? null : { startDate: change.startDate, endDate: change.endDate };
}

export function createCalendarSorts(ctx: TownwiseContext): CalendarSorts {
  const { stores } = ctx;
  const calendars = stores.ownerCalendars;

  async function finish(scope: OrgScope, claim: ClaimedCalendarSort, status: 'done' | 'skipped' | 'failed', reason: string | null): Promise<void> {
    const done = await calendars.finishSort(scope, claim.calendarId, claim.attempt, { status, reason, at: ctx.now() });
    if (done && status !== 'done') {
      ctx.logger.info({ calendarId: claim.calendarId, reason }, status === 'skipped' ? 'townwise.calendar_auto_sort_skipped' : 'townwise.calendar_auto_sort_failed');
    }
  }

  /** Why a sort not yet begun stops before any call (the switches may have changed while it waited), or null. */
  async function skipReason(scope: OrgScope, calendar: OwnerCalendarRecord): Promise<AutoSortSkip | null> {
    if (!(await agentAutoOn(ctx, scope.orgId))) return 'agent_auto_off';
    if ((await stores.orgs.findById(scope.orgId))?.calendarTitlesToAi.on !== true) return 'titles_off';
    if (ctx.chat === null) return 'ai_unavailable';
    if ((await stores.members.activeRole(scope, calendar.createdBy)) === null) return 'requester_gone';
    return null;
  }

  /** Step 1: the unlabeled events sent in D58's batches within the TownwiseAI month; `budget_spent` before any call. */
  async function sortNow(scope: OrgScope, calendar: OwnerCalendarRecord): Promise<Sorted | 'budget_spent' | 'calendar_gone'> {
    const model = ctx.chat;
    if (model === null) throw new Error('no model');
    const events = await calendars.labeledEvents(scope, calendar.locationId, calendar.id, { unlabeled: true });
    if (events === null) return 'calendar_gone';
    const batches = bookingSortBatches(events);
    if (batches.length === 0) return { sent: 0, batchesFailed: 0, labels: [], events };
    const month = ctx.now().toISOString().slice(0, 7);
    const reserve = bookingSortReserveMicroUsd(batches);
    if (!(await stores.chatUsage.reserve(scope, month, reserve, Math.round(ctx.config.chatMonthlyBudgetUsd * 1_000_000), ctx.now()))) {
      return 'budget_spent';
    }
    let costMicroUsd = 0;
    let outcome;
    try {
      outcome = await runBookingSort(model, batches, AbortSignal.timeout(BOOKING_SORT_TIME_MS));
      ({ costMicroUsd } = outcome);
    } finally {
      if (costMicroUsd !== reserve) await stores.chatUsage.add(scope, month, costMicroUsd - reserve, ctx.now());
    }
    // Nothing came back: a later attempt tries again (the read's waits), and after three the sort fails.
    if (outcome.batchesFailed === batches.length) throw new Error('every batch failed');
    return { sent: events.length, batchesFailed: outcome.batchesFailed, labels: outcome.labels, events };
  }

  /**
   * Step 2's writer: the labels at the row's planned time, then the confirm. Null when the calendar is gone or holds no
   * label of this sort (a person labeled every event meanwhile).
   */
  async function writeLabels(scope: OrgScope, calendar: OwnerCalendarRecord, labels: Sorted['labels'], at: Date): Promise<Date | null> {
    if ((await calendars.setLabels(scope, calendar.locationId, calendar.id, labels, at)) === null) return null;
    if ((await calendars.aiLabelCount(scope, calendar.locationId, calendar.id, at)) === 0) return null;
    if ((await calendars.confirmBookings(scope, calendar.locationId, calendar.id, { by: TOWNWISE_AI_AUTHOR, now: at })) === null) return null;
    return at;
  }

  /** Step 3: linked notes for the confirmed calendar's upcoming buyouts and parties that need one (D58's rule). */
  async function noteUpcoming(scope: OrgScope, location: LocationRecord, calendar: OwnerCalendarRecord): Promise<{ made: number; skipped: number }> {
    const events = await calendars.labeledEvents(scope, location.id, calendar.id);
    if (events === null) return { made: 0, skipped: 0 };
    const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
    const notes = await stores.notes.list(scope, location.id);
    const linked = new Set(notes.flatMap((note) => (note.fromEvent?.calendarId === calendar.id ? [note.fromEvent.uid] : [])));
    const due = events.filter((event): event is LabeledEvent & { booking: 'buyout' | 'party' } => isBooked(event.booking)
      && event.keyed && event.endDate >= today && !linked.has(event.uid) && !notes.some((note) => coversEvent(note, event)))
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
      .slice(0, MAX_CONFIRM_NOTES);
    let made = 0;
    let skipped = 0;
    let count = notes.length;
    for (const event of due) {
      const content = count >= MAX_NOTES ? null : bookingNote(event, utcDay(ctx.now()));
      if (content === null) {
        skipped += 1;
        continue;
      }
      const result = await applyChange(ctx, scope, {
        action: 'note.add', locationId: location.id, sourceKind: 'calendar', sourceId: calendar.id, targetId: noteIdOf(calendar.id, event.uid),
        confidence: 'high', why: null, onBehalfOf: calendar.createdBy, actor: TOWNWISE_AI_ACTOR, note: content, createdBy: TOWNWISE_AI_AUTHOR,
        fromEvent: {
          calendarId: calendar.id, uid: event.uid, startDate: event.startDate, endDate: event.endDate, startTime: event.startTime,
          endTime: event.endTime, linkedAt: ctx.now(),
        },
      });
      if (result.outcome === 'applied') {
        made += 1;
        count += 1;
      } else {
        skipped += 1;
      }
    }
    return { made, skipped };
  }

  async function run(scope: OrgScope, claim: ClaimedCalendarSort): Promise<void> {
    if (claim.attempt > MAX_ATTEMPTS) {
      await finish(scope, claim, 'failed', 'internal');
      return;
    }
    const [calendar, location] = await Promise.all([
      calendars.find(scope, claim.locationId, claim.calendarId), stores.locations.find(scope, claim.locationId),
    ]);
    // A calendar removed meanwhile took its queue entry with it.
    if (calendar?.kind !== 'file') return;
    if (location === null) {
      await finish(scope, claim, 'skipped', 'calendar_gone');
      return;
    }
    const held = await stores.agentChanges.findByKey(scope, location.id, autoSortKeyOf(calendar.id));
    let sorted: Sorted = { sent: 0, batchesFailed: 0, labels: [], events: [] };
    let dates = held === null ? null : rowDates(held);
    if (held === null) {
      const skip = await skipReason(scope, calendar);
      const ran = skip ?? await sortNow(scope, calendar);
      if (typeof ran === 'string') {
        await finish(scope, claim, 'skipped', ran);
        return;
      }
      sorted = ran;
      dates = bookedDates(sorted.labels, sorted.events);
    } else if (held.status !== 'applying' && held.status !== 'applied') {
      // Undone (or being undone) since: nothing more.
      await finish(scope, claim, 'done', null);
      return;
    }
    let labeled = 0;
    if (held?.status !== 'applied') {
      if (held === null && sorted.labels.length === 0) {
        ctx.logger.info({ calendarId: calendar.id, sent: sorted.sent, labeled: 0, batchesFailed: sorted.batchesFailed, notes: 0, notesSkipped: 0 }, 'townwise.calendar_auto_sorted');
        await finish(scope, claim, 'done', null);
        return;
      }
      const applied = await applyChange(ctx, scope, {
        action: 'booking.label', locationId: location.id, sourceKind: 'calendar', sourceId: calendar.id, targetId: calendar.id,
        confidence: 'high', why: null, onBehalfOf: calendar.createdBy, actor: TOWNWISE_AI_ACTOR, key: `calendar:${calendar.id}`, dates,
        count: sorted.labels.length, write: (change) => writeLabels(scope, calendar, sorted.labels, change.appliedAt),
      });
      if (applied.outcome !== 'applied') {
        await finish(scope, claim, 'done', null);
        return;
      }
      labeled = applied.change?.count ?? sorted.labels.length;
    }
    const after = await calendars.find(scope, location.id, calendar.id);
    const notes = after?.bookings?.state === 'confirmed' ? await noteUpcoming(scope, location, calendar) : { made: 0, skipped: 0 };
    ctx.logger.info({
      calendarId: calendar.id, sent: sorted.sent, labeled, batchesFailed: sorted.batchesFailed, notes: notes.made, notesSkipped: notes.skipped,
    }, 'townwise.calendar_auto_sorted');
    await finish(scope, claim, 'done', null);
  }

  return {
    run,
    renew: (scope, claim, until) => calendars.renewSortLease(scope, claim.calendarId, claim.attempt, until),
    release: (scope, claim, notBefore) => calendars.releaseSort(scope, claim.calendarId, claim.attempt, notBefore),
  };
}
