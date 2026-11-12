import { addDays, EARLIEST_DATE, isCalendarDate } from '../portal/locations/dates';

// F7: the Agent page's `?about=YYYY-MM-DD` (the Analytics day panel's "Ask TownwiseAI about this day"). It only fills
// the composer, "Tell me about Sat, Nov 21", and sends nothing: the person reads it, adds to it and sends it. A value
// that is not one real date from 2010-01-01 to 400 days after today (get_day's range) is ignored.

const MAX_DAYS_AHEAD = 400;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The composer text for `?about=`, or null to leave the composer as it is. `today` is the viewer's day. */
export function aboutDraft(about: unknown, today: string): string | null {
  if (typeof about !== 'string' || !isCalendarDate(about)) return null;
  if (about < EARLIEST_DATE || about > addDays(today, MAX_DAYS_AHEAD)) return null;
  const date = new Date(`${about}T00:00:00.000Z`);
  const day = `${SHORT_WEEKDAYS[date.getUTCDay()] ?? ''}, ${SHORT_MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
  return `Tell me about ${about.slice(0, 4) === today.slice(0, 4) ? day : `${day}, ${about.slice(0, 4)}`}`;
}

export interface OrderDraftLine {
  readonly itemId: string;
  readonly name: string;
}

export interface OrderDraftBoard {
  readonly delivery: string;
  readonly lines: readonly OrderDraftLine[];
}

/** The composer text for `?order=` and an optional `?item=`. A date or item the board does not have is ignored. */
export function orderDraft(order: unknown, item: unknown, board: OrderDraftBoard | null): string | null {
  if (board === null || typeof order !== 'string' || !isCalendarDate(order) || order !== board.delivery) return null;
  const date = new Date(`${order}T00:00:00.000Z`);
  const day = `${SHORT_WEEKDAYS[date.getUTCDay()] ?? ''}, ${SHORT_MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
  const when = order.slice(0, 4) === board.delivery.slice(0, 4) ? day : `${day}, ${order.slice(0, 4)}`;
  if (item === undefined || item === '') return `Explain the order for the ${when} delivery`;
  if (typeof item !== 'string') return null;
  const line = board.lines.find((entry) => entry.itemId === item);
  if (line === undefined) return null;
  return `Why ${line.name} for the ${when} delivery?`;
}
