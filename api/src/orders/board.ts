// The order board the Orders page and TownwiseAI both read. A location with no item sales, count, or supplier
// schedule has no board. The sample is a labeled preview, not that location's stock, and it is not built from
// ground_truth. This version does not compute S = μ_W + z·σ_W. The fields are here so a later board can.

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
  readonly unit: string;
  readonly neverRunOut: boolean;
  readonly recommended: number;
  readonly alternative: number | null;
  readonly par: number;
  /** Window demand in purchase units, once item history exists. Null until then. */
  readonly mu: number | null;
  /** Window-total error in purchase units. Null until item history exists. */
  readonly sigma: number | null;
  readonly onHand: number | null;
  readonly countAgeDays: number | null;
  readonly confidence: OrderConfidence;
  readonly why: string;
  readonly sample: boolean;
  readonly edit: OrderEdit | null;
  readonly rule: OrderRuleView | null;
}

export interface OrderBoard {
  readonly available: true;
  readonly sample: boolean;
  readonly cutoff: string;
  readonly delivery: string;
  readonly coversThrough: string;
  readonly deadline: string;
  readonly missing: readonly string[];
  readonly lines: readonly OrderLine[];
}

export interface OrderUnavailable {
  readonly available: false;
  readonly reason: string;
}

export type OrderAnswer = OrderBoard | OrderUnavailable;

export interface StoredDecision {
  readonly itemId: string;
  readonly delivery: string;
  readonly quantity: number;
  readonly reason: string;
}

export interface StoredRule {
  readonly id: string;
  readonly itemId: string;
  readonly delta: number;
  readonly situation: string;
  readonly off: boolean;
}

export const ORDER_UNAVAILABLE = 'Townwise can’t see this location’s item sales, a recent count, or its supplier schedule.';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A calendar date, read as UTC so a weekday does not depend on the server's zone. */
function at(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function addDays(iso: string, days: number): string {
  const date = at(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekday(iso: string): string {
  return WEEKDAYS[at(iso).getUTCDay()] ?? '';
}

function shortDate(iso: string): string {
  const date = at(iso);
  return `${SHORT_WEEKDAYS[date.getUTCDay()] ?? ''}, ${SHORT_MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
}

/** The next Wednesday on or after `today`, the Thursday delivery, and the Monday that delivery covers through. */
export function sampleSchedule(today: string): { cutoff: string; delivery: string; coversThrough: string } {
  let cutoff = today;
  while (at(cutoff).getUTCDay() !== 3) cutoff = addDays(cutoff, 1);
  const delivery = addDays(cutoff, 1);
  return { cutoff, delivery, coversThrough: addDays(delivery, 4) };
}

function deadline(schedule: { cutoff: string; delivery: string; coversThrough: string }): string {
  return `Order by ${shortDate(schedule.cutoff)}, 2:00pm. ${weekday(schedule.delivery)}’s delivery covers through ${weekday(schedule.coversThrough)}.`;
}

interface SampleItem {
  readonly itemId: string;
  readonly name: string;
  readonly supplier: string;
  readonly unit: string;
  readonly neverRunOut: boolean;
  readonly par: number;
  readonly alternative: number;
}

const SAMPLE_ITEMS: readonly SampleItem[] = [
  { itemId: 'sample-lager', name: 'Sample lager', supplier: 'Sample distributor', unit: 'cases', neverRunOut: true, par: 8, alternative: 6 },
  { itemId: 'sample-seltzer', name: 'Sample seltzer', supplier: 'Sample distributor', unit: 'cases', neverRunOut: false, par: 3, alternative: 6 },
  { itemId: 'sample-keg', name: 'Sample keg', supplier: 'Sample brewery', unit: 'kegs', neverRunOut: true, par: 2, alternative: 1 },
];

function sampleWhy(schedule: { delivery: string; coversThrough: string }): string {
  return `${weekday(schedule.delivery)}’s delivery covers through ${weekday(schedule.coversThrough)}. No count, so this is the par.`;
}

/** The labeled preview. Rules and saved edits do not change it, and nothing on it can be saved. */
export function sampleBoard(today: string): OrderBoard {
  const schedule = sampleSchedule(today);
  const why = sampleWhy(schedule);
  const lines = SAMPLE_ITEMS.map((item): OrderLine => ({
    itemId: item.itemId,
    name: item.name,
    supplier: item.supplier,
    unit: item.unit,
    neverRunOut: item.neverRunOut,
    recommended: item.par,
    alternative: item.alternative,
    par: item.par,
    mu: null,
    sigma: null,
    onHand: null,
    countAgeDays: null,
    confidence: 'low',
    why,
    sample: true,
    edit: null,
    rule: null,
  }));
  return {
    available: true,
    sample: true,
    ...schedule,
    deadline: deadline(schedule),
    missing: ['item sales', 'a recent count', 'the supplier schedule'],
    lines: sortLines(lines),
  };
}

/** This version has no live board. Item history, a count, and a schedule fill one later. */
export function liveBoard(): null {
  return null;
}

export function unavailable(): OrderUnavailable {
  return { available: false, reason: ORDER_UNAVAILABLE };
}

function sortLines(lines: readonly OrderLine[]): OrderLine[] {
  return [...lines].sort((a, b) => Number(b.neverRunOut) - Number(a.neverRunOut) || a.name.localeCompare(b.name));
}

function latestEdits(decisions: readonly StoredDecision[], delivery: string): Map<string, OrderEdit> {
  const found = new Map<string, OrderEdit>();
  for (const decision of decisions) {
    if (decision.delivery !== delivery || found.has(decision.itemId)) continue;
    found.set(decision.itemId, { quantity: decision.quantity, reason: decision.reason });
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

function ruleSentence(delta: number, unit: string, situation: string): string {
  const word = delta < 0 ? 'fewer' : 'extra';
  return `Includes ${String(Math.abs(delta))} ${word} ${unit} because ${situation}`;
}

/**
 * A confirmed rule is the only past preference that changes a later line. A saved edit is shown and does not.
 * A sample is returned unchanged.
 */
export function withPreferences(board: OrderBoard, decisions: readonly StoredDecision[], rules: readonly StoredRule[]): OrderBoard {
  if (board.sample) return board;
  const edits = latestEdits(decisions, board.delivery);
  const byItem = activeRules(rules);
  const lines = board.lines.map((line) => {
    const edit = edits.get(line.itemId) ?? null;
    const applied = byItem.get(line.itemId) ?? [];
    const delta = applied.reduce((sum, rule) => sum + rule.delta, 0);
    const sentence = applied.map((rule) => ruleSentence(rule.delta, line.unit, rule.situation)).join(' ');
    const primary = applied[0];
    return {
      ...line,
      recommended: Math.max(0, line.recommended + delta),
      why: sentence === '' ? line.why : `${line.why} ${sentence}.`,
      edit,
      rule: primary === undefined ? null : { id: primary.id, delta, situation: primary.situation },
    };
  });
  return { ...board, lines };
}

/** The sample line for this delivery and item, or null. A live line is never invented. */
export function findLine(today: string, delivery: string, itemId: string): OrderLine | null {
  const board = sampleBoard(today);
  if (board.delivery !== delivery) return null;
  return board.lines.find((line) => line.itemId === itemId) ?? null;
}
