import { addDays, EARLIEST_DATE } from '../locations/dates';
import { isBlankRecord } from '../upload/csv';
import { MICROS, readAmount } from '../upload/values';
import { serialToIso } from '../viewer/xlsx';
import type { ItemSalesChunk, ItemSalesDay, SetupItem } from './api';
import { normalizeName } from './setupDraft';

// Item sales from a point-of-sale export, matched in the browser (design Decision 4, the item-sales spec). The page
// reads the file; this module proposes its date, item and quantity columns, reads each row's business day (a time
// before 04:00 belongs to the day before), matches each item name to the saved setup's point-of-sale names, and adds
// quantity x servings per sale to each matched item's day. Only item ids, dates and servings are ever sent: unmatched
// names stay in the page for the owner to add to an item. Pure.

/** The most days one POST .../orders/item-sales takes. */
export const MAX_CHUNK_DAYS = 31;
/** The most servings the server takes for one item on one day. */
export const MAX_SERVINGS = 100_000;
/** Cells sampled per column to tell its kind. */
const SAMPLE_CELLS = 200;
/** Excel serials for 2010-01-01 (the API's earliest date) and 2099-12-31: a bare number in this range can be a date. */
export const SERIAL_RANGE = { min: 40_179, max: 73_050 } as const;
/** Hours after midnight that still belong to the day before. */
const BUSINESS_DAY_STARTS = 4 * 3600;

export interface SalesColumns {
  readonly date: number | null;
  readonly item: number | null;
  readonly quantity: number | null;
}

export type PresetName = 'Toast' | 'Square' | 'clean daily';

/** Header names as each point-of-sale export writes them, compared by `headerName`. */
export const PRESETS: readonly { readonly name: PresetName; readonly date: string; readonly item: string; readonly quantity: string }[] = [
  { name: 'Toast', date: 'business date', item: 'menu item', quantity: 'item qty' },
  { name: 'Square', date: 'date', item: 'item', quantity: 'qty' },
  { name: 'clean daily', date: 'business date', item: 'menu item', quantity: 'qty sold' },
];

/** A header as presets match it: trimmed, case-folded, with spaces and underscores as one space. */
export function headerName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

// ---- Dates ---------------------------------------------------------------------------------------------------------

const DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DATE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_US = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:([AaPp])\.?[Mm]\.?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/;
const SERIAL = /^\d+(?:\.\d+)?$/;

function calendarDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function readDay(text: string): string | null {
  const iso = DATE_ISO.exec(text) ?? DATE_COMPACT.exec(text);
  if (iso !== null) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = DATE_US.exec(text);
  if (us === null) return null;
  const year = us[3] ?? '';
  return calendarDate(year.length === 2 ? 2000 + Number(year) : Number(year), Number(us[1]), Number(us[2]));
}

/** Seconds after midnight, or null when the text is no time of day. */
function readTime(text: string): number | null {
  const match = TIME.exec(text);
  if (match === null) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? '0');
  const half = match[4]?.toLowerCase();
  if (minutes > 59 || seconds > 59) return null;
  if (half === undefined) {
    if (hours > 23) return null;
  } else {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (half === 'p' ? 12 : 0);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** A bare number in the Excel serial range (so 20261101 reads as a compact date, not a serial). */
function isSerial(text: string): boolean {
  if (!SERIAL.test(text)) return false;
  const value = Number(text);
  return value >= SERIAL_RANGE.min && value < SERIAL_RANGE.max + 1;
}

/**
 * The business day a date cell names, or null when it names none: `YYYY-MM-DD`, `YYYYMMDD`, US `M/D/YYYY` (or `M/D/YY`),
 * each optionally with a time ("2026-11-01T01:30:00", "11/1/2026 1:30 AM"), or an Excel serial (45962, 45962.0625).
 * With a time before 04:00 the sale belongs to the day before. A time of exactly midnight reads as a date alone, as
 * exports print a date column that carries no time ("2026-11-01 00:00:00").
 */
export function businessDate(cell: string): string | null {
  let text = cell.trim();
  if (isSerial(text)) text = serialToIso(Number(text), false) ?? '';
  let datePart = text;
  let timePart: string | null = null;
  if (/^\d{4}-\d{1,2}-\d{1,2}T/.test(text)) {
    const t = text.indexOf('T');
    datePart = text.slice(0, t);
    timePart = text.slice(t + 1);
  } else {
    const space = /[,\s]+/.exec(text);
    if (space !== null) {
      datePart = text.slice(0, space.index);
      timePart = text.slice(space.index + space[0].length);
    }
  }
  const day = readDay(datePart);
  if (day === null) return null;
  if (timePart === null) return day;
  const seconds = readTime(timePart.trim());
  if (seconds === null) return null;
  return seconds > 0 && seconds < BUSINESS_DAY_STARTS ? addDays(day, -1) : day;
}

/** A sold quantity: a number of at least 0 ("12", "1,200", "1.5"), or null for an empty, non-numeric or negative cell. */
export function readQuantity(cell: string): number | null {
  const micros = readAmount(cell);
  if (micros === null || Number.isNaN(micros) || micros < 0) return null;
  return micros / MICROS;
}

// ---- Columns -------------------------------------------------------------------------------------------------------

export type ColumnKind = 'dates' | 'numbers' | 'text' | 'empty';

export interface ColumnProfile {
  readonly name: string;
  readonly kind: ColumnKind;
  /** Every sampled number is in the Excel serial range: the column may be dates Excel stored as numbers. */
  readonly serials: boolean;
}

interface Tally { sampled: number; dates: number; numbers: number; serials: number }

/** The kind of each column, from up to 200 non-empty cells of it. Keeps no cell. */
export class ColumnSampler {
  private readonly names: readonly string[];
  private readonly tallies: Tally[];

  constructor(header: readonly string[]) {
    this.names = header.map((name) => name.trim());
    this.tallies = header.map(() => ({ sampled: 0, dates: 0, numbers: 0, serials: 0 }));
  }

  add(cells: readonly string[]): void {
    this.tallies.forEach((tally, index) => {
      const cell = (cells[index] ?? '').trim();
      if (cell === '' || tally.sampled >= SAMPLE_CELLS) return;
      tally.sampled += 1;
      // A serial reads as a number here: a quantity column never holds one, and a date column of them is guessed by its header.
      if (isSerial(cell)) {
        tally.numbers += 1;
        tally.serials += 1;
      } else if (businessDate(cell) !== null) tally.dates += 1;
      else if (readQuantity(cell) !== null) tally.numbers += 1;
    });
  }

  finish(): ColumnProfile[] {
    return this.names.map((name, index) => {
      const tally = this.tallies[index] ?? { sampled: 0, dates: 0, numbers: 0, serials: 0 };
      const text = tally.sampled - tally.dates - tally.numbers;
      let kind: ColumnKind = 'empty';
      if (tally.sampled > 0) kind = tally.dates >= tally.numbers && tally.dates >= text ? 'dates' : tally.numbers >= text ? 'numbers' : 'text';
      return { name, kind, serials: tally.numbers > 0 && tally.serials === tally.numbers };
    });
  }
}

/** The preset whose three headers the file has, earlier presets first. */
export function presetOf(header: readonly string[]): { preset: PresetName; columns: SalesColumns } | null {
  const names = header.map(headerName);
  for (const preset of PRESETS) {
    const date = names.indexOf(preset.date);
    const item = names.indexOf(preset.item);
    const quantity = names.indexOf(preset.quantity);
    if (date !== -1 && item !== -1 && quantity !== -1) return { preset: preset.name, columns: { date, item, quantity } };
  }
  return null;
}

function pick(columns: readonly ColumnProfile[], fits: (column: ColumnProfile) => boolean, prefer: RegExp, taken: readonly (number | null)[]): number | null {
  const open = columns.map((column, index) => ({ column, index })).filter(({ column, index }) => fits(column) && !taken.includes(index));
  return (open.find(({ column }) => prefer.test(headerName(column.name))) ?? open[0])?.index ?? null;
}

/**
 * The proposed columns: a preset's when the file has its headers, else a guess: a column of dates (or of Excel serials
 * under a header that says date), a column of text, and a column of numbers, each preferring a header that names it.
 */
export function proposeColumns(columns: readonly ColumnProfile[]): { preset: PresetName | null; columns: SalesColumns } {
  const preset = presetOf(columns.map((column) => column.name));
  if (preset !== null) return preset;
  const date = pick(columns, (column) => column.kind === 'dates', /business date/, [])
    ?? pick(columns, (column) => column.kind === 'numbers' && column.serials && headerName(column.name).includes('date'), /date/, []);
  const item = pick(columns, (column) => column.kind === 'text', /item|product|name|menu/, [date]);
  const quantity = pick(columns, (column) => column.kind === 'numbers' && !column.serials, /qty|quantity|count|sold/, [date, item]);
  return { preset: null, columns: { date, item, quantity } };
}

// ---- Matching ------------------------------------------------------------------------------------------------------

export interface UnmatchedName {
  /** The name as the file first spells it, its spaces collapsed: the owner's own data, shown only on the page. */
  readonly name: string;
  readonly rows: number;
}

export interface MatchOutcome {
  /** The first and last business day of any row, or null when no row had a usable date. */
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  /** Rows after the header that are not blank. */
  readonly rowsRead: number;
  /** Rows whose name matched at least one item. */
  readonly matchedRows: number;
  /** Items with servings on any day. */
  readonly itemsWithSales: number;
  /** Rows left out: no usable date (unreadable, before 2010 or after today), no item name, or a quantity that is not a number of 0 or more. */
  readonly skipped: { readonly date: number; readonly name: number; readonly quantity: number };
  /** Names no item lists, most rows first. */
  readonly unmatched: readonly UnmatchedName[];
  /** Every date any row names, in order, each with the servings of its matched items (none when nothing matched). */
  readonly days: readonly ItemSalesDay[];
  /** Item-days above the 100,000 servings the server takes: a wrong quantity column, most likely. */
  readonly overLimit: number;
}

/** Point-of-sale name (normalized) to every item that lists it, with that item's servings per sale. */
export function matcherOf(items: readonly SetupItem[]): Map<string, { itemId: string; perSale: number }[]> {
  const byName = new Map<string, { itemId: string; perSale: number }[]>();
  for (const item of items) {
    for (const pos of item.posNames) {
      const key = normalizeName(pos.name);
      const list = byName.get(key) ?? [];
      list.push({ itemId: item.id, perSale: pos.perSale });
      byName.set(key, list);
    }
  }
  return byName;
}

/** Adds up a file's rows into item servings per business day. Keeps the unmatched names and no other cell. */
export class SalesMatcher {
  private readonly columns: { date: number; item: number; quantity: number };
  private readonly lookup: Map<string, { itemId: string; perSale: number }[]>;
  private readonly today: string;
  private readonly servings = new Map<string, Map<string, number>>();
  private readonly unmatched = new Map<string, { name: string; rows: number }>();
  private rowsRead = 0;
  private matchedRows = 0;
  private readonly skipped = { date: 0, name: 0, quantity: 0 };

  /** `today` is the latest date kept (the device's today); the server refuses later ones. */
  constructor(columns: { date: number; item: number; quantity: number }, items: readonly SetupItem[], today: string) {
    this.columns = columns;
    this.lookup = matcherOf(items);
    this.today = today;
  }

  add(cells: readonly string[]): void {
    if (isBlankRecord(cells)) return;
    this.rowsRead += 1;
    const date = businessDate(cells[this.columns.date] ?? '');
    if (date === null || date < EARLIEST_DATE || date > this.today) {
      this.skipped.date += 1;
      return;
    }
    let day = this.servings.get(date);
    if (day === undefined) {
      day = new Map();
      this.servings.set(date, day);
    }
    const name = (cells[this.columns.item] ?? '').trim().replace(/\s+/g, ' ');
    if (name === '') {
      this.skipped.name += 1;
      return;
    }
    const quantity = readQuantity(cells[this.columns.quantity] ?? '');
    if (quantity === null) {
      this.skipped.quantity += 1;
      return;
    }
    const key = normalizeName(name);
    const matches = this.lookup.get(key);
    if (matches === undefined) {
      const seen = this.unmatched.get(key);
      if (seen === undefined) this.unmatched.set(key, { name, rows: 1 });
      else seen.rows += 1;
      return;
    }
    this.matchedRows += 1;
    for (const { itemId, perSale } of matches) day.set(itemId, (day.get(itemId) ?? 0) + quantity * perSale);
  }

  finish(): MatchOutcome {
    const dates = [...this.servings.keys()].sort();
    const sold = new Set<string>();
    let overLimit = 0;
    const days = dates.map((date): ItemSalesDay => {
      const items: Record<string, number> = {};
      for (const [itemId, total] of this.servings.get(date) ?? []) {
        // Thousandths, so 0.1 x 3 sends 0.3.
        const servings = Math.round(total * 1000) / 1000;
        if (servings <= 0) continue;
        if (servings > MAX_SERVINGS) overLimit += 1;
        items[itemId] = servings;
        sold.add(itemId);
      }
      return { date, items };
    });
    const unmatched = [...this.unmatched.values()].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
    return {
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      rowsRead: this.rowsRead,
      matchedRows: this.matchedRows,
      itemsWithSales: sold.size,
      skipped: { ...this.skipped },
      unmatched,
      days,
      overLimit,
    };
  }
}

/**
 * The requests for `days` over [first, last]: consecutive spans of at most 31 days from `first`, each with its own
 * from and to and only its own days, so each replaces exactly its span (a date in a span that no row names is
 * deleted on the server, as the file says nothing about it). Each day holds at most 300 items, the setup's limit,
 * under the 500 a request takes.
 */
export function chunksOf(days: readonly ItemSalesDay[], first: string, last: string): ItemSalesChunk[] {
  const chunks: ItemSalesChunk[] = [];
  for (let from = first; from <= last; from = addDays(from, MAX_CHUNK_DAYS)) {
    const end = addDays(from, MAX_CHUNK_DAYS - 1);
    const to = end < last ? end : last;
    chunks.push({ from, to, days: days.filter((day) => day.date >= from && day.date <= to) });
  }
  return chunks;
}
