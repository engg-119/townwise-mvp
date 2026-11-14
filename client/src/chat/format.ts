import { formatTime } from '../portal/format';
import type { NoteProposal } from './api';

// Plain words for a note proposal and TownwiseAI's dates. The note copy follows the portal spec's notes list (P14):
// the kind, "{start} to {end}", "{Mondays} only", the effect in words and "About {n} guests". Tool copy is in
// tools.ts.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 0 is Sunday, as in the notes API. */
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export const KIND_LABEL: Record<NoteProposal['kind'], string> = {
  closure: 'Closure',
  private_event: 'Private event',
  opening: 'Opening',
  other: 'Other',
};

export const EFFECT_LABEL: Record<NoteProposal['effect'], string> = {
  closed: 'Closed',
  more_guests: 'More guests than usual',
  fewer_guests: 'Fewer guests than usual',
  unknown: 'Not sure',
};

/** A calendar date, YYYY-MM-DD, in words ("March 3, 2026"), read without a time zone. */
export function formatDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  if (match === null || month === undefined) return date;
  return `${month} ${String(Number(match[3]))}, ${match[1] ?? ''}`;
}

export function formatDates(proposal: Pick<NoteProposal, 'startDate' | 'endDate'>): string {
  if (proposal.startDate === proposal.endDate) return formatDate(proposal.startDate);
  return `${formatDate(proposal.startDate)} to ${formatDate(proposal.endDate)}`;
}

/** "Mondays only", "Mondays and Fridays only"; null when the note covers every day. */
export function weekdaysText(weekdays: readonly number[] | null): string | null {
  if (weekdays === null || weekdays.length === 0 || weekdays.length >= 7) return null;
  const names = [...weekdays].sort((a, b) => a - b).map((day) => WEEKDAYS[day] ?? String(day));
  const list = names.length === 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
  return `${list} only`;
}

export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function guestsText(expectedGuests: number | null): string | null {
  return expectedGuests === null ? null : `About ${formatCount(expectedGuests)} guests`;
}

/** An instant as a short local date ("Nov 4, 2026"). */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${SHORT_MONTHS[date.getMonth()] ?? ''} ${String(date.getDate())}, ${String(date.getFullYear())}`;
}

function partsOf(date: string): { year: string; month: string; day: number; weekday: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match === null ? undefined : SHORT_MONTHS[Number(match[2]) - 1];
  if (match === null || month === undefined) return null;
  const weekday = SHORT_WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? '';
  return { year: match[1] ?? '', month, day: Number(match[3]), weekday };
}

/** A range of calendar dates, short: "Oct 1 to Oct 31, 2026", "Dec 20, 2025 to Jan 3, 2026", or "Oct 1, 2026". */
export function rangeText(from: string, to: string): string {
  const start = partsOf(from);
  const end = partsOf(to);
  if (start === null || end === null) return from === to ? from : `${from} to ${to}`;
  const endText = `${end.month} ${String(end.day)}, ${end.year}`;
  if (from === to) return endText;
  if (start.year === end.year) return `${start.month} ${String(start.day)} to ${endText}`;
  return `${start.month} ${String(start.day)}, ${start.year} to ${endText}`;
}

/** A calendar date with its weekday: "Thu, Nov 26, 2026". */
export function dayText(date: string): string {
  const parts = partsOf(date);
  return parts === null ? date : `${parts.weekday}, ${parts.month} ${String(parts.day)}, ${parts.year}`;
}

/** A calendar date with its weekday and no year: "Mon, Oct 19". */
export function shortDayText(date: string): string {
  const parts = partsOf(date);
  return parts === null ? date : `${parts.weekday}, ${parts.month} ${String(parts.day)}`;
}

/** The plural weekday name ("Mondays"), 0 being Sunday. */
export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? String(weekday);
}

/** A message's time as the viewer reads it: "8:59 PM" today, "Nov 9, 8:59 PM" another day, "Nov 9, 2025, 8:59 PM" another year. */
export function formatMessageTime(at: number, now: number = Date.now()): string {
  const time = new Date(at);
  const today = new Date(now);
  const clock = formatTime(time);
  if (time.getFullYear() === today.getFullYear() && time.getMonth() === today.getMonth() && time.getDate() === today.getDate()) return clock;
  const day = `${SHORT_MONTHS[time.getMonth()] ?? ''} ${String(time.getDate())}`;
  return time.getFullYear() === today.getFullYear() ? `${day}, ${clock}` : `${day}, ${String(time.getFullYear())}, ${clock}`;
}
