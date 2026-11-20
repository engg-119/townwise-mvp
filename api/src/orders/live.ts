// The live order board for a location (design Decision 5): reads its ordering setup, item sales, latest counts, the
// published guest forecast and its past guests, runs the engine, and applies the saved edits and active rules. Also
// what the setup page and TownwiseAI read beside the setup (loadSetupState). Reads: they write nothing and log nothing.
import type { TownwiseContext } from '../app.ts';
import { trustedGuestDays } from '../closed-days.ts';
import type { OrgScope } from '../access/policy.ts';
import type { ItemSalesCoverage, ItemSalesDay } from '../stores/item-sales.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { LatestCount } from '../stores/order-counts.ts';
import type { StoredSetup } from '../stores/order-setups.ts';
import { localDay, localMinutes, timeZoneOf } from '../time-zones.ts';
import { liveBoard, unavailable, withPreferences, type OrderAnswer } from './board.ts';
import { addDays } from './dates.ts';
import { computeOrders } from './engine.ts';

/**
 * The item-sales days the board reads: the cushion's oldest past window has its delivery 26 weeks (182 days) back and
 * its cutoff up to 6 days before that, and its weekday means read the 8 weeks (56 days) before that cutoff.
 */
export const ITEM_SALES_DAYS = 182 + 6 + 56;
/** The 8 weeks the weekday means, the coverage and the guest index read. */
export const MEAN_DAYS = 56;
/**
 * How far back the latest count is read. A count older than 7 days still matters: the quantity is the par less what
 * it counted, where no count at all orders the whole par. The read goes newest first and stops once every setup item
 * has a count; the bound keeps it small when one never was.
 */
export const COUNT_DAYS = 400;
const FRESH_COUNT_DAYS = 7;
/** The forecast window read: today and the 30 days after, the reader's 31-day limit. */
const FORECAST_DAYS = 30;

/** The town's date and minutes since its midnight, now. */
export function townClock(ctx: TownwiseContext, location: LocationRecord): { today: string; nowMinutes: number } {
  const now = ctx.now();
  const { timeZone } = timeZoneOf(location.town);
  return { today: localDay(now, timeZone), nowMinutes: localMinutes(now, timeZone) };
}

/** The board and the item-sales days it was built from (none when the setup cannot make one). */
export interface LoadedBoard {
  readonly answer: OrderAnswer;
  readonly itemSales: readonly ItemSalesDay[];
}

/**
 * The location's board as of `today` and `nowMinutes` (the town's), with the item-sales days it read, so
 * get_order_line shows the same days without a second read. Unavailable, naming what is missing, without a setup or
 * with a setup that has no supplier delivery or no item. `missing` on a board names 'item sales' when no day of the
 * last 8 weeks is covered, and 'a recent count' when no item of the setup was counted in the last 7 days. A forecast
 * day marked closed expects no sales; a booked day (a private buyout) keeps the weekday mean, with no guest index.
 */
export async function loadBoardWithSales(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, today: string, nowMinutes: number,
): Promise<LoadedBoard> {
  const { stores } = ctx;
  const setup = await stores.orderSetups.get(scope, location.id);
  if (setup === null) return { answer: unavailable(['the supplier schedule', 'the items']), itemSales: [] };
  const lacking = [
    ...(setup.suppliers.some((supplier) => supplier.deliveries.length > 0) ? [] : ['the supplier schedule']),
    ...(setup.items.length > 0 ? [] : ['the items']),
  ];
  if (lacking.length > 0) return { answer: unavailable(lacking), itemSales: [] };

  const yesterday = addDays(today, -1);
  const guestDays = { from: addDays(today, -MEAN_DAYS), to: yesterday };
  const [itemSales, counts, forecast, stored, marks, decisions, rules] = await Promise.all([
    stores.itemSales.days(scope, location.id, { from: addDays(today, -ITEM_SALES_DAYS), to: yesterday }),
    stores.orderCounts.latest(scope, location.id, addDays(today, -COUNT_DAYS), setup.items.map((item) => item.id)),
    ctx.ports.forecasts.window(scope, location, { from: today, to: addDays(today, FORECAST_DAYS) }, today),
    stores.salesDays.days(scope, location.id, guestDays),
    stores.notes.overlapping(scope, location.id, guestDays),
    // Every delivery on the board is today or later, so older edits are never shown.
    stores.orders.listDecisions(scope, location.id, today),
    stores.orders.listRules(scope, location.id),
  ]);
  // D67: a guest count a note marks wrong is in no baseline mean.
  const history = trustedGuestDays(stored, marks);
  const forecastGuests = new Map(forecast.days.flatMap((day) =>
    (day.status === 'open' && day.mid !== null ? [[day.date, day.mid] as const] : [])));
  const closedDays = new Set(forecast.days.flatMap((day) => (day.status === 'closed' ? [day.date] : [])));
  const plans = computeOrders({
    suppliers: setup.suppliers,
    items: setup.items,
    itemSales,
    counts,
    forecastGuests,
    closedDays,
    historyGuests: history.map((day) => ({ date: day.date, guests: day.guests })),
    today,
    nowMinutes,
  });

  const recentSince = addDays(today, -MEAN_DAYS);
  const freshSince = addDays(today, -FRESH_COUNT_DAYS);
  const missing = [
    ...(itemSales.some((day) => day.date >= recentSince) ? [] : ['item sales']),
    ...(setup.items.some((item) => (counts.get(item.id)?.date ?? '') >= freshSince) ? [] : ['a recent count']),
  ];
  const answer = withPreferences(
    liveBoard(plans, missing),
    decisions.map((row) => ({ itemId: row.itemId, delivery: row.delivery, quantity: row.quantity, unit: row.unit, reason: row.reason })),
    rules.map((row) => ({ id: row.id, itemId: row.itemId, delta: row.delta, unit: row.unit, situation: row.situation, off: row.off })),
  );
  return { answer, itemSales };
}

/** The location's board as of `today` and `nowMinutes` (the town's); see loadBoardWithSales. */
export async function loadBoard(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, today: string, nowMinutes: number,
): Promise<OrderAnswer> {
  return (await loadBoardWithSales(ctx, scope, location, today, nowMinutes)).answer;
}

/** The board now, in the location's town. */
export function loadBoardNow(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord): Promise<OrderAnswer> {
  const { today, nowMinutes } = townClock(ctx, location);
  return loadBoard(ctx, scope, location, today, nowMinutes);
}

/** The setup (null when none was saved) and what the setup page shows beside it. */
export interface SetupState {
  readonly setup: StoredSetup | null;
  /** The first and last stored item-sales days and how many are stored; null when none is. */
  readonly coverage: ItemSalesCoverage | null;
  /** Per item id, its covered days with any servings in the 8 weeks before `today`. */
  readonly itemCoverage: Readonly<Record<string, number>>;
  /** Per item id, its latest count in the 400 days before `today` (the board's read); an item not counted then is left out. */
  readonly counts: Readonly<Record<string, LatestCount>>;
  /**
   * The setup's item ids with history that removing the item would leave behind: any servings in the 244 days of item
   * sales the board reads, a count in its 400 days, or any saved edit or rule.
   */
  readonly itemsWithHistory: readonly string[];
}

/**
 * The setup and its item-sales coverage, counts and history as of `today` (the town's). GET .../orders/setup and
 * get_order_setup. Reads only what the board reads, and the setup items' edits and rules.
 */
export async function loadSetupState(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, today: string): Promise<SetupState> {
  const { stores } = ctx;
  const setup = await stores.orderSetups.get(scope, location.id);
  const items = setup?.items ?? [];
  const ids = items.map((item) => item.id);
  const [coverage, days, latest, edited] = await Promise.all([
    stores.itemSales.coverage(scope, location.id),
    ids.length === 0 ? [] : stores.itemSales.days(scope, location.id, { from: addDays(today, -ITEM_SALES_DAYS), to: addDays(today, -1) }),
    stores.orderCounts.latest(scope, location.id, addDays(today, -COUNT_DAYS), ids),
    stores.orders.itemsWithEdits(scope, location.id, ids),
  ]);
  const recentSince = addDays(today, -MEAN_DAYS);
  const recent = days.filter((day) => day.date >= recentSince);
  const itemCoverage = Object.fromEntries(items.map((item) => [item.id, recent.filter((day) => (day.items[item.id] ?? 0) > 0).length]));
  const counts = Object.fromEntries(items.flatMap((item) => {
    const count = latest.get(item.id);
    return count === undefined ? [] : [[item.id, { quantity: count.quantity, date: count.date }]];
  }));
  const itemsWithHistory = ids.filter((id) =>
    latest.has(id) || edited.has(id) || days.some((day) => (day.items[id] ?? 0) > 0));
  return { setup, coverage, itemCoverage, counts, itemsWithHistory };
}
