import { shortDate } from '../analytics/words';

// How an order is built and how the next one relates to a calendar day, for Home's selected day and Orders. A missing
// order is said as missing. No figure is filled in.

export const REORDER_OVERVIEW = 'Each supplier’s order has to last until that supplier’s next delivery. For each item, Townwise averages its sales on each weekday over the last 8 weeks, scales those averages to the guest forecast when one is published, adds a cushion for how far sales strayed from them in past order periods, and orders up to that level, or the par if that is higher, minus your last count, rounded to a deal. Without a recent count it goes by the par. You place every order yourself; nothing is sent to a distributor.';

export interface OrderWindow {
  readonly sample: boolean;
  readonly supplier: string;
  readonly cutoff: string;
  readonly delivery: string;
  /** The supplier's following delivery, which this order lasts until. */
  readonly coversThrough: string;
}

/** Whether a calendar day sits in an order’s window: its order-by day up to the day before the following delivery. */
export function dayInOrder(day: string, order: Pick<OrderWindow, 'cutoff' | 'coversThrough'>): boolean {
  return day >= order.cutoff && day < order.coversThrough;
}

/** The supplier order whose window holds `day`, else the soonest one; null with no board or no order on it. */
export function orderForDay(
  day: string,
  board: { readonly sample: boolean; readonly orders: readonly Omit<OrderWindow, 'sample'>[] } | null,
): OrderWindow | null {
  if (board === null) return null;
  const order = board.orders.find((each) => dayInOrder(day, each)) ?? board.orders[0];
  if (order === undefined) return null;
  return { sample: board.sample, supplier: order.supplier, cutoff: order.cutoff, delivery: order.delivery, coversThrough: order.coversThrough };
}

/** How the next order relates to a calendar day. `order` null means there is no board to place the day on. */
export function orderCoverSentence(day: string, order: OrderWindow | null): string {
  const when = shortDate(day);
  if (order === null) return `${when} isn’t on an order yet.`;
  const delivery = shortDate(order.delivery);
  const next = shortDate(order.coversThrough);
  const sample = order.sample ? 'Sample bar. ' : '';
  if (!dayInOrder(day, order)) {
    return `${sample}The next order from ${order.supplier} arrives ${delivery} and lasts until its next delivery, ${next}. ${when} is outside it.`;
  }
  return `${sample}The order from ${order.supplier} arriving ${delivery} lasts until its next delivery, ${next}, so it plans for ${when}.`;
}
