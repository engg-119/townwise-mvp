// The live order board for a location (design Decision 5): reads its ordering setup, item sales, latest counts, the
// published guest forecast and its past guests, runs the engine, and applies the saved edits and active rules. A read:
// it writes nothing and logs nothing.
import type { TownwiseContext } from '../app.ts';
import type { OrgScope } from '../access/policy.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { localDay, localMinutes, timeZoneOf } from '../time-zones.ts';
import { liveBoard, unavailable, withPreferences, type OrderAnswer } from './board.ts';
import { addDays } from './dates.ts';
import { computeOrders } from './engine.ts';

/** Weekday means read 8 weeks back; past windows for the cushion add 26 weeks before that. */
const ITEM_SALES_DAYS = 238;
/** The 8 weeks the weekday means, the coverage and the guest index read. */
export const MEAN_DAYS = 56;
/** Counts older than this are not read: the board would order the par for them anyway. */
export const COUNT_DAYS = 90;
const FRESH_COUNT_DAYS = 7;
/** The forecast window read: today and the 30 days after, the reader's 31-day limit. */
const FORECAST_DAYS = 30;

/** The town's date and minutes since its midnight, now. */
export function townClock(ctx: TownwiseContext, location: LocationRecord): { today: string; nowMinutes: number } {
  const now = ctx.now();
  const { timeZone } = timeZoneOf(location.town);
  return { today: localDay(now, timeZone), nowMinutes: localMinutes(now, timeZone) };
}

/**
 * The location's board as of `today` and `nowMinutes` (the town's). Unavailable, naming what is missing, without a setup
 * or with a setup that has no supplier delivery or no item. `missing` on a board names 'item sales' when no day of the
 * last 8 weeks is covered, and 'a recent count' when no item of the setup was counted in the last 7 days.
 */
export async function loadBoard(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, today: string, nowMinutes: number,
): Promise<OrderAnswer> {
  const { stores } = ctx;
  const setup = await stores.orderSetups.get(scope, location.id);
  if (setup === null) return unavailable(['the supplier schedule', 'the items']);
  const lacking = [
    ...(setup.suppliers.some((supplier) => supplier.deliveries.length > 0) ? [] : ['the supplier schedule']),
    ...(setup.items.length > 0 ? [] : ['the items']),
  ];
  if (lacking.length > 0) return unavailable(lacking);

  const yesterday = addDays(today, -1);
  const [itemSales, counts, forecast, history, decisions, rules] = await Promise.all([
    stores.itemSales.days(scope, location.id, { from: addDays(today, -ITEM_SALES_DAYS), to: yesterday }),
    stores.orderCounts.latest(scope, location.id, addDays(today, -COUNT_DAYS)),
    ctx.ports.forecasts.window(scope, location, { from: today, to: addDays(today, FORECAST_DAYS) }, today),
    stores.salesDays.days(scope, location.id, { from: addDays(today, -MEAN_DAYS), to: yesterday }),
    stores.orders.listDecisions(scope, location.id),
    stores.orders.listRules(scope, location.id),
  ]);
  const forecastGuests = new Map(forecast.days.flatMap((day) => (day.mid === null ? [] : [[day.date, day.mid] as const])));
  const plans = computeOrders({
    suppliers: setup.suppliers,
    items: setup.items,
    itemSales,
    counts,
    forecastGuests,
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
  return withPreferences(
    liveBoard(plans, missing),
    decisions.map((row) => ({ itemId: row.itemId, delivery: row.delivery, quantity: row.quantity, reason: row.reason })),
    rules.map((row) => ({ id: row.id, itemId: row.itemId, delta: row.delta, situation: row.situation, off: row.off })),
  );
}

/** The board now, in the location's town. */
export function loadBoardNow(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord): Promise<OrderAnswer> {
  const { today, nowMinutes } = townClock(ctx, location);
  return loadBoard(ctx, scope, location, today, nowMinutes);
}
