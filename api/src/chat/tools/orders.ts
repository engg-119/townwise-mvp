// get_order_board, get_order_line, get_order_setup, propose_order_change, propose_order_rule (design Decision 9, the
// townwise-ai-orders spec). Appended at the end of the registry. Every read is the live board the Orders page shows
// (orders/live.ts), never the labeled sample, which only that page shows. The model names an item and a delivery and
// never types a quantity. Views carry ids, dates, booleans and counts, never a name, a quantity or a reason.
import { z } from 'zod';

import { isoDate } from '../../dates.ts';
import { findLine, type OrderBoard, type OrderLine, type SupplierOrder } from '../../orders/board.ts';
import { clockTime, WEEKDAYS } from '../../orders/dates.ts';
import { loadBoardNow, loadBoardWithSales, loadSetupState, townClock } from '../../orders/live.ts';
import { weekdayOf } from '../../time-zones.ts';
import type { ChatTool, ToolRun, ToolView } from './registry.ts';
import { DATE, NO_INPUT, viewOf } from './shared.ts';

export const ORDER_CHANGE_RESULT = 'Shown to the owner as a proposal. They decide the quantity and why.';
export const ORDER_RULE_RESULT = 'Shown to the owner as a proposal. They decide whether to remember the rule.';

/** How many of the latest covered days of an item's servings get_order_line returns. */
const RECENT_DAYS = 28;

const NO_SETUP = 'This location has no ordering setup yet. The owner adds the suppliers with their delivery and order-by days, and the items, on Orders, then Ordering setup.';
const NO_LINE = 'No order has a line for that item: it is not in this location’s ordering setup, or its supplier has no delivery days. get_order_board lists the items on each order.';
const NOT_NEXT = 'Nothing was shown to the owner. That item has no line on its supplier’s next order for that delivery. get_order_board gives each supplier’s next delivery.';
const RULE_NO_CHANGE = 'Nothing was shown to the owner. A rule adds a change the owner saved to every later order of the item, and this item has no saved change that differs from the recommended quantity.';
const RULE_EXISTS = 'Nothing was shown to the owner. This item already has a rule from its latest saved change, and it adds that change to every later order of the item until the owner turns it off.';
const RULE_OFF = 'Nothing was shown to the owner. The owner turned off the rule from this item’s latest saved change, which added it to every later order of the item, so it is not proposed again.';

/** A setup item's id: 24 lowercase hex characters. */
const itemId = z.string().regex(/^[0-9a-f]{24}$/);

const noInput = z.strictObject({});
const lineInput = z.strictObject({ itemId });
const changeInput = z.strictObject({ itemId, delivery: isoDate });
const ruleInput = z.strictObject({ itemId });

export type NoOrderInput = Record<string, never>;
export interface OrderLineInput { readonly itemId: string }
export interface OrderChangeInput { readonly itemId: string; readonly delivery: string }
export interface OrderRuleInput { readonly itemId: string }

const ITEM_ID = { type: 'string', description: 'The item’s id, as get_order_board or get_order_setup gives it.' } as const;

function parseNone(raw: unknown): NoOrderInput | null {
  return noInput.safeParse(raw).success ? {} : null;
}

/** Two decimals, so the model never repeats a falsely exact figure. */
function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function orderOf(order: SupplierOrder) {
  return {
    supplier: order.supplier, cutoff: order.cutoff, cutoffTime: order.cutoffTime, delivery: order.delivery,
    coversThrough: order.coversThrough, deadline: order.deadline,
  };
}

function boardLine(line: OrderLine) {
  return {
    itemId: line.itemId, name: line.name, unit: line.unit, neverRunOut: line.neverRunOut, recommended: line.recommended,
    alternative: line.alternative, par: line.par, onHand: line.onHand, countAgeDays: line.countAgeDays, confidence: line.confidence,
    why: line.why, edit: line.edit, rules: line.rules.map((rule) => ({ delta: rule.delta, situation: rule.situation })),
  };
}

function boardContent(board: OrderBoard): string {
  return JSON.stringify({
    available: true, missing: board.missing,
    orders: board.orders.map((order) => ({ ...orderOf(order), lines: order.lines.map(boardLine) })),
  });
}

function lineOf(board: OrderBoard, id: string): { order: SupplierOrder; line: OrderLine } | null {
  for (const order of board.orders) {
    const line = order.lines.find((candidate) => candidate.itemId === id);
    if (line !== undefined) return { order, line };
  }
  return null;
}

function notShown(reason: string): ToolRun {
  return { content: JSON.stringify({ shown: false, reason }) };
}

const unavailableResult = z.object({ available: z.literal(false) });
const boardResult = z.union([
  unavailableResult,
  z.object({ available: z.literal(true), orders: z.array(z.object({ cutoff: z.string(), lines: z.array(z.unknown()) })) }),
]);
const lineResult = z.union([
  unavailableResult,
  z.object({ available: z.literal(true), order: z.object({ delivery: z.string() }), line: z.object({ itemId: z.string() }) }),
]);
const setupResult = z.union([
  unavailableResult,
  z.object({
    available: z.literal(true),
    suppliers: z.array(z.unknown()),
    items: z.array(z.object({ latestCount: z.unknown() })),
    itemSalesCoverage: z.object({ dayCount: z.number() }).nullable(),
  }),
]);
const shownResult = z.object({ shown: z.literal(false) });

function shownView(content: string, shown: string): ToolView | null {
  return content === shown ? { shown: true } : viewOf(content, shownResult, () => ({ shown: false }));
}

export const orderBoardTool: ChatTool<NoOrderInput> = {
  definition: {
    name: 'get_order_board',
    description: 'This location’s next order from each supplier, as its Orders page shows it: the order-by date and time, the delivery, the supplier’s following delivery it lasts until, and a line per item with the recommended quantity in the unit the bar orders, the other deal size, the par, what is on hand and how many days ago it was counted, how sure Townwise is, why, the owner’s saved edit and every rule they confirmed. Returns available false, with what the ordering setup lacks, when this location has no order.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was read: this tool takes no input.',
  parse: parseNone,
  inputView: () => null,
  resultView: (content) => viewOf(content, boardResult, (board) => {
    if (!board.available) return { available: false };
    const [first] = board.orders;
    const lineCount = board.orders.reduce((sum, order) => sum + order.lines.length, 0);
    return { available: true, orderCount: board.orders.length, lineCount, ...(first === undefined ? {} : { cutoff: first.cutoff }) };
  }),
  async run(tc) {
    const board = await loadBoardNow(tc.ctx, tc.scope, tc.location);
    return { content: board.available ? boardContent(board) : JSON.stringify(board) };
  },
};

export const orderLineTool: ChatTool<OrderLineInput> = {
  definition: {
    name: 'get_order_line',
    description: 'One item’s line on its supplier’s next order, with the math behind it: mu (expected use over the window, in purchase units), sigma (the spread of past windows’ misses), orderUpTo (S, mu plus the cushion), the target chance of not running out, the deal size, the covered item-sales days used, what is on hand and the count’s age, how sure Townwise is, why, the saved edit and rules; the order’s dates; and the item’s servings on its latest covered item-sales days. Returns available false for an item not on an order.',
    input_schema: {
      type: 'object',
      properties: { itemId: ITEM_ID },
      required: ['itemId'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was read: itemId is an item’s id, and there are no other keys.',
  parse(raw) {
    const parsed = lineInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: (input) => ({ itemId: input.itemId }),
  resultView: (content) => viewOf(content, lineResult, (result) => (result.available
    ? { available: true, itemId: result.line.itemId, delivery: result.order.delivery }
    : { available: false })),
  async run(tc, input) {
    const { ctx, scope, location } = tc;
    const { today, nowMinutes } = townClock(ctx, location);
    // The days the board was built from, so the servings shown are the ones its line used, read once.
    const { answer: board, itemSales: sales } = await loadBoardWithSales(ctx, scope, location, today, nowMinutes);
    if (!board.available) return { content: JSON.stringify(board) };
    const found = lineOf(board, input.itemId);
    if (found === null) return { content: JSON.stringify({ available: false, reason: NO_LINE }) };
    const { order, line } = found;
    return {
      content: JSON.stringify({
        available: true, missing: board.missing, order: orderOf(order),
        line: {
          ...boardLine(line), mu: rounded(line.mu), sigma: rounded(line.sigma), orderUpTo: rounded(line.orderUpTo),
          target: line.target, dealSize: line.dealSize, coveredDays: line.coveredDays,
        },
        recentDays: sales.slice(-RECENT_DAYS).map((day) => ({
          date: day.date, weekday: weekdayOf(day.date), servings: day.items[line.itemId] ?? 0,
        })),
      }),
    };
  },
};

export const orderSetupTool: ChatTool<NoOrderInput> = {
  definition: {
    name: 'get_order_setup',
    description: 'What this location’s ordering setup holds: each supplier with its delivery days and the day and time to order by, and each item with its id, supplier, category, unit, servings per unit, par, deal size, whether it must never run out, its latest count and that count’s date, and how many covered days in the last eight weeks had any of its sales; and which days item sales cover. Returns available false when nothing is set up.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was read: this tool takes no input.',
  parse: parseNone,
  inputView: () => null,
  resultView: (content) => viewOf(content, setupResult, (result) => (result.available
    ? {
      available: true, supplierCount: result.suppliers.length, itemCount: result.items.length,
      countedItemCount: result.items.filter((item) => item.latestCount !== null).length,
      itemSalesDayCount: result.itemSalesCoverage?.dayCount ?? 0,
    }
    : { available: false })),
  async run(tc) {
    const { setup, coverage, itemCoverage, counts } = await loadSetupState(tc.ctx, tc.scope, tc.location, tc.today);
    if (setup === null) return { content: JSON.stringify({ available: false, reason: NO_SETUP }) };
    const supplierNames = new Map(setup.suppliers.map((supplier) => [supplier.id, supplier.name]));
    return {
      content: JSON.stringify({
        available: true,
        suppliers: setup.suppliers.map((supplier) => ({
          name: supplier.name,
          deliveries: supplier.deliveries.map((delivery) => ({
            delivery: WEEKDAYS[delivery.deliveryWeekday] ?? null,
            orderBy: WEEKDAYS[delivery.cutoffWeekday] ?? null,
            orderByTime: clockTime(delivery.cutoffTime),
          })),
        })),
        // Point-of-sale names stay out: they are how the bar's register names things, and may name a person.
        items: setup.items.map((item) => ({
          id: item.id, name: item.name, supplier: supplierNames.get(item.supplierId) ?? null, category: item.category, unit: item.unit,
          servingsPerUnit: item.servingsPerUnit, par: item.par, dealSize: item.dealSize, neverRunOut: item.neverRunOut,
          latestCount: counts[item.id] ?? null, daysWithSales: itemCoverage[item.id] ?? 0,
        })),
        itemSalesCoverage: coverage,
      }),
    };
  },
};

export const proposeOrderChangeTool: ChatTool<OrderChangeInput> = {
  definition: {
    name: 'propose_order_change',
    description: 'Shows the owner a card to change one line of its supplier’s next order: they type the quantity and why, then save or dismiss it. It never saves the change and never places an order. It names the item and that order’s delivery date, from get_order_board, and never a quantity. It shows nothing when the item has no line on its supplier’s next order for that delivery.',
    input_schema: {
      type: 'object',
      properties: { itemId: ITEM_ID, delivery: DATE },
      required: ['itemId', 'delivery'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was shown to the owner: itemId is an item’s id, delivery is a calendar date, and there are no other keys.',
  parse(raw) {
    const parsed = changeInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: (input) => ({ itemId: input.itemId, delivery: input.delivery }),
  resultView: (content) => shownView(content, ORDER_CHANGE_RESULT),
  async run(tc, input) {
    const board = await loadBoardNow(tc.ctx, tc.scope, tc.location);
    if (!board.available) return notShown(`Nothing was shown to the owner. ${board.reason}`);
    return findLine(board, input.delivery, input.itemId) === null ? notShown(NOT_NEXT) : { content: ORDER_CHANGE_RESULT };
  },
};

export const proposeOrderRuleTool: ChatTool<OrderRuleInput> = {
  definition: {
    name: 'propose_order_rule',
    description: 'Shows the owner a card to remember the latest change they saved for one item, with their reason, as a rule. A rule adds that change to every later order of the item until the owner turns it off. It never invents the amount or the situation, and it never saves the rule. Call it only after they saved a change whose reason could apply again; a one-off reason gets no card. It shows nothing without a saved change that differs from the recommended quantity, or when that change already has a rule.',
    input_schema: {
      type: 'object',
      properties: { itemId: ITEM_ID },
      required: ['itemId'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was shown to the owner: itemId is an item’s id, and there are no other keys.',
  parse(raw) {
    const parsed = ruleInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: (input) => ({ itemId: input.itemId }),
  resultView: (content) => shownView(content, ORDER_RULE_RESULT),
  async run(tc, input) {
    const { orders } = tc.ctx.stores;
    const decision = await orders.latestDecision(tc.scope, tc.location.id, input.itemId);
    if (decision === null || decision.quantity === decision.recommended) return notShown(RULE_NO_CHANGE);
    const existing = await orders.findRule(tc.scope, tc.location.id, input.itemId, decision.reason);
    if (existing !== null) return notShown(existing.off ? RULE_OFF : RULE_EXISTS);
    return { content: ORDER_RULE_RESULT };
  },
};
