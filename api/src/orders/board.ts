// The order board the Orders page and TownwiseAI both read: one next order per supplier (design Decision 2), each line
// computed by engine.ts from the location's setup, item sales and counts (orders/live.ts reads them). The sample is a
// labeled preview in the same shape, not that location's stock; rules and saved edits never change it.
import { addDays, clockTime, lastsUntil, shortDate, weekdayName } from './dates.ts';
import {
  MAX_QUANTITY, targetFor, unitFor, type EngineLine, type OrderCategory, type OrderUnit, type SupplierOrderPlan,
} from './engine.ts';

export type OrderConfidence = 'high' | 'medium' | 'low';

export interface OrderEdit {
  readonly quantity: number;
  readonly reason: string;
}

export interface OrderRuleView {
  readonly id: string;
  readonly delta: number;
  readonly situation: string;
}

export interface OrderLine {
  readonly itemId: string;
  readonly name: string;
  readonly supplier: string;
  readonly unit: OrderUnit;
  readonly neverRunOut: boolean;
  readonly recommended: number;
  readonly alternative: number | null;
  /** The par the quantity used: for a draft item one more than the owner's when the window uses more than one unit. */
  readonly par: number;
  /** The owner's par, as the setup holds it. */
  readonly setupPar: number;
  /** Window demand in purchase units; null without item sales for the window's weekdays. */
  readonly mu: number | null;
  /** Spread of past window errors in purchase units; null under 2 past windows. */
  readonly sigma: number | null;
  /** The order-up-to level S = mu + z x (sigma or 0); null without mu. */
  readonly orderUpTo: number | null;
  /** The chance of not running out the quantity aims for. */
  readonly target: number;
  readonly onHand: number | null;
  readonly countAgeDays: number | null;
  readonly confidence: OrderConfidence;
  readonly dealSize: number | null;
  /** Covered item-sales days in the 8 weeks before today. */
  readonly coveredDays: number;
  readonly why: string;
  readonly sample: boolean;
  readonly edit: OrderEdit | null;
  /** Every active rule for the item, each turned off on its own. */
  readonly rules: readonly OrderRuleView[];
}

export interface SupplierOrder {
  readonly supplierId: string;
  readonly supplier: string;
  /** The order-by date, and its time (HH:MM, the town's zone). */
  readonly cutoff: string;
  readonly cutoffTime: string;
  readonly delivery: string;
  /** The supplier's following delivery, which this order lasts until. */
  readonly coversThrough: string;
  readonly deadline: string;
  readonly lines: readonly OrderLine[];
}

export interface OrderBoard {
  readonly available: true;
  readonly sample: boolean;
  /** What the board lacks: 'item sales', 'a recent count'. */
  readonly missing: readonly string[];
  /** By cutoff. */
  readonly orders: readonly SupplierOrder[];
}

export interface OrderUnavailable {
  readonly available: false;
  readonly reason: string;
  /** What the setup lacks: 'the supplier schedule', 'the items'. */
  readonly missing: readonly string[];
}

export type OrderAnswer = OrderBoard | OrderUnavailable;

export interface StoredDecision {
  readonly itemId: string;
  readonly delivery: string;
  readonly quantity: number;
  /** The line's unit when it was saved: an edit in another unit than the line's now is not shown. */
  readonly unit: string;
  readonly reason: string;
}

export interface StoredRule {
  readonly id: string;
  readonly itemId: string;
  readonly delta: number;
  /** The unit its amount is in: a rule in another unit than the line's now does not apply. */
  readonly unit: string;
  readonly situation: string;
  readonly off: boolean;
}

export const ORDER_UNAVAILABLE = 'Townwise can’t build an order for this location until its ordering setup has a supplier schedule and items.';

export function unavailable(missing: readonly string[]): OrderUnavailable {
  return { available: false, reason: ORDER_UNAVAILABLE, missing: [...missing] };
}

/** 'Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.' */
export function deadline(order: Pick<SupplierOrder, 'cutoff' | 'cutoffTime' | 'delivery' | 'coversThrough'>): string {
  return `Order by ${shortDate(order.cutoff)}, ${clockTime(order.cutoffTime)}. ${lastsUntil(order.delivery, order.coversThrough)}`;
}

/** The engine's plans as the board: a line per item, no edits and no rules yet (withPreferences adds them). */
export function liveBoard(plans: readonly SupplierOrderPlan[], missing: readonly string[]): OrderBoard {
  return {
    available: true,
    sample: false,
    missing: [...missing],
    orders: plans.map((plan): SupplierOrder => ({
      supplierId: plan.supplierId,
      supplier: plan.supplier,
      cutoff: plan.cutoff,
      cutoffTime: plan.cutoffTime,
      delivery: plan.delivery,
      coversThrough: plan.coversThrough,
      deadline: deadline(plan),
      lines: plan.lines.map((line: EngineLine): OrderLine => ({ ...line, sample: false, edit: null, rules: [] })),
    })),
  };
}

const SAMPLE_CUTOFF_TIME = '14:00';
const SAMPLE_CUTOFF_MINUTES = 14 * 60;

/**
 * The next Wednesday order-by at 2:00pm not yet passed at `nowMinutes` (the town's), the Thursday delivery, and the
 * Monday that delivery covers through.
 */
export function sampleSchedule(today: string, nowMinutes: number): { cutoff: string; delivery: string; coversThrough: string } {
  let cutoff = nowMinutes >= SAMPLE_CUTOFF_MINUTES ? addDays(today, 1) : today;
  while (weekdayName(cutoff) !== 'Wednesday') cutoff = addDays(cutoff, 1);
  const delivery = addDays(cutoff, 1);
  return { cutoff, delivery, coversThrough: addDays(delivery, 4) };
}

interface SampleItem {
  readonly itemId: string;
  readonly name: string;
  readonly supplierId: string;
  readonly supplier: string;
  readonly category: OrderCategory;
  readonly unit: OrderUnit;
  readonly neverRunOut: boolean;
  readonly par: number;
}

const SAMPLE_ITEMS: readonly SampleItem[] = [
  {
    itemId: 'sample-lager', name: 'Sample lager', supplierId: 'sample-distributor', supplier: 'Sample distributor', category: 'bottles_cans',
    unit: 'cases', neverRunOut: true, par: 8,
  },
  {
    itemId: 'sample-seltzer', name: 'Sample seltzer', supplierId: 'sample-distributor', supplier: 'Sample distributor', category: 'bottles_cans',
    unit: 'cases', neverRunOut: false, par: 3,
  },
  {
    itemId: 'sample-keg', name: 'Sample keg', supplierId: 'sample-brewery', supplier: 'Sample brewery', category: 'draft',
    unit: 'kegs', neverRunOut: true, par: 2,
  },
];

/**
 * The labeled preview: an order per sample supplier, every line at the par with no deal size and so no other deal
 * option. Rules and saved edits do not change it, and nothing on it can be saved.
 */
export function sampleBoard(today: string, nowMinutes: number): OrderBoard {
  const schedule = { ...sampleSchedule(today, nowMinutes), cutoffTime: SAMPLE_CUTOFF_TIME };
  const why = `${lastsUntil(schedule.delivery, schedule.coversThrough)} No count, so this is the par.`;
  const suppliers = [...new Map(SAMPLE_ITEMS.map((item) => [item.supplierId, item.supplier])).entries()]
    .sort(([, a], [, b]) => a.localeCompare(b));
  const orders = suppliers.map(([supplierId, supplier]): SupplierOrder => ({
    supplierId,
    supplier,
    ...schedule,
    deadline: deadline(schedule),
    lines: sortLines(SAMPLE_ITEMS.filter((item) => item.supplierId === supplierId).map((item): OrderLine => ({
      itemId: item.itemId,
      name: item.name,
      supplier: item.supplier,
      unit: item.unit,
      neverRunOut: item.neverRunOut,
      recommended: item.par,
      alternative: null,
      par: item.par,
      setupPar: item.par,
      mu: null,
      sigma: null,
      orderUpTo: null,
      target: targetFor(item).target,
      onHand: null,
      countAgeDays: null,
      confidence: 'low',
      dealSize: null,
      coveredDays: 0,
      why,
      sample: true,
      edit: null,
      rules: [],
    }))),
  }));
  return { available: true, sample: true, missing: ['item sales', 'a recent count', 'the supplier schedule'], orders };
}

function sortLines(lines: readonly OrderLine[]): OrderLine[] {
  return [...lines].sort((a, b) => Number(b.neverRunOut) - Number(a.neverRunOut) || a.name.localeCompare(b.name));
}

/** The newest edit per item for this delivery, with the unit it was saved in; `decisions` come newest first. */
function latestEdits(decisions: readonly StoredDecision[], delivery: string): Map<string, StoredDecision> {
  const found = new Map<string, StoredDecision>();
  for (const decision of decisions) {
    if (decision.delivery !== delivery || found.has(decision.itemId)) continue;
    found.set(decision.itemId, decision);
  }
  return found;
}

function activeRules(rules: readonly StoredRule[]): Map<string, StoredRule[]> {
  const found = new Map<string, StoredRule[]>();
  for (const rule of rules) {
    if (rule.off) continue;
    const list = found.get(rule.itemId) ?? [];
    list.push(rule);
    found.set(rule.itemId, list);
  }
  return found;
}

function amountOf(size: number, unit: OrderUnit): string {
  return `${String(size)} ${unitFor(size, unit)}`;
}

/** 'Includes 2 extra cases from your rule: a football weekend.' The situation is the owner's own words. */
function ruleSentence(delta: number, unit: OrderUnit, situation: string): string {
  const size = Math.abs(delta);
  const words = situation.replace(/[.!?]+$/, '');
  return delta < 0
    ? `Leaves out ${amountOf(size, unit)} from your rule: ${words}.`
    : `Includes ${String(size)} extra ${unitFor(size, unit)} from your rule: ${words}.`;
}

/** What the rules did: the quantity they leave, and, when 0 or 999 stopped them, the change they could make. */
function rulesOutcome(before: number, after: number, delta: number, count: number, unit: OrderUnit): string {
  const yours = count === 1 ? 'your rule' : 'your rules';
  const order = `With ${yours}, the order is ${amountOf(after, unit)}`;
  if (after === before + delta) return `${order}.`;
  if (after === 0) return before === 0 ? `${order}: there was nothing to leave out.` : `${order}: only ${amountOf(before, unit)} could come off.`;
  return `${order}: a line holds at most ${String(MAX_QUANTITY)}.`;
}

/**
 * Each order's lines with the latest edit saved for that order's delivery, and every active rule of the item (design
 * Decision 6): each rule is listed on its own, and together they move the recommended quantity, never below 0 or past
 * 999, and the why line ends with the quantity they leave. A line that a rule moves has no other deal option, which
 * was priced for the quantity before the rule. A rule applies to every order of its item until it is turned off. An
 * edit or a rule saved in another unit than the line's now (the setup changed the item's unit) is left out. A sample
 * is returned unchanged.
 */
export function withPreferences(board: OrderBoard, decisions: readonly StoredDecision[], rules: readonly StoredRule[]): OrderBoard {
  if (board.sample) return board;
  const byItem = activeRules(rules);
  const orders = board.orders.map((order) => {
    const edits = latestEdits(decisions, order.delivery);
    const lines = order.lines.map((line): OrderLine => {
      const applied = (byItem.get(line.itemId) ?? []).filter((rule) => rule.unit === line.unit);
      const edit = edits.get(line.itemId);
      const shown = edit?.unit === line.unit ? { quantity: edit.quantity, reason: edit.reason } : null;
      const rules = applied.map((rule) => ({ id: rule.id, delta: rule.delta, situation: rule.situation }));
      if (applied.length === 0) return { ...line, edit: shown, rules };
      const delta = applied.reduce((sum, rule) => sum + rule.delta, 0);
      const recommended = Math.min(MAX_QUANTITY, Math.max(0, line.recommended + delta));
      const sentences = applied.map((rule) => ruleSentence(rule.delta, line.unit, rule.situation));
      return {
        ...line,
        recommended,
        alternative: null,
        why: [line.why, ...sentences, rulesOutcome(line.recommended, recommended, delta, applied.length, line.unit)].join(' '),
        edit: shown,
        rules,
      };
    });
    return { ...order, lines };
  });
  return { ...board, orders };
}

/** The order and line for this item and delivery on the board, or null. A line is never invented. */
export function findLine(board: OrderBoard, delivery: string, itemId: string): { order: SupplierOrder; line: OrderLine } | null {
  for (const order of board.orders) {
    if (order.delivery !== delivery) continue;
    const line = order.lines.find((candidate) => candidate.itemId === itemId);
    if (line !== undefined) return { order, line };
  }
  return null;
}
