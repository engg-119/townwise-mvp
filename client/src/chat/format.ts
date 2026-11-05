import type { NoteProposal } from './api';

// Plain words for a note proposal and the chat's status lines. The note copy follows the portal spec's notes
// list (P14): the kind, "{start} to {end}", "{Mondays} only", the effect in words and "About {n} guests".

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 0 is Sunday, as in the notes API. */
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

const TOOL_LABEL: Record<string, string> = {
  get_location_overview: 'Reading the sales summary',
  get_sales_days: 'Reading sales history',
  list_notes: 'Reading your notes',
  get_town_profile: 'Reading the town profile',
  propose_note: 'Writing a note',
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? 'Looking something up';
}

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
