import { rangeText } from '../estimates/format';
import type { ForecastGlanceDay } from '../estimates/api';
import { formatCount } from '../format';
import { shortDate } from '../analytics/words';

// What sits beside the month calendar: a published guest forecast for the selected day, and how an order is built.
// A missing forecast or a missing order is said as missing. No figure is filled in.

export const REORDER_OVERVIEW = 'An order has to last from its cutoff until the next delivery arrives. Townwise turns the guest forecast for those days into servings, adds a cushion for how far past orders of that length ran short, and orders up to that level minus what is already on hand. It shows the nearest smaller and larger deal. You approve every order. Nothing is sent to a distributor.';

/** The published guest forecast for one day, in one sentence. `day` null means this day was not in a published run. */
export function guestForecastSentence(day: ForecastGlanceDay | null): string {
  if (day === null) return 'No published guest forecast for this day.';
  if (day.status === 'closed') return 'The published forecast marks this day closed.';
  if (day.status === 'booked') return 'This day is booked, so the published forecast has no walk-in guests.';
  if (day.mid === null || day.low === null || day.high === null) return 'No published guest forecast for this day.';
  const mid = formatCount(Math.round(day.mid));
  return `About ${mid} guests, usually ${rangeText(day.low, day.high)}. About 8 in 10 days fall between those two.`;
}

export interface OrderWindow {
  readonly sample: boolean;
  readonly cutoff: string;
  readonly delivery: string;
  readonly coversThrough: string;
}

/** Whether a calendar day sits in an order’s window, cutoff through the day that delivery covers. */
export function dayInOrder(day: string, order: OrderWindow): boolean {
  return day >= order.cutoff && day <= order.coversThrough;
}

/** How the next order relates to a calendar day. `order` null means there is no board to place the day on. */
export function orderCoverSentence(day: string, order: OrderWindow | null): string {
  const when = shortDate(day);
  if (order === null) return `${when} isn’t on an order yet.`;
  const delivery = shortDate(order.delivery);
  const through = shortDate(order.coversThrough);
  const sample = order.sample ? 'Sample bar. ' : '';
  if (!dayInOrder(day, order)) {
    return `${sample}The next order delivers ${delivery} and covers through ${through}. ${when} is outside it.`;
  }
  return `${sample}This order delivers ${delivery} and covers through ${through}, which includes ${when}.`;
}
