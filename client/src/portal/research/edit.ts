import type { ResearchedEvent } from '../analytics/api';
import { addDays, daysBetween, isCalendarDate } from '../locations/dates';
import type { ResearchedEventFields } from './api';
import { EDIT_SHEET } from './copy';

// The Calendar's edit sheet on a found event (D66 design decision 11), pure: the draft from the event's shown values,
// and the check before a save. The API checks the title and where again (safeText) and the dates by its own rules, and
// a refusal there is shown as FOUND_NOTICES.invalid. Weekdays are not edited here; an edit sends the event's own, less
// any its new dates leave out.

/** The longest title or place the sheet takes, as the API's research titles. */
export const MAX_FOUND_TEXT = 200;

export interface FoundDraft {
  title: string;
  start: string;
  end: string;
  startTime: string;
  where: string;
}

export function draftOfFound(event: Pick<ResearchedEvent, 'title' | 'start' | 'end' | 'startTime' | 'where'>): FoundDraft {
  return { title: event.title, start: event.start, end: event.end, startTime: event.startTime ?? '', where: event.where ?? '' };
}

export type FoundMessages = Partial<Record<keyof FoundDraft, string>>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The weekdays (0 Sunday to 6) the days from `start` to `end` fall on, at most all seven. */
function weekdaysIn(start: string, end: string): Set<number> {
  const span = Math.min(daysBetween(start, end), 6);
  const days = new Set<number>();
  for (let at = 0; at <= span; at += 1) days.add(new Date(`${addDays(start, at)}T00:00:00.000Z`).getUTCDay());
  return days;
}

/**
 * The event's weekdays for new dates: those that still fall in the span, so a "Thursdays only" series whose end moved
 * stays on Thursdays (the API refuses a weekday outside the span); null, every day, when none of them does.
 */
export function weekdaysFor(weekdays: readonly number[] | null, start: string, end: string): number[] | null {
  if (weekdays === null) return null;
  const inSpan = weekdaysIn(start, end);
  const kept = weekdays.filter((day) => inSpan.has(day));
  return kept.length === 0 ? null : kept;
}

/**
 * The draft's messages, or the fields an edit sends: trimmed, an empty time or place sent as null, and the event's own
 * weekdays kept as far as they still fall in its dates (weekdaysFor).
 */
export function checkFound(
  draft: FoundDraft, event: Pick<ResearchedEvent, 'weekdays'>,
): { messages: FoundMessages; fields: ResearchedEventFields | null } {
  const title = draft.title.trim();
  const start = draft.start.trim();
  const end = draft.end.trim();
  const startTime = draft.startTime.trim();
  const where = draft.where.trim();
  const messages: FoundMessages = {};
  if (title === '') messages.title = EDIT_SHEET.needTitle;
  if (!isCalendarDate(start)) messages.start = EDIT_SHEET.badDate;
  if (!isCalendarDate(end)) messages.end = EDIT_SHEET.badDate;
  else if (isCalendarDate(start) && end < start) messages.end = EDIT_SHEET.endBeforeStart;
  if (startTime !== '' && !TIME.test(startTime)) messages.startTime = EDIT_SHEET.badTime;
  if (Object.keys(messages).length > 0) return { messages, fields: null };
  return {
    messages,
    fields: {
      title,
      start,
      end,
      weekdays: weekdaysFor(event.weekdays, start, end),
      startTime: startTime === '' ? null : startTime,
      where: where === '' ? null : where,
    },
  };
}
