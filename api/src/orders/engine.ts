// The order engine: a pure port of the core of reorder/reorder/engine.py, forecast_adapter.py and mockup_logic.py.
// No I/O and no clock: dates are 'YYYY-MM-DD' calendar dates read as UTC, weekdays are 0-6 with 0 = Sunday.
// Deliberate deviations from the Python (design Decision 5, each a [CONFIRM] in the spec): the weekday mean uses the
// last 8 weeks of covered days, not all history; the guest index divides by the location's own weekday guests; the
// cutoff time picks the next order; quantities are whole units; a covered day counts an unsold item as zero; a past
// window's error uses only its covered days; with no sigma the why line says there is no cushion yet; lines at 0 stay.

import type { OrderConfidence } from './board.ts';
import { shortDate, weekdayName } from './dates.ts';

export type OrderCategory = 'bottles_cans' | 'draft' | 'liquor' | 'cocktail_ingredient';
export type OrderUnit = 'cases' | 'kegs' | 'bottles' | 'units';

export interface SetupDelivery {
  readonly deliveryWeekday: number;
  readonly cutoffWeekday: number;
  /** HH:MM, 24-hour, in the town's zone. */
  readonly cutoffTime: string;
}

export interface SetupSupplier {
  readonly id: string;
  readonly name: string;
  readonly deliveries: readonly SetupDelivery[];
}

export interface SetupItem {
  readonly id: string;
  readonly name: string;
  readonly supplierId: string;
  readonly category: OrderCategory;
  readonly unit: OrderUnit;
  readonly servingsPerUnit: number;
  readonly par: number;
  readonly dealSize: number | null;
  readonly neverRunOut: boolean;
}

/** A covered day. An item absent from it sold none that day. */
export interface ItemSalesDay {
  readonly date: string;
  readonly items: Readonly<Record<string, number>>;
}

export interface LatestCount {
  readonly quantity: number;
  readonly date: string;
}

export interface EngineInput {
  readonly suppliers: readonly SetupSupplier[];
  readonly items: readonly SetupItem[];
  readonly itemSales: readonly ItemSalesDay[];
  readonly counts: ReadonlyMap<string, LatestCount>;
  /** Published forecast middle guests by date, future days only. */
  readonly forecastGuests: ReadonlyMap<string, number>;
  /** Past days' actual guests. */
  readonly historyGuests: readonly { readonly date: string; readonly guests: number | null }[];
  /** The town's date and minutes since its midnight. */
  readonly today: string;
  readonly nowMinutes: number;
}

export interface OrderWindow {
  readonly cutoff: string;
  readonly cutoffTime: string;
  readonly delivery: string;
  readonly coversThrough: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

/** A closed window: from its cutoff through `end`, the day before the supplier's following delivery. */
export interface PastWindow {
  readonly cutoff: string;
  readonly delivery: string;
  readonly end: string;
}

export interface EngineLine {
  readonly itemId: string;
  readonly name: string;
  readonly supplier: string;
  readonly unit: OrderUnit;
  readonly neverRunOut: boolean;
  readonly recommended: number;
  readonly alternative: number | null;
  readonly par: number;
  /** Window demand in purchase units, null with no weekday mean for any window day. */
  readonly mu: number | null;
  /** Spread of past window errors in purchase units, null under 2 windows. */
  readonly sigma: number | null;
  /** The order-up-to level S = mu + z x (sigma or 0), null without mu. */
  readonly orderUpTo: number | null;
  readonly target: number;
  readonly onHand: number | null;
  readonly countAgeDays: number | null;
  readonly confidence: OrderConfidence;
  readonly dealSize: number | null;
  readonly coveredDays: number;
  readonly why: string;
}

export interface SupplierOrderPlan extends OrderWindow {
  readonly supplierId: string;
  readonly supplier: string;
  readonly lines: readonly EngineLine[];
}

/** Covered item-sales days by day number. */
export type SalesIndex = ReadonlyMap<number, Readonly<Record<string, number>>>;

const DAY_MS = 86_400_000;
const MEAN_DAYS = 56;
const SIGMA_DAYS = 182;
const FRESH_COUNT_DAYS = 7;
const HOLDING = 0.05;
const SHORTAGE = 4;
const LOSS: Record<OrderCategory, number> = { bottles_cans: 0.01, draft: 0.12, liquor: 0.05, cocktail_ingredient: 0 };
// z for 0.95 and 0.98 is the engine's named table; 0.92 and 0.88 are its inverse normal values.
const TARGETS: Record<OrderCategory | 'never_run_out', { target: number; z: number }> = {
  never_run_out: { target: 0.98, z: 2.05 },
  bottles_cans: { target: 0.95, z: 1.65 },
  draft: { target: 0.95, z: 1.65 },
  liquor: { target: 0.92, z: 1.405 },
  cocktail_ingredient: { target: 0.88, z: 1.175 },
};
const SINGULAR: Record<OrderUnit, string> = { cases: 'case', kegs: 'keg', bottles: 'bottle', units: 'unit' };
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function dayNumber(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS;
}

function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 1970-01-01, day 0, was a Thursday. */
function weekdayOf(day: number): number {
  return (day + 4) % 7;
}

function mod7(value: number): number {
  return ((value % 7) + 7) % 7;
}

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The first day after `day` that the supplier delivers, at most a week on (the delivery's own weekday). */
function followingDelivery(day: number, weekdays: ReadonlySet<number>): number {
  let next = day + 1;
  while (next < day + 7 && !weekdays.has(weekdayOf(next))) next += 1;
  return next;
}

/** The supplier's next order: the delivery row with the soonest cutoff not yet passed, and the window it covers. */
export function nextOrderFor(supplier: SetupSupplier, today: string, nowMinutes: number): OrderWindow | null {
  const start = dayNumber(today);
  let best: { cutoff: number; minutes: number; row: SetupDelivery } | null = null;
  for (const row of supplier.deliveries) {
    const minutes = minutesOf(row.cutoffTime);
    let cutoff = start + mod7(row.cutoffWeekday - weekdayOf(start));
    if (cutoff === start && nowMinutes >= minutes) cutoff += 7;
    if (best === null || cutoff < best.cutoff || (cutoff === best.cutoff && minutes < best.minutes)) best = { cutoff, minutes, row };
  }
  if (best === null) return null;
  const delivery = best.cutoff + mod7(best.row.deliveryWeekday - best.row.cutoffWeekday);
  const following = followingDelivery(delivery, new Set(supplier.deliveries.map((row) => row.deliveryWeekday)));
  return {
    cutoff: isoDate(best.cutoff),
    cutoffTime: best.row.cutoffTime,
    delivery: isoDate(delivery),
    coversThrough: isoDate(following),
    windowStart: isoDate(best.cutoff),
    windowEnd: isoDate(following - 1),
  };
}

/** The supplier's windows for deliveries in the 26 weeks before today that closed before today, oldest first. */
export function pastWindows(supplier: SetupSupplier, today: string): PastWindow[] {
  const end = dayNumber(today);
  const cutoffFor = new Map<number, number>();
  for (const row of supplier.deliveries) {
    if (!cutoffFor.has(row.deliveryWeekday)) cutoffFor.set(row.deliveryWeekday, row.cutoffWeekday);
  }
  const weekdays = new Set(cutoffFor.keys());
  const windows: PastWindow[] = [];
  for (let delivery = end - SIGMA_DAYS; delivery < end; delivery += 1) {
    const cutoffWeekday = cutoffFor.get(weekdayOf(delivery));
    if (cutoffWeekday === undefined) continue;
    const following = followingDelivery(delivery, weekdays);
    if (following - 1 >= end) continue;
    const cutoff = delivery - mod7(weekdayOf(delivery) - cutoffWeekday);
    windows.push({ cutoff: isoDate(cutoff), delivery: isoDate(delivery), end: isoDate(following - 1) });
  }
  return windows;
}

export function indexSales(days: readonly ItemSalesDay[]): SalesIndex {
  return new Map(days.map((day) => [dayNumber(day.date), day.items]));
}

/** Mean servings per weekday (index 0 = Sunday) over the covered days in the 8 weeks before `asOf`, null with none. */
export function weekdayMeans(sales: SalesIndex, itemId: string, asOf: string): (number | null)[] {
  const end = dayNumber(asOf);
  const seen: number[][] = [[], [], [], [], [], [], []];
  for (let day = end - MEAN_DAYS; day < end; day += 1) {
    const items = sales.get(day);
    if (items !== undefined) seen[weekdayOf(day)]?.push(items[itemId] ?? 0);
  }
  return seen.map(mean);
}

/** Forecast guests over the location's mean guests on that weekday in the 8 weeks before today; null when either is missing. */
export function guestIndex(
  day: string, forecastGuests: EngineInput['forecastGuests'], historyGuests: EngineInput['historyGuests'], today: string,
): number | null {
  const forecast = forecastGuests.get(day);
  if (forecast === undefined) return null;
  const end = dayNumber(today);
  const weekday = weekdayOf(dayNumber(day));
  const baseline = mean(historyGuests.flatMap(({ date, guests }) => {
    const seen = dayNumber(date);
    return guests !== null && seen >= end - MEAN_DAYS && seen < end && weekdayOf(seen) === weekday ? [guests] : [];
  }));
  return baseline === null || baseline === 0 ? null : forecast / baseline;
}

/**
 * Sample standard deviation, in servings, of actual minus forecast over past windows, each forecast being the weekday
 * means as of that window's cutoff with no guest index. Only covered days with a mean count; null under 2 windows.
 */
export function windowSigma(sales: SalesIndex, itemId: string, windows: readonly PastWindow[]): number | null {
  const errors: number[] = [];
  for (const window of windows) {
    const means = weekdayMeans(sales, itemId, window.cutoff);
    let forecast = 0;
    let actual = 0;
    let used = 0;
    for (let day = dayNumber(window.cutoff); day <= dayNumber(window.end); day += 1) {
      const items = sales.get(day);
      const expected = means[weekdayOf(day)] ?? null;
      if (items === undefined || expected === null) continue;
      forecast += expected;
      actual += items[itemId] ?? 0;
      used += 1;
    }
    if (used > 0) errors.push(actual - forecast);
  }
  const average = mean(errors);
  if (average === null || errors.length < 2) return null;
  return Math.sqrt(errors.reduce((sum, error) => sum + (error - average) ** 2, 0) / (errors.length - 1));
}

export function targetFor(item: Pick<SetupItem, 'neverRunOut' | 'category'>): { target: number; z: number } {
  return TARGETS[item.neverRunOut ? 'never_run_out' : item.category];
}

/** The deal multiple just below the quantity and the one just above it; both above when below is 0. */
export function dealPair(needed: number, step: number): [number, number] {
  if (needed <= 0) return [0, 0];
  const below = Math.floor(needed / step) * step;
  const above = Math.ceil(needed / step - 1e-9) * step;
  return below <= 0 ? [above, above] : [below, above];
}

function wholeUp(value: number): number {
  return Math.max(0, Math.ceil(value - 1e-9));
}

export interface QuantityInput {
  readonly par: number;
  readonly count: { readonly quantity: number; readonly ageDays: number } | null;
  readonly mu: number | null;
  readonly orderUpTo: number | null;
  readonly dealSize: number | null;
}

/** engine.py build_recommendation: par without a usable count or sales, else the cheaper deal option with the par swap. */
export function quantityFor({ par, count, mu, orderUpTo, dealSize }: QuantityInput): { recommended: number; alternative: number | null } {
  if (count === null) return { recommended: wholeUp(par), alternative: null };
  const onHand = count.quantity;
  if (count.ageDays > FRESH_COUNT_DAYS || mu === null || orderUpTo === null) {
    return { recommended: wholeUp(par - onHand), alternative: null };
  }
  const needed = Math.max(0, orderUpTo - onHand, par - onHand);
  if (dealSize === null || dealSize <= 0) return { recommended: wholeUp(needed), alternative: null };
  const cost = (quantity: number): number =>
    quantity + HOLDING * Math.max(0, onHand + quantity - mu) + SHORTAGE * Math.max(0, orderUpTo - onHand - quantity);
  const [below, above] = dealPair(needed, dealSize);
  let [pick, other] = cost(above) < cost(below) ? [above, below] : [below, above];
  if (onHand + pick + 1e-9 < par && onHand + other >= par) [pick, other] = [other, pick];
  return { recommended: pick, alternative: Math.abs(other - pick) < 1e-9 ? null : other };
}

export function confidenceFor(countAgeDays: number | null, coveredDays: number, mu: number | null): OrderConfidence {
  if (countAgeDays === null || countAgeDays > FRESH_COUNT_DAYS || coveredDays === 0 || mu === null) return 'low';
  if (countAgeDays >= 3 || coveredDays < 28) return 'medium';
  return 'high';
}

function number(value: number): string {
  return Math.abs(value - Math.round(value)) < 1e-6 ? String(Math.round(value)) : value.toFixed(1);
}

/** The unit for a quantity: the singular for exactly one, else the plural. */
export function unitFor(value: number, unit: OrderUnit): string {
  return Math.abs(value - 1) < 1e-6 ? SINGULAR[unit] : unit;
}

function amount(value: number, unit: OrderUnit): string {
  // A slow item's use rounds to 0.0 at one decimal; say what is true instead.
  if (value > 0 && value < 0.05) return `less than 0.1 ${unit}`;
  return `${number(value)} ${unitFor(value, unit)}`;
}

function dealPhrase(quantity: number, dealSize: number | null): string {
  if (dealSize === null || dealSize <= 0 || quantity <= 0) return '';
  const deals = quantity / dealSize;
  if (Math.abs(deals - Math.round(deals)) > 1e-6) return '';
  const count = Math.round(deals);
  return ` (${NUMBER_WORDS[count] ?? String(count)} ${count === 1 ? 'deal' : 'deals'} of ${number(dealSize)})`;
}

export interface WhyInput {
  readonly delivery: string;
  readonly coversThrough: string;
  readonly windowDays: number;
  readonly unit: OrderUnit;
  readonly mu: number | null;
  readonly scaled: boolean;
  readonly count: LatestCount | null;
  readonly countAgeDays: number | null;
  readonly confidence: OrderConfidence;
  readonly sigma: number | null;
  readonly recommended: number;
  readonly dealSize: number | null;
  readonly target: number;
}

/** The delivery, the expected use and its basis, the count, and the target chance only when sigma exists. */
export function whyLine(input: WhyInput): string {
  const { count, countAgeDays, mu } = input;
  const parts = [`${weekdayName(input.delivery)}’s delivery covers through ${weekdayName(input.coversThrough)}.`];
  if (mu === null) {
    parts.push('No item sales yet, so this follows the par.');
  } else {
    const span = input.windowDays === 1 ? 'this day' : `these ${input.windowDays} days`;
    const scaled = input.scaled ? ', scaled to the guest forecast' : '';
    parts.push(`Expected use about ${amount(mu, input.unit)} over ${span}, from the last 8 weeks of sales${scaled}.`);
  }
  // The target chance and the cushion speak only for a quantity built from S and a fresh count, never for the par.
  let fromForecast = false;
  if (count === null || countAgeDays === null) {
    parts.push('No count yet, so this is the par.');
  } else if (countAgeDays > FRESH_COUNT_DAYS) {
    parts.push(`The last count was ${countAgeDays} days ago, so this follows the par.`);
  } else {
    parts.push(`You counted ${number(count.quantity)} on ${shortDate(count.date)}.`);
    fromForecast = mu !== null;
  }
  if (input.confidence === 'medium') parts.push('Count it before you send the order.');
  if (fromForecast) {
    const percent = Math.round(input.target * 100);
    const chance = `${percent >= 80 && percent < 90 ? 'an' : 'a'} ${percent}% chance`;
    parts.push(input.sigma === null
      ? 'Too little history for a safety cushion, so this covers the expected use.'
      : `Ordering ${number(input.recommended)}${dealPhrase(input.recommended, input.dealSize)} aims for ${chance} of not running out.`);
  }
  return parts.join(' ');
}

interface SupplierContext {
  readonly supplier: SetupSupplier;
  readonly window: OrderWindow;
  /** Window days with each day's guest index, null where no forecast applies. */
  readonly days: readonly { readonly weekday: number; readonly index: number | null }[];
  readonly past: readonly PastWindow[];
}

function lineFor(item: SetupItem, context: SupplierContext, input: EngineInput, sales: SalesIndex, coveredDays: number): EngineLine {
  const usable = item.servingsPerUnit * (1 - LOSS[item.category]);
  const means = weekdayMeans(sales, item.id, input.today);
  let servings: number | null = null;
  let scaled = false;
  for (const { weekday, index } of context.days) {
    const daily = means[weekday] ?? null;
    if (daily === null) continue;
    servings = (servings ?? 0) + daily * (index ?? 1);
    if (index !== null) scaled = true;
  }
  const mu = servings === null ? null : servings / usable;
  const sigmaServings = windowSigma(sales, item.id, context.past);
  const sigma = sigmaServings === null ? null : sigmaServings / usable;
  const { target, z } = targetFor(item);
  const orderUpTo = mu === null ? null : mu + z * (sigma ?? 0);
  const latest = input.counts.get(item.id) ?? null;
  const count = latest === null ? null : { quantity: latest.quantity, ageDays: dayNumber(input.today) - dayNumber(latest.date) };
  const countAgeDays = count?.ageDays ?? null;
  const { recommended, alternative } = quantityFor({ par: item.par, count, mu, orderUpTo, dealSize: item.dealSize });
  const confidence = confidenceFor(countAgeDays, coveredDays, mu);
  const line = {
    itemId: item.id, name: item.name, supplier: context.supplier.name, unit: item.unit, neverRunOut: item.neverRunOut,
    recommended, alternative, par: item.par, mu, sigma, orderUpTo, target, onHand: latest?.quantity ?? null, countAgeDays,
    confidence, dealSize: item.dealSize, coveredDays,
  };
  const { delivery, coversThrough } = context.window;
  return { ...line, why: whyLine({ ...line, delivery, coversThrough, windowDays: context.days.length, scaled, count: latest }) };
}

/** One next order per supplier with at least one delivery and one item, by cutoff date, cutoff time, then name. */
export function computeOrders(input: EngineInput): SupplierOrderPlan[] {
  const sales = indexSales(input.itemSales);
  const today = dayNumber(input.today);
  let coveredDays = 0;
  for (let day = today - MEAN_DAYS; day < today; day += 1) if (sales.has(day)) coveredDays += 1;
  const plans: SupplierOrderPlan[] = [];
  for (const supplier of input.suppliers) {
    const items = input.items.filter((item) => item.supplierId === supplier.id);
    const window = nextOrderFor(supplier, input.today, input.nowMinutes);
    if (items.length === 0 || window === null) continue;
    const days: { weekday: number; index: number | null }[] = [];
    for (let day = dayNumber(window.windowStart); day <= dayNumber(window.windowEnd); day += 1) {
      days.push({ weekday: weekdayOf(day), index: guestIndex(isoDate(day), input.forecastGuests, input.historyGuests, input.today) });
    }
    const context: SupplierContext = { supplier, window, days, past: pastWindows(supplier, input.today) };
    const lines = items
      .map((item) => lineFor(item, context, input, sales, coveredDays))
      .sort((a, b) => Number(b.neverRunOut) - Number(a.neverRunOut) || a.name.localeCompare(b.name));
    plans.push({ supplierId: supplier.id, supplier: supplier.name, ...window, lines });
  }
  return plans.sort((a, b) =>
    a.cutoff.localeCompare(b.cutoff) || minutesOf(a.cutoffTime) - minutesOf(b.cutoffTime) || a.supplier.localeCompare(b.supplier));
}
