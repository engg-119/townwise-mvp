// get_order_board, get_order_line, propose_order_change, propose_order_rule. Appended at the end of the registry.
// The model names an item and a delivery. It does not type a quantity. Views are dates and counts, never a figure.
import { z } from 'zod';

import { findLine, ORDER_UNAVAILABLE, sampleBoard, type OrderBoard, type OrderLine, type SupplierOrder } from '../../orders/board.ts';
import type { ChatTool, ToolContext } from './registry.ts';

export const ORDER_CHANGE_RESULT = 'Shown to the owner as a proposal. They decide the quantity and why.';
export const ORDER_RULE_RESULT = 'Shown to the owner as a proposal. They decide whether to remember the rule.';

const NOT_SHOWN = 'Nothing was shown to the owner. A labeled sample cannot be saved, and this location has no order of its own.';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const itemId = z.string().trim().min(1).max(80);

const boardInput = z.strictObject({ delivery: date.optional() });
const lineInput = z.strictObject({ itemId, delivery: date });
const changeInput = z.strictObject({ itemId, delivery: date });
const ruleInput = z.strictObject({ itemId });

export interface OrderBoardInput { readonly delivery?: string }
export interface OrderLineInput { readonly itemId: string; readonly delivery: string }
export interface OrderChangeInput { readonly itemId: string; readonly delivery: string }
export interface OrderRuleInput { readonly itemId: string }

interface ModelLine {
  readonly itemId: string;
  readonly name: string;
  readonly supplier: string;
  readonly unit: string;
  readonly neverRunOut: boolean;
  readonly recommended: number;
  readonly alternative: number | null;
  readonly par: number;
  readonly mu: number | null;
  readonly sigma: number | null;
  readonly onHand: number | null;
  readonly countAgeDays: number | null;
  readonly confidence: string;
  readonly why: string;
  readonly sample: boolean;
  readonly edit: { readonly quantity: number; readonly reason: string } | null;
  readonly rules: readonly { readonly delta: number; readonly situation: string }[];
}

function modelLine(line: OrderLine): ModelLine {
  return {
    itemId: line.itemId,
    name: line.name,
    supplier: line.supplier,
    unit: line.unit,
    neverRunOut: line.neverRunOut,
    recommended: line.recommended,
    alternative: line.alternative,
    par: line.par,
    mu: line.mu,
    sigma: line.sigma,
    onHand: line.onHand,
    countAgeDays: line.countAgeDays,
    confidence: line.confidence,
    why: line.why,
    sample: line.sample,
    edit: line.edit,
    rules: line.rules.map((rule) => ({ delta: rule.delta, situation: rule.situation })),
  };
}

function modelOrder(order: SupplierOrder): Record<string, unknown> {
  return {
    supplier: order.supplier,
    cutoff: order.cutoff,
    cutoffTime: order.cutoffTime,
    delivery: order.delivery,
    coversThrough: order.coversThrough,
    deadline: order.deadline,
    lines: order.lines.map(modelLine),
  };
}

function modelBoard(board: OrderBoard): string {
  return JSON.stringify({ available: true, sample: board.sample, missing: board.missing, orders: board.orders.map(modelOrder) });
}

function unavailable(): string {
  return JSON.stringify({ available: false, reason: ORDER_UNAVAILABLE });
}

function boardView(content: string): { available: boolean; sample?: boolean; delivery?: string; lineCount?: number } | null {
  try {
    const parsed = JSON.parse(content) as { available?: unknown; sample?: unknown; orders?: unknown };
    if (parsed.available === false) return { available: false };
    if (parsed.available !== true || !Array.isArray(parsed.orders)) return null;
    const orders = parsed.orders as { delivery?: unknown; lines?: unknown }[];
    const delivery = orders[0]?.delivery;
    const lineCount = orders.reduce((sum, order) => sum + (Array.isArray(order.lines) ? order.lines.length : 0), 0);
    return { available: true, sample: parsed.sample === true, ...(typeof delivery === 'string' ? { delivery } : {}), lineCount };
  } catch {
    return null;
  }
}

function shownView(content: string, shown: string): { shown: boolean } | null {
  if (content === shown) return { shown: true };
  try {
    const parsed = JSON.parse(content) as { shown?: unknown };
    return parsed.shown === false ? { shown: false } : null;
  } catch {
    return null;
  }
}

export const orderBoardTool: ChatTool<OrderBoardInput> = {
  definition: {
    name: 'get_order_board',
    description: 'The next order for this location: the cutoff, the days the delivery covers, and each line in the units the bar orders. Returns available false when this location has no order. Pass delivery only to read the labeled sample for that delivery date. A sample is not this location\'s stock.',
    input_schema: {
      type: 'object',
      properties: { delivery: { type: 'string', description: 'YYYY-MM-DD, only for the labeled sample.' } },
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was read: delivery is a calendar date, and there are no other keys.',
  parse(raw) {
    const parsed = boardInput.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data.delivery === undefined ? {} : { delivery: parsed.data.delivery };
  },
  inputView: (input) => (input.delivery === undefined ? {} : { delivery: input.delivery }),
  resultView: (content) => boardView(content),
  run(tc, input) {
    return Promise.resolve({ content: boardContent(tc, input.delivery) });
  },
};

function boardContent(tc: ToolContext, delivery: string | undefined): string {
  if (delivery === undefined) return unavailable();
  const board = sampleBoard(tc.today);
  return board.orders.some((order) => order.delivery === delivery) ? modelBoard(board) : unavailable();
}

export const orderLineTool: ChatTool<OrderLineInput> = {
  definition: {
    name: 'get_order_line',
    description: 'One line of an order: the same quantity and deal size as the board, plus why, what is on hand, and any saved edit or confirmed rule. A labeled sample says sample true. It does not invent a line.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        delivery: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['itemId', 'delivery'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was read: itemId and delivery, and no other keys.',
  parse(raw) {
    const parsed = lineInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: ({ itemId: id, delivery }) => ({ itemId: id, delivery }),
  resultView: (content) => {
    const view = boardView(content);
    if (view === null) return null;
    if (!view.available) return { available: false };
    return { available: true, sample: view.sample === true, ...(view.delivery === undefined ? {} : { delivery: view.delivery }) };
  },
  run(tc, input) {
    const board = sampleBoard(tc.today);
    const found = findLine(board, input.delivery, input.itemId);
    if (found === null) return Promise.resolve({ content: unavailable() });
    return Promise.resolve({ content: modelBoard({ ...board, orders: [{ ...found.order, lines: [found.line] }] }) });
  },
};

export const proposeOrderChangeTool: ChatTool<OrderChangeInput> = {
  definition: {
    name: 'propose_order_change',
    description: 'Shows the owner a card to change one line\'s quantity and say why. It never saves the change and never places an order. It names the item and the delivery and does not include a quantity. It shows nothing for a labeled sample or when this location has no order.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        delivery: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['itemId', 'delivery'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was shown to the owner: itemId and delivery, and no other keys.',
  parse(raw) {
    const parsed = changeInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: ({ itemId: id, delivery }) => ({ itemId: id, delivery }),
  resultView: (content) => shownView(content, ORDER_CHANGE_RESULT),
  run() {
    // A live line is the only one that can be changed, and a sample cannot be saved. The tools task reads the live board.
    return Promise.resolve({ content: JSON.stringify({ shown: false, reason: NOT_SHOWN }) });
  },
};

export const proposeOrderRuleTool: ChatTool<OrderRuleInput> = {
  definition: {
    name: 'propose_order_rule',
    description: 'Shows the owner a card remembering a rule from a change they already saved, in their words. It never invents the amount or the situation, and it never saves the rule. Call it only after they gave a reason that could apply again. A one-off reason gets no card.',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' } },
      required: ['itemId'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was shown to the owner: itemId, and no other keys.',
  parse(raw) {
    const parsed = ruleInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: ({ itemId: id }) => ({ itemId: id }),
  resultView: (content) => shownView(content, ORDER_RULE_RESULT),
  async run(tc, input) {
    const decision = await tc.ctx.stores.orders.latestDecision(tc.scope, tc.location.id, input.itemId);
    if (decision === null) return { content: JSON.stringify({ shown: false, reason: NOT_SHOWN }) };
    const existing = await tc.ctx.stores.orders.findRule(tc.scope, tc.location.id, input.itemId, decision.reason);
    if (existing?.off === true || decision.quantity === decision.recommended) {
      return { content: JSON.stringify({ shown: false, reason: NOT_SHOWN }) };
    }
    return { content: ORDER_RULE_RESULT };
  },
};
