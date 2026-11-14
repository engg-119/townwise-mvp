// The order engine: a pure port of the core of reorder/reorder/engine.py, forecast_adapter.py and mockup_logic.py.
// No I/O and no clock: dates are 'YYYY-MM-DD' calendar dates read as UTC, weekdays are 0-6 with 0 = Sunday.
// Deliberate deviations from the Python (design Decision 5, each a [CONFIRM] in the spec): the weekday mean uses the
// last 8 weeks of covered days, not all history; the guest index divides by the location's own weekday guests; a day
// the forecast marks closed expects no sales and a booked day keeps the weekday mean; the cutoff time picks the next
// order; quantities are whole units, at most 999; a covered day counts an unsold item as zero, and an item no covered
// day of the 8 weeks sold has no mean; a past window's error uses only its covered days; confidence is low without a
// mean; a deal size of 1 is no deal size; with no sigma the why line says there is no cushion yet; lines sort by
// never-run-out, then name; lines at 0 stay.

import type { OrderConfidence } from './board.ts';
import { lastsUntil, shortDate } from './dates.ts';

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
  /** Published forecast middle guests by date, future open days only. */
  readonly forecastGuests: ReadonlyMap<string, number>;
  /** Future days the published forecast marks closed: no sales are expected on them. A booked day is in neither. */
  readonly closedDays: ReadonlySet<string>;
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
  /**
   * The par the quantity uses: the setup's, one higher for a draft item whose window uses more than one unit, at most
   * 999.
   */
  readonly par: number;
  /** The owner's par, as the setup holds it. */
  readonly setupPar: number;
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

/** The most a line recommends, the most an owner's edit saves. */
export const MAX_QUANTITY = 999;

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

/** A whole day number. `| 0` keeps it a small integer, so `% 7` below is an integer remainder, not a float one. */
function dayNumber(iso: string): number {
  return (Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS) | 0;
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

/**
 * The supplier's next order: the delivery row with the soonest cutoff not yet passed, and the window it covers. Two
 * rows with the same cutoff day and time give the earlier delivery, whatever their order in the setup.
 */
export function nextOrderFor(supplier: SetupSupplier, today: string, nowMinutes: number): OrderWindow | null {
  const start = dayNumber(today);
  let best: { cutoff: number; minutes: number; delivery: number; row: SetupDelivery } | null = null;
  for (const row of supplier.deliveries) {
    const minutes = minutesOf(row.cutoffTime);
    let cutoff = start + mod7(row.cutoffWeekday - weekdayOf(start));
    if (cutoff === start && nowMinutes >= minutes) cutoff += 7;
    const delivery = cutoff + mod7(row.deliveryWeekday - row.cutoffWeekday);
    const sooner = best === null || cutoff < best.cutoff
      || (cutoff === best.cutoff && (minutes < best.minutes || (minutes === best.minutes && delivery < best.delivery)));
    if (sooner) best = { cutoff, minutes, delivery, row };
  }
  if (best === null) return null;
  const following = followingDelivery(best.delivery, new Set(supplier.deliveries.map((row) => row.deliveryWeekday)));
  return {
    cutoff: isoDate(best.cutoff),
    cutoffTime: best.row.cutoffTime,
    delivery: isoDate(best.delivery),
    coversThrough: isoDate(following),
    windowStart: isoDate(best.cutoff),
    windowEnd: isoDate(following - 1),
  };
}

/** A past window by day numbers. */
interface WindowDays {
  readonly cutoff: number;
  readonly delivery: number;
  readonly end: number;
}

function pastWindowDays(supplier: SetupSupplier, today: string): WindowDays[] {
  const end = dayNumber(today);
  const cutoffFor = new Map<number, number>();
  for (const row of supplier.deliveries) {
    if (!cutoffFor.has(row.deliveryWeekday)) cutoffFor.set(row.deliveryWeekday, row.cutoffWeekday);
  }
  const weekdays = new Set(cutoffFor.keys());
  const windows: WindowDays[] = [];
  for (let delivery = end - SIGMA_DAYS; delivery < end; delivery += 1) {
    const cutoffWeekday = cutoffFor.get(weekdayOf(delivery));
    if (cutoffWeekday === undefined) continue;
    const following = followingDelivery(delivery, weekdays);
    if (following - 1 >= end) continue;
    windows.push({ cutoff: delivery - mod7(weekdayOf(delivery) - cutoffWeekday), delivery, end: following - 1 });
  }
  return windows;
}

/** The supplier's windows for deliveries in the 26 weeks before today that closed before today, oldest first. */
export function pastWindows(supplier: SetupSupplier, today: string): PastWindow[] {
  return pastWindowDays(supplier, today).map((window) => ({
    cutoff: isoDate(window.cutoff), delivery: isoDate(window.delivery), end: isoDate(window.end),
  }));
}

export function indexSales(days: readonly ItemSalesDay[]): SalesIndex {
  return new Map(days.map((day) => [dayNumber(day.date), day.items]));
}

/**
 * One item's servings by day number from `start`, NaN on a day not covered: read once per item, so the weekday means of
 * every past window cost an array read per day instead of a map and an object lookup.
 */
interface ItemSeries {
  readonly start: number;
  readonly values: Float64Array;
}

function seriesOf(sales: SalesIndex, itemId: string): ItemSeries {
  let start = Infinity;
  let end = -Infinity;
  for (const day of sales.keys()) {
    if (day < start) start = day;
    if (day > end) end = day;
  }
  if (start > end) return { start: 0, values: new Float64Array(0) };
  const values = new Float64Array(end - start + 1).fill(NaN);
  for (const [day, items] of sales) values[day - start] = items[itemId] ?? 0;
  return { start, values };
}

/** The item's servings that day, NaN when the day is not covered. */
function servingsOn(series: ItemSeries, day: number): number {
  const offset = day - series.start;
  return offset >= 0 && offset < series.values.length ? series.values[offset] ?? NaN : NaN;
}

/** Each weekday's mean over the covered days of the 8 weeks before `asOf`, summed oldest first as `mean` sums. */
function meansAsOf(series: ItemSeries, asOf: number): (number | null)[] {
  const sums = [0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let day = asOf - MEAN_DAYS; day < asOf; day += 1) {
    const servings = servingsOn(series, day);
    if (Number.isNaN(servings)) continue;
    const weekday = weekdayOf(day);
    sums[weekday] = (sums[weekday] ?? 0) + servings;
    counts[weekday] = (counts[weekday] ?? 0) + 1;
  }
  return sums.map((sum, weekday) => {
    const count = counts[weekday] ?? 0;
    return count === 0 ? null : sum / count;
  });
}

/** Mean servings per weekday (index 0 = Sunday) over the covered days in the 8 weeks before `asOf`, null with none. */
export function weekdayMeans(sales: SalesIndex, itemId: string, asOf: string): (number | null)[] {
  return meansAsOf(seriesOf(sales, itemId), dayNumber(asOf));
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

function windowDaysOf(windows: readonly PastWindow[]): WindowDays[] {
  return windows.map((window) => ({ cutoff: dayNumber(window.cutoff), delivery: dayNumber(window.delivery), end: dayNumber(window.end) }));
}

function sigmaOf(series: ItemSeries, windows: readonly WindowDays[]): number | null {
  const errors: number[] = [];
  for (const window of windows) {
    const means = meansAsOf(series, window.cutoff);
    let forecast = 0;
    let actual = 0;
    let used = 0;
    for (let day = window.cutoff; day <= window.end; day += 1) {
      const servings = servingsOn(series, day);
      const expected = means[weekdayOf(day)] ?? null;
      if (Number.isNaN(servings) || expected === null) continue;
      forecast += expected;
      actual += servings;
      used += 1;
    }
    if (used > 0) errors.push(actual - forecast);
  }
  const average = mean(errors);
  if (average === null || errors.length < 2) return null;
  return Math.sqrt(errors.reduce((sum, error) => sum + (error - average) ** 2, 0) / (errors.length - 1));
}

/**
 * Sample standard deviation, in servings, of actual minus forecast over past windows, each forecast being the weekday
 * means as of that window's cutoff with no guest index. Only covered days with a mean count; null under 2 windows.
 */
export function windowSigma(sales: SalesIndex, itemId: string, windows: readonly PastWindow[]): number | null {
  return sigmaOf(seriesOf(sales, itemId), windowDaysOf(windows));
}

export function targetFor(item: Pick<SetupItem, 'neverRunOut' | 'category'>): { target: number; z: number } {
  return TARGETS[item.neverRunOut ? 'never_run_out' : item.category];
}

/**
 * engine.py draft_backup_par: one tapped keg plus one backup, and a second backup when the window uses more than one.
 * The base is the owner's par (Python's 2 is only for an item with no par, and every setup item has one).
 */
export function draftBackupPar(forecastUnits: number | null, basePar: number): number {
  return forecastUnits !== null && forecastUnits > 1 ? basePar + 1 : basePar;
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

/** A deal of 1 is any whole quantity, so it rounds as no deal size does. */
function hasDeals(dealSize: number | null): dealSize is number {
  return dealSize !== null && dealSize > 1;
}

export interface QuantityInput {
  readonly par: number;
  readonly count: { readonly quantity: number; readonly ageDays: number } | null;
  readonly mu: number | null;
  readonly orderUpTo: number | null;
  readonly dealSize: number | null;
}

export interface Quantity {
  readonly recommended: number;
  readonly alternative: number | null;
  /** True when the par, not the order-up-to level, set a quantity built from a fresh count and a mean. */
  readonly byPar: boolean;
}

/** engine.py build_recommendation: par without a usable count or sales, else the cheaper deal option with the par swap. */
export function quantityFor({ par, count, mu, orderUpTo, dealSize }: QuantityInput): Quantity {
  if (count === null) return { recommended: wholeUp(par), alternative: null, byPar: false };
  const onHand = count.quantity;
  if (count.ageDays > FRESH_COUNT_DAYS || mu === null || orderUpTo === null) {
    return { recommended: wholeUp(par - onHand), alternative: null, byPar: false };
  }
  const needed = Math.max(0, orderUpTo - onHand, par - onHand);
  const parFloor = par - onHand > 0 && par > orderUpTo + 1e-9;
  if (!hasDeals(dealSize)) return { recommended: wholeUp(needed), alternative: null, byPar: parFloor };
  const cost = (quantity: number): number =>
    quantity + HOLDING * Math.max(0, onHand + quantity - mu) + SHORTAGE * Math.max(0, orderUpTo - onHand - quantity);
  const [below, above] = dealPair(needed, dealSize);
  let [pick, other] = cost(above) < cost(below) ? [above, below] : [below, above];
  const swapped = onHand + pick + 1e-9 < par && onHand + other >= par;
  if (swapped) [pick, other] = [other, pick];
  return { recommended: pick, alternative: Math.abs(other - pick) < 1e-9 ? null : other, byPar: parFloor || swapped };
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
  if (!hasDeals(dealSize) || quantity <= 0) return '';
  const deals = quantity / dealSize;
  if (Math.abs(deals - Math.round(deals)) > 1e-6) return '';
  const count = Math.round(deals);
  return ` (${NUMBER_WORDS[count] ?? String(count)} ${count === 1 ? 'deal' : 'deals'} of ${number(dealSize)})`;
}

function days(count: number): string {
  return count === 1 ? 'one day' : `${String(count)} days`;
}

export interface WhyInput {
  readonly delivery: string;
  readonly coversThrough: string;
  readonly windowDays: number;
  readonly unit: OrderUnit;
  readonly mu: number | null;
  /** True when a guest index from an open forecast day scaled the use. */
  readonly scaled: boolean;
  /** Window days with a mean that the forecast marks closed, which expect no sales. */
  readonly closedDays: number;
  /** True when any covered day of the 8 weeks sold the item. */
  readonly sold: boolean;
  /** Covered item-sales days in the 8 weeks before today. */
  readonly coveredDays: number;
  readonly count: LatestCount | null;
  readonly countAgeDays: number | null;
  readonly confidence: OrderConfidence;
  readonly sigma: number | null;
  /** The engine's quantity, before the 999 cap. */
  readonly recommended: number;
  readonly dealSize: number | null;
  readonly target: number;
  /** The par the quantity uses, and the setup's own. */
  readonly par: number;
  readonly setupPar: number;
  /** quantityFor's byPar: the par, not the target, set the quantity. */
  readonly byPar: boolean;
}

/** The sentence about the expected use and what it is based on. */
function useSentence(input: WhyInput): string {
  const { mu } = input;
  if (mu === null) {
    if (input.coveredDays === 0) return 'No item sales yet, so this follows the par.';
    return input.sold
      ? 'The last 8 weeks of item sales cover none of these weekdays, so this follows the par.'
      : 'The last 8 weeks of item sales show none of this item sold, so this follows the par.';
  }
  const span = input.windowDays === 1 ? 'this day' : `these ${String(input.windowDays)} days`;
  const scaled = input.scaled ? ', scaled to the guest forecast' : '';
  const closed = input.closedDays > 0 ? `, leaving out ${days(input.closedDays)} the forecast marks closed` : '';
  return `Expected use about ${amount(mu, input.unit)} over ${span}, from the last 8 weeks of sales${scaled}${closed}.`;
}

/**
 * The delivery, the expected use and its basis, the count, and how the quantity was reached: up to the par, the
 * target chance only when sigma exists, and the 999 cap. A capped line claims no chance and no coverage: 999 is less
 * than it needed, so it may fall short.
 */
export function whyLine(input: WhyInput): string {
  const { count, countAgeDays, mu } = input;
  const parts = [lastsUntil(input.delivery, input.coversThrough), useSentence(input)];
  if (input.par !== input.setupPar) {
    parts.push(`These days use more than one ${SINGULAR[input.unit]}, so the par is one more than yours: ${number(input.par)}.`);
  }
  // The target chance and the cushion speak only for a quantity built from S and a fresh count, never for the par.
  let fromForecast = false;
  if (count === null || countAgeDays === null) {
    parts.push('No count yet, so this is the par.');
  } else if (countAgeDays > FRESH_COUNT_DAYS) {
    parts.push(`The last count was ${String(countAgeDays)} days ago, so this follows the par.`);
  } else {
    parts.push(`You counted ${number(count.quantity)} on ${shortDate(count.date)}.`);
    fromForecast = mu !== null;
  }
  if (input.confidence === 'medium') {
    parts.push(countAgeDays !== null && countAgeDays >= 3
      ? 'Count it before you send the order.'
      : `Item sales cover only ${days(input.coveredDays)} of the last 8 weeks, so the history is short.`);
  }
  const capped = input.recommended > MAX_QUANTITY;
  if (fromForecast && !capped && mu !== null && count !== null) {
    const ordered = `${number(input.recommended)}${dealPhrase(input.recommended, input.dealSize)}`;
    if (input.byPar) {
      parts.push(`Ordering ${ordered} brings your stock up to the par of ${number(input.par)}.`);
    } else if (input.sigma === null) {
      parts.push(count.quantity + input.recommended + 1e-9 >= mu
        ? 'Too little history for a safety cushion, so this covers the expected use.'
        : `Too little history for a safety cushion, and with what you counted, ordering ${ordered} falls short of the expected use.`);
    } else {
      const percent = Math.round(input.target * 100);
      const chance = `${percent >= 80 && percent < 90 ? 'an' : 'a'} ${String(percent)}% chance`;
      parts.push(`Ordering ${ordered} aims for ${chance} of not running out.`);
    }
  }
  if (capped) {
    parts.push(`${String(MAX_QUANTITY)} ${input.unit} is the most one line can order, so this is ${String(MAX_QUANTITY)} and may fall short.`);
  }
  return parts.join(' ');
}

interface SupplierContext {
  readonly supplier: SetupSupplier;
  readonly window: OrderWindow;
  /** Window days with each day's guest index: null where no open forecast day applies, 0 on a closed day. */
  readonly days: readonly { readonly weekday: number; readonly index: number | null; readonly closed: boolean }[];
  readonly past: readonly WindowDays[];
}

function lineFor(item: SetupItem, context: SupplierContext, input: EngineInput, series: ItemSeries, coveredDays: number): EngineLine {
  const usable = item.servingsPerUnit * (1 - LOSS[item.category]);
  const today = dayNumber(input.today);
  const recent = meansAsOf(series, today);
  // An item no covered day of the 8 weeks sold (never matched, or off the menu) has no mean, so it follows the par.
  const sold = recent.some((daily) => daily !== null && daily > 0);
  let servings: number | null = null;
  let scaled = false;
  let closedDays = 0;
  for (const { weekday, index, closed } of context.days) {
    const daily = sold ? (recent[weekday] ?? null) : null;
    if (daily === null) continue;
    servings = (servings ?? 0) + daily * (index ?? 1);
    if (closed) closedDays += 1;
    else if (index !== null) scaled = true;
  }
  const mu = servings === null ? null : servings / usable;
  const sigmaServings = mu === null ? null : sigmaOf(series, context.past);
  const sigma = sigmaServings === null ? null : sigmaServings / usable;
  const { target, z } = targetFor(item);
  const orderUpTo = mu === null ? null : mu + z * (sigma ?? 0);
  const par = Math.min(MAX_QUANTITY, item.category === 'draft' ? draftBackupPar(mu, item.par) : item.par);
  const latest = input.counts.get(item.id) ?? null;
  const count = latest === null ? null : { quantity: latest.quantity, ageDays: today - dayNumber(latest.date) };
  const countAgeDays = count?.ageDays ?? null;
  const quantity = quantityFor({ par, count, mu, orderUpTo, dealSize: item.dealSize });
  const capped = quantity.recommended > MAX_QUANTITY;
  const confidence = confidenceFor(countAgeDays, coveredDays, mu);
  const line = {
    itemId: item.id, name: item.name, supplier: context.supplier.name, unit: item.unit, neverRunOut: item.neverRunOut,
    recommended: capped ? MAX_QUANTITY : quantity.recommended, alternative: capped ? null : quantity.alternative, par,
    setupPar: item.par, mu, sigma, orderUpTo, target, onHand: latest?.quantity ?? null, countAgeDays, confidence,
    dealSize: item.dealSize, coveredDays,
  };
  const why = whyLine({
    ...line, delivery: context.window.delivery, coversThrough: context.window.coversThrough, windowDays: context.days.length, scaled,
    closedDays, sold, count: latest, recommended: quantity.recommended, byPar: quantity.byPar,
  });
  return { ...line, why };
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
    const days: { weekday: number; index: number | null; closed: boolean }[] = [];
    for (let day = dayNumber(window.windowStart); day <= dayNumber(window.windowEnd); day += 1) {
      const iso = isoDate(day);
      const closed = input.closedDays.has(iso);
      days.push({ weekday: weekdayOf(day), index: closed ? 0 : guestIndex(iso, input.forecastGuests, input.historyGuests, input.today), closed });
    }
    const context: SupplierContext = { supplier, window, days, past: pastWindowDays(supplier, input.today) };
    const lines = items
      .map((item) => lineFor(item, context, input, seriesOf(sales, item.id), coveredDays))
      .sort((a, b) => Number(b.neverRunOut) - Number(a.neverRunOut) || a.name.localeCompare(b.name));
    plans.push({ supplierId: supplier.id, supplier: supplier.name, ...window, lines });
  }
  return plans.sort((a, b) =>
    a.cutoff.localeCompare(b.cutoff) || minutesOf(a.cutoffTime) - minutesOf(b.cutoffTime) || a.supplier.localeCompare(b.supplier));
}
