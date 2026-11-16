// What the order board is built from (design Decisions 3, 4 and 8; the order-setup, item-sales and order-counts specs):
// GET and PUT .../orders/setup, POST and DELETE .../orders/item-sales, POST .../orders/counts. Every member edits the
// setup, uploads item sales and saves counts; an org admin's item sales upload replaces its range and a member's adds
// only days not already stored; only an org admin deletes item sales; view-as is read-only through the chain. Nothing
// here logs, and audit details carry ids, dates and counts only: never an item or supplier name, a point-of-sale name,
// servings or a quantity.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { daysBetween, EARLIEST_DATE, isoDate } from '../dates.ts';
import { addDays } from '../orders/dates.ts';
import { loadSetupState, townClock } from '../orders/live.ts';
import { checkSetup, mintIds, setupInput } from '../orders/setup.ts';
import type { StoredSetup } from '../stores/order-setups.ts';
import { loadLocation, memberOf } from './locations.ts';
import { canReadWithAi } from './order-setup-read.ts';
import { actorOf, orgAdmin } from './team.ts';

const setupBody = z.strictObject({
  /** The version the editor loaded; 0 when the location had no setup. */
  expectedVersion: z.number().int().min(0),
  setup: setupInput,
});

/** An upload chunk: at most 31 days, each a date inside [from, to] and sent once. */
const MAX_UPLOAD_DAYS = 31;
const MAX_ITEMS_PER_DAY = 500;

/**
 * Item sales for the range [from, to], at most 31 days long and ending before `today` (the town's): today is still
 * open, so its sales are not all in yet. What the store does with them depends on the caller (uploadItemSales).
 */
function itemSalesBody(today: string) {
  const day = z.strictObject({
    date: isoDate,
    items: z.record(z.string(), z.number().min(0).max(100_000))
      .refine((items) => Object.keys(items).length <= MAX_ITEMS_PER_DAY),
  });
  return z.strictObject({ from: isoDate, to: isoDate, days: z.array(day).max(MAX_UPLOAD_DAYS) }).refine(({ from, to, days }) =>
    from >= EARLIEST_DATE && from <= to && to < today && daysBetween(from, to) < MAX_UPLOAD_DAYS
    && new Set(days.map((sent) => sent.date)).size === days.length && days.every((sent) => sent.date >= from && sent.date <= to));
}

/** How far back a count may be dated, in days before the town's today. */
const COUNT_BACK_DAYS = 14;

/** A count dated from 14 days before `today` through `today`: 1 to 300 items, 0 to 9,999 purchase units in steps of 0.5. */
function countBody(today: string) {
  const earliest = addDays(today, -COUNT_BACK_DAYS);
  return z.strictObject({
    date: isoDate.refine((date) => date >= earliest && date <= today),
    items: z.record(z.string(), z.number().min(0).max(9999).refine((quantity) => Number.isInteger(quantity * 2)))
      .refine((items) => Object.keys(items).length >= 1 && Object.keys(items).length <= 300),
  });
}

/** 400 `unknown_item` unless every id names an item of the setup. */
function assertKnownItems(setup: StoredSetup | null, ids: readonly string[]): void {
  const known = new Set(setup?.items.map((item) => item.id));
  if (!ids.every((id) => known.has(id))) {
    throw new AppError(400, 'unknown_item', 'An item is not in this location’s ordering setup. Reload the setup and try again.');
  }
}

/**
 * GET .../orders/setup: the setup (null when none was saved), item-sales coverage, each item's covered days with any
 * servings in the last 8 weeks, each item's latest count in the last 400 days, `today`, the town's date, and
 * `canReadWithAi`, whether reading the setup with TownwiseAI is on (D41; the page shows its section only then).
 */
export async function getOrderSetup(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const { today } = townClock(ctx, location);
  res.status(200).json({ ...(await loadSetupState(ctx, scope, location, today)), today, canReadWithAi: canReadWithAi(ctx) });
}

/** PUT .../orders/setup { expectedVersion, setup }: the whole setup, saved only over the version the editor loaded. */
export async function saveOrderSetup(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const body = parseInput(setupBody, req.body);
  const problem = checkSetup(body.setup);
  if (problem !== null) throw new AppError(400, 'invalid_request', problem);
  const now = ctx.now();
  const saved = await ctx.stores.orderSetups.save(scope, location.id, body.expectedVersion, mintIds(body.setup), now);
  if (saved === 'changed') {
    throw new AppError(409, 'setup_changed', 'Someone saved this ordering setup since you opened it. Reload it to see their changes.');
  }
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'order.setup_saved',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, supplierCount: saved.suppliers.length, itemCount: saved.items.length },
  });
  res.status(200).json({ setup: saved });
}

/**
 * POST .../orders/item-sales { from, to, days }: servings per setup item per day, matched in the browser. As with sales
 * uploads (D16), an org admin's (staff opened as admin included) replaces: the sent days are stored and the range's
 * stored days it did not send are deleted. A member's adds only the days not already stored, deletes nothing and
 * reports the rest as `kept`, so a member can't clear what the org admin-only DELETE guards.
 * [CONFIRM: members add only item-sales days not already stored; org admins replace]
 */
export async function uploadItemSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const body = parseInput(itemSalesBody(townClock(ctx, location).today), req.body);
  const itemIds = [...new Set(body.days.flatMap((day) => Object.keys(day.items)))];
  assertKnownItems(await ctx.stores.orderSetups.get(scope, location.id), itemIds);
  const now = ctx.now();
  const result = await ctx.stores.itemSales.apply(scope, location.id, {
    from: body.from, to: body.to, days: body.days, now, replace: caller.role === 'org_admin',
  });
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'order.item_sales_uploaded',
    target: { type: 'location', id: location.id },
    details: {
      locationId: location.id, dayCount: body.days.length, itemCount: itemIds.length, firstDate: body.from, lastDate: body.to,
      removedCount: result.removed, keptCount: result.kept,
    },
  });
  res.status(200).json(result);
}

/** DELETE .../orders/item-sales: every item-sales day of the location. The setup and counts stay. */
export async function deleteItemSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const removed = await ctx.stores.itemSales.removeForLocation(scope, location.id);
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'order.item_sales_deleted',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, dayCount: removed },
  });
  res.status(200).json({ removed });
}

/** POST .../orders/counts { date, items }: each sent item's quantity on hand that day; items counted before stay. */
export async function saveOrderCount(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const body = parseInput(countBody(townClock(ctx, location).today), req.body);
  const itemIds = Object.keys(body.items);
  assertKnownItems(await ctx.stores.orderSetups.get(scope, location.id), itemIds);
  const now = ctx.now();
  await ctx.stores.orderCounts.save(scope, location.id, body.date, body.items, now);
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'order.count_saved',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, date: body.date, itemCount: itemIds.length },
  });
  res.status(204).end();
}
