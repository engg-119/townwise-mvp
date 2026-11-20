// Sorting on import (D59 slice 2, openspec change auto-apply-agent-reads design decisions 1, 3, 6, 7, 10 and 13): a file
// calendar (CSV or .ics) imported while TownwiseAI works on its own is sorted by D58's Sort with TownwiseAI with no
// press, and the labels are used for forecasts at once. queueAutoSort marks it on import (only while TOWNWISE_AGENT_AUTO,
// the organization's own switch and its calendar titles switch are all on, a model key is set, and the person who
// imported it is not Townwise staff open as admin, who may not sort, since a sort sends customers' names to Anthropic),
// at most once per calendar. The TownwiseAI reader's loop (files/ai-reader.ts) claims it as it claims a file read: one
// job per organization at a time, a 90-second lease it renews, three attempts with 1, 2 and 4 minute waits. Then run():
//   1. A sort not yet begun: the switches and the importer's seat checked again, and a calendar someone already sorted,
//      labeled or confirmed (a press while it was queued) left to them (else skipped), D58's batches of the unlabeled
//      events reserved from the TownwiseAI month (else skipped `budget_spent`; the page still offers the press) and
//      sent, the charge settled; every batch failing puts the attempt back. The model's labels are then kept with the
//      queue entry (`autoSort.labels`) before any write, so a retry of any later step writes them with no second call.
//   2. One `booking.label` change through agent/apply.ts for the whole calendar (the dedupe key is the calendar's, so
//      it is sorted on its own once): the ledger row first, then every label the model gave (`unsure` stays unlabeled,
//      D58's rule; a label counts as sure, the answer having no confidence of its own) written as TownwiseAI's with the
//      row's planned time as its bookingAt, only on events nobody labeled, then the calendar confirmed by TownwiseAI
//      (D58's confirmBookings, confirmedBy `townwise_ai`). Before and after the labels are written, a label anyone else
//      set meanwhile (a person's, or a press's) or a confirm someone else made sets the whole sort aside (its labels and
//      confirm taken back, skipped `already_sorted`), so TownwiseAI's confirm never covers a label it did not set. The
//      row then gets the count and dates of the labels written, not of the model's answer.
//   3. A linked note for each upcoming buyout or party, as D58's confirm makes them (at most 100, within the note limit),
//      each its own `note.add` change, so a person's note on the day, an undone note or the same note from elsewhere
//      keeps it from being written; it stops once the labels' change is no longer applied (an Undo). No calibration
//      starts: a label on a past day wants a refit (agent/refit.ts).
// Undo per calendar is handlers/agent-changes.ts, refused while the sort runs. Logs carry the calendar's id, codes and
// counts only; never a title, a uid, an event's date or a label per event.
import type { OrgScope } from '../access/policy.ts';
import { agentAutoOn, applyChange, dedupeKeyOf, TOWNWISE_AI_AUTHOR, type WrittenFacts } from '../agent/apply.ts';
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
export type AutoSortSkip = 'agent_auto_off' | 'titles_off' | 'ai_unavailable' | 'requester_gone' | 'already_sorted' | 'budget_spent' | 'calendar_gone';

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

type Labels = { uid: string; booking: Booking }[];

/** What step 1 got: how many events it sent and the labels it kept, by uid. */
interface Sorted {
  readonly sent: number;
  readonly batchesFailed: number;
  readonly labels: Labels;
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
    // A press, a person's label or a Use for forecasts while it was queued: the calendar is theirs to confirm.
    if (calendar.bookings !== null && calendar.bookings.state !== 'unsorted') return 'already_sorted';
    return null;
  }

  /** Step 1: the unlabeled events sent in D58's batches within the TownwiseAI month; `budget_spent` before any call. */
  async function sortNow(scope: OrgScope, calendar: OwnerCalendarRecord): Promise<Sorted | 'budget_spent' | 'calendar_gone'> {
    const model = ctx.chat;
    if (model === null) throw new Error('no model');
    const events = await calendars.labeledEvents(scope, calendar.locationId, calendar.id, { unlabeled: true });
    if (events === null) return 'calendar_gone';
    const batches = bookingSortBatches(events);
    if (batches.length === 0) return { sent: 0, batchesFailed: 0, labels: [] };
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
    return { sent: events.length, batchesFailed: outcome.batchesFailed, labels: outcome.labels };
  }

  /** Whether anyone else labeled the calendar, or confirmed it, since this sort (its labels set at `at`) began. */
  async function othersSorted(scope: OrgScope, calendar: OwnerCalendarRecord, at: Date): Promise<boolean> {
    if ((await calendars.otherLabelCount(scope, calendar.locationId, calendar.id, at)) > 0) return true;
    const current = await calendars.find(scope, calendar.locationId, calendar.id);
    return current?.bookings?.state === 'confirmed' && current.bookings.confirmedBy !== TOWNWISE_AI_AUTHOR;
  }

  /**
   * Step 2's writer: the labels at the row's planned time, then the confirm, then the row's count and dates from the
   * labels written. Null when the calendar is gone, holds no label of this sort, or someone else sorted it meanwhile
   * (`setAside` then says so, and this sort's labels and confirm are taken back).
   */
  async function writeLabels(
    scope: OrgScope, calendar: OwnerCalendarRecord, labels: Labels, change: AgentChangeRecord, setAside: { value: boolean },
  ): Promise<WrittenFacts | null> {
    const at = change.appliedAt;
    const { locationId, id } = calendar;
    const leave = async (): Promise<null> => {
      setAside.value = true;
      await calendars.clearAiLabels(scope, locationId, id, at);
      await calendars.unconfirmBy(scope, locationId, id, TOWNWISE_AI_AUTHOR);
      return null;
    };
    if (await othersSorted(scope, calendar, at)) return leave();
    if ((await calendars.setLabels(scope, locationId, id, labels, at)) === null) return null;
    // Again once the labels are down, just before the confirm, which covers the whole calendar.
    if (await othersSorted(scope, calendar, at)) return leave();
    const written = await calendars.aiLabelFacts(scope, locationId, id, at);
    if (written === null || written.count === 0) return null;
    if ((await calendars.confirmBookings(scope, locationId, id, { by: TOWNWISE_AI_AUTHOR, now: at })) === null) return null;
    return { updatedAt: at, count: written.count, dates: written.booked };
  }

  /**
   * Step 3: linked notes for the confirmed calendar's upcoming buyouts and parties that need one (D58's rule), each only
   * while the labels' change `labelChangeId` is still applied, so an Undo of it stops the rest.
   */
  async function noteUpcoming(
    scope: OrgScope, location: LocationRecord, calendar: OwnerCalendarRecord, labelChangeId: string,
  ): Promise<{ made: number; skipped: number }> {
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
      if ((await stores.agentChanges.find(scope, location.id, labelChangeId))?.status !== 'applied') break;
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
    let held = await stores.agentChanges.findByKey(scope, location.id, autoSortKeyOf(calendar.id));
    if (held !== null && held.status !== 'applying' && held.status !== 'applied') {
      // Undone (or being undone) since: nothing more.
      await finish(scope, claim, 'done', null);
      return;
    }
    let sorted: Sorted | null = null;
    if (held?.status !== 'applied') {
      // The answer an earlier attempt kept; without one, a sort not yet begun calls the model now and keeps its answer.
      let labels = await calendars.sortLabels(scope, calendar.id);
      if (labels === null && held === null) {
        const skip = await skipReason(scope, calendar);
        const ran = skip ?? await sortNow(scope, calendar);
        if (typeof ran === 'string') {
          await finish(scope, claim, 'skipped', ran);
          return;
        }
        sorted = ran;
        labels = ran.labels;
        // Another attempt holds the sort now (this one's lease ran out), and finishes it.
        if (!(await calendars.saveSortLabels(scope, calendar.id, claim.attempt, labels))) return;
      }
      const kept = labels ?? [];
      if (held === null && kept.length === 0) {
        ctx.logger.info({ calendarId: calendar.id, sent: sorted?.sent ?? 0, labeled: 0, batchesFailed: sorted?.batchesFailed ?? 0, notes: 0, notesSkipped: 0 }, 'townwise.calendar_auto_sorted');
        await finish(scope, claim, 'done', null);
        return;
      }
      const setAside = { value: false };
      const applied = await applyChange(ctx, scope, {
        action: 'booking.label', locationId: location.id, sourceKind: 'calendar', sourceId: calendar.id, targetId: calendar.id,
        confidence: 'high', why: null, onBehalfOf: calendar.createdBy, actor: TOWNWISE_AI_ACTOR, key: `calendar:${calendar.id}`,
        // The row's count and dates come from the labels written (writeLabels), not from the model's answer.
        dates: null, write: (change) => writeLabels(scope, calendar, kept, change, setAside),
      });
      if (applied.outcome !== 'applied' || applied.change === null) {
        await finish(scope, claim, setAside.value ? 'skipped' : 'done', setAside.value ? 'already_sorted' : null);
        return;
      }
      held = applied.change;
    }
    const after = await calendars.find(scope, location.id, calendar.id);
    const notes = after?.bookings?.state === 'confirmed' ? await noteUpcoming(scope, location, calendar, held.id) : { made: 0, skipped: 0 };
    ctx.logger.info({
      calendarId: calendar.id, sent: sorted?.sent ?? 0, labeled: held.count ?? 0, batchesFailed: sorted?.batchesFailed ?? 0, notes: notes.made,
      notesSkipped: notes.skipped,
    }, 'townwise.calendar_auto_sorted');
    await finish(scope, claim, 'done', null);
  }

  return {
    run,
    renew: (scope, claim, until) => calendars.renewSortLease(scope, claim.calendarId, claim.attempt, until),
    release: (scope, claim, notBefore) => calendars.releaseSort(scope, claim.calendarId, claim.attempt, notBefore),
  };
}
