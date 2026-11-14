import { addDays, EARLIEST_DATE } from '../locations/dates';
import { isBlankRecord } from '../upload/csv';
import { MICROS, readAmount } from '../upload/values';
import { serialToIso } from '../viewer/xlsx';
import type { ItemSalesChunk, ItemSalesDay, SetupItem } from './api';
import { normalizeName } from './setupDraft';

// Item sales from a point-of-sale export, matched in the browser (design Decision 4, the item-sales spec). The page
// reads the file; this module proposes its date, item and quantity columns (and joins a separate Time column to the
// date), reads each row's business day (a time before 04:00 belongs to the day before; a time with a UTC offset is
// first moved to the town's zone), matches each item name to the saved setup's point-of-sale names, and adds
// quantity x servings per sale to each matched item's day. It keeps only the days the board can use: before the
// town's today (still open, and refused by the server) and within the 244 days the board reads. Only item ids, dates
// and servings are ever sent: unmatched names stay in the page for the owner to add to an item. Pure.

/** The most days one POST .../orders/item-sales takes. */
export const MAX_CHUNK_DAYS = 31;
/** The most bytes of JSON one POST .../orders/item-sales sends, under the route's 256 kb body limit. */
export const MAX_CHUNK_BYTES = 250_000;
/** Days before the town's today the board reads item sales for (api/src/orders: 26 weeks, 6 days and 8 weeks). */
export const ITEM_SALES_DAYS = 244;
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

/** The columns a match reads: `time`, when the file has one, holds each row's time apart from its date (Square). */
export interface MatchColumns {
  readonly date: number;
  readonly item: number;
  readonly quantity: number;
  readonly time?: number | null;
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
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:([AaPp])\.?[Mm]\.?)?\s*(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;
const SERIAL = /^\d+(?:\.\d+)?$/;
/** A time-of-day cell from Excel: a time with no date reads as 1899-12-31Thh:mm:ss, or as its fraction of a day. */
const EXCEL_TIME = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})$/;
const DAY_FRACTION = /^0?\.\d+$/;

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

/** Seconds after midnight and the UTC offset in minutes (null when the time names none), or null when it is no time. */
function readTime(text: string): { seconds: number; offset: number | null } | null {
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
  let offset: number | null = null;
  if (match[5] !== undefined) offset = 0;
  else if (match[6] !== undefined) offset = (match[6] === '-' ? -1 : 1) * (Number(match[7]) * 60 + Number(match[8]));
  return { seconds: hours * 3600 + minutes * 60 + seconds, offset };
}

/** A separate time cell as readTime reads it: Excel's time-only forms become hh:mm:ss. */
function timeText(cell: string): string {
  const text = cell.trim();
  const excel = EXCEL_TIME.exec(text);
  if (excel !== null) return excel[1] ?? '';
  if (!DAY_FRACTION.test(text)) return text;
  const total = Math.round(Number(text) * 86_400) % 86_400;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** A bare number in the Excel serial range (so 20261101 reads as a compact date, not a serial). */
function isSerial(text: string): boolean {
  if (!SERIAL.test(text)) return false;
  const value = Number(text);
  return value >= SERIAL_RANGE.min && value < SERIAL_RANGE.max + 1;
}

/** A date cell read apart: its calendar day, its time (null for none) and the time's UTC offset (null for none). */
interface Stamp { day: string; seconds: number | null; offset: number | null }

/** Moves a UTC instant, given as a day, seconds and an offset, to a calendar day and seconds in one zone. */
type ToZone = (day: string, seconds: number, offset: number) => { day: string; seconds: number };

/** A ToZone for an IANA zone ("America/New_York"), or null when this browser doesn't know it. */
export function toZone(zone: string): ToZone | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return null;
  }
  return (day, seconds, offset) => {
    const parts = format.formatToParts(new Date(Date.parse(`${day}T00:00:00Z`) + seconds * 1000 - offset * 60_000));
    const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((each) => each.type === type)?.value ?? 0);
    const date = `${String(part('year')).padStart(4, '0')}-${String(part('month')).padStart(2, '0')}-${String(part('day')).padStart(2, '0')}`;
    return { day: date, seconds: part('hour') * 3600 + part('minute') * 60 + part('second') };
  };
}

/** A date cell (with the row's separate time cell, when the file has a Time column) read apart, or null. */
function readStamp(cell: string, time?: string): Stamp | null {
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
  const separate = time === undefined ? '' : timeText(time);
  if (separate !== '') timePart = separate;
  if (timePart === null) return { day, seconds: null, offset: null };
  const read = readTime(timePart.trim());
  return read === null ? null : { day, ...read };
}

/**
 * A stamp's business day; 'zoned' when its time carries a UTC offset and the town's zone is unknown. `calendar` is
 * the day the sale happened on in town, `moved` says a time before 04:00 moved it to the day before, and `timed`
 * that the cell had a time other than midnight.
 */
function placeStamp(stamp: Stamp, zone: ToZone | null): { date: string; calendar: string; moved: boolean; timed: boolean } | 'zoned' {
  // Exactly midnight is a date alone, even with an offset: exports write a date column that way ("2026-11-01T00:00:00Z").
  if (stamp.seconds === null || stamp.seconds === 0) return { date: stamp.day, calendar: stamp.day, moved: false, timed: false };
  let { day, seconds } = stamp;
  if (stamp.offset !== null) {
    if (zone === null) return 'zoned';
    ({ day, seconds } = zone(day, seconds, stamp.offset));
  }
  return seconds < BUSINESS_DAY_STARTS
    ? { date: addDays(day, -1), calendar: day, moved: true, timed: true }
    : { date: day, calendar: day, moved: false, timed: true };
}

/**
 * The business day a date cell names, or null when it names none: `YYYY-MM-DD`, `YYYYMMDD`, US `M/D/YYYY` (or `M/D/YY`),
 * each optionally with a time ("2026-11-01T01:30:00", "11/1/2026 1:30 AM"), or an Excel serial (45962, 45962.0625).
 * With a time before 04:00 the sale belongs to the day before. A time of exactly midnight reads as a date alone, as
 * exports print a date column that carries no time ("2026-11-01 00:00:00"). A time with a UTC offset
 * ("2026-11-02T01:30:00Z", "...-05:00") is read in `zone`, the town's; without one it names no day, since the day it
 * falls on depends on the zone.
 */
export function businessDate(cell: string, zone: string | null = null, time?: string): string | null {
  const stamp = readStamp(cell, time);
  if (stamp === null) return null;
  const placed = placeStamp(stamp, zone === null ? null : toZone(zone));
  return placed === 'zoned' ? null : placed.date;
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
  /** A sampled time carries a UTC offset (Z, -05:00): reading it needs the town's zone. */
  readonly zoned: boolean;
}

interface Tally { sampled: number; dates: number; numbers: number; serials: number; zoned: boolean }

/** A cell whose time names a UTC offset, as a date with a time or as a time alone. */
function hasOffset(cell: string): boolean {
  const stamp = readStamp(cell);
  if (stamp !== null) return stamp.offset !== null && stamp.seconds !== null && stamp.seconds !== 0;
  const time = readTime(cell);
  return time !== null && time.offset !== null;
}

/** The kind of each column, from up to 200 non-empty cells of it. Keeps no cell. */
export class ColumnSampler {
  private readonly names: readonly string[];
  private readonly tallies: Tally[];

  constructor(header: readonly string[]) {
    this.names = header.map((name) => name.trim());
    this.tallies = header.map(() => ({ sampled: 0, dates: 0, numbers: 0, serials: 0, zoned: false }));
  }

  add(cells: readonly string[]): void {
    this.tallies.forEach((tally, index) => {
      const cell = (cells[index] ?? '').trim();
      if (cell === '' || tally.sampled >= SAMPLE_CELLS) return;
      tally.sampled += 1;
      // A serial reads as a number here: a quantity column never holds one, and a date column of them is guessed by its header.
      if (hasOffset(cell)) tally.zoned = true;
      if (isSerial(cell)) {
        tally.numbers += 1;
        tally.serials += 1;
      } else if (readStamp(cell) !== null) tally.dates += 1;
      else if (readQuantity(cell) !== null) tally.numbers += 1;
    });
  }

  finish(): ColumnProfile[] {
    return this.names.map((name, index) => {
      const tally = this.tallies[index] ?? { sampled: 0, dates: 0, numbers: 0, serials: 0, zoned: false };
      const text = tally.sampled - tally.dates - tally.numbers;
      let kind: ColumnKind = 'empty';
      if (tally.sampled > 0) kind = tally.dates >= tally.numbers && tally.dates >= text ? 'dates' : tally.numbers >= text ? 'numbers' : 'text';
      return { name, kind, serials: tally.numbers > 0 && tally.serials === tally.numbers, zoned: tally.zoned };
    });
  }
}

/** A column headed Time (Square's item export), apart from the three chosen: its times join each row's date. */
export function timeColumnOf(columns: readonly ColumnProfile[], chosen: { date: number; item: number; quantity: number }): number | null {
  const at = columns.findIndex((column, index) => headerName(column.name) === 'time' && ![chosen.date, chosen.item, chosen.quantity].includes(index));
  return at === -1 ? null : at;
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
  /** The first and last business day sent, or null when no row had a usable date. */
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  /** The town's today, and the earliest date sent: the 244 days before today. */
  readonly today: string;
  readonly earliest: string;
  /** Rows after the header that are not blank. */
  readonly rowsRead: number;
  /** Rows on the days sent whose name matched at least one item. */
  readonly matchedRows: number;
  /** Per setup item id, its matched rows on the days sent; an item no row matched is left out. */
  readonly itemRows: Readonly<Record<string, number>>;
  /** Items with servings on any day. */
  readonly itemsWithSales: number;
  /**
   * Rows left out: a date Townwise can't read (`date`), a time with a UTC offset while the town's zone is unknown
   * (`zoned`), a business day of today or later (`open`), one before the 244 days (`old`), no item name, or a quantity
   * that is not a number of 0 or more.
   */
  readonly skipped: {
    readonly date: number; readonly zoned: number; readonly open: number; readonly old: number; readonly name: number; readonly quantity: number;
  };
  /** Rows whose time carried a UTC offset and was read in the town's zone. */
  readonly converted: number;
  /**
   * The file's last business day, left out: the file has times and no row is dated the day after it, so the export may
   * have stopped at midnight, before that day's sales after midnight. Null when nothing was cut.
   */
  readonly cut: string | null;
  /**
   * `cut` is sent after all (finish(true)): the person said nothing was sold after midnight that night, as at a bar
   * that closes before midnight.
   */
  readonly cutIncluded: boolean;
  /** Names no item lists, most rows first. */
  readonly unmatched: readonly UnmatchedName[];
  /** Every date sent, in order, each with the servings of its matched items (none when nothing matched). */
  readonly days: readonly ItemSalesDay[];
  /** Item-days above the 100,000 servings the server takes: a wrong quantity column, most likely. */
  readonly overLimit: number;
}

export interface MatchOptions {
  /** The town's today (GET .../orders/setup): the open business day, which is never sent. */
  readonly today: string;
  /** The town's time zone, for times with a UTC offset; null when it is unknown. */
  readonly zone: string | null;
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
  private readonly columns: MatchColumns;
  private readonly lookup: Map<string, { itemId: string; perSale: number }[]>;
  private readonly today: string;
  private readonly earliest: string;
  private readonly zone: ToZone | null;
  private readonly servings = new Map<string, Map<string, number>>();
  /** Per date, matched rows per item, and matched rows (a row under two items counts once). */
  private readonly itemRows = new Map<string, Map<string, number>>();
  private readonly matchedRows = new Map<string, number>();
  /**
   * Dates some row names as its own. A date reached only by after-midnight rows moved back (the day before a per-sale
   * export starts) holds part of a day, so it is left out rather than replacing the full day stored for it.
   */
  private readonly ownDates = new Set<string>();
  private readonly unmatched = new Map<string, { name: string; rows: number }>();
  private rowsRead = 0;
  private converted = 0;
  /** Some row has a time other than midnight. */
  private timed = false;
  /** The latest day in town any row with a readable date happened on. */
  private lastCalendar: string | null = null;
  private readonly skipped = { date: 0, zoned: 0, open: 0, old: 0, name: 0, quantity: 0 };

  constructor(columns: MatchColumns, items: readonly SetupItem[], options: MatchOptions) {
    this.columns = columns;
    this.lookup = matcherOf(items);
    this.today = options.today;
    const back = addDays(options.today, -ITEM_SALES_DAYS);
    this.earliest = back > EARLIEST_DATE ? back : EARLIEST_DATE;
    this.zone = options.zone === null ? null : toZone(options.zone);
  }

  add(cells: readonly string[]): void {
    if (isBlankRecord(cells)) return;
    this.rowsRead += 1;
    const time = this.columns.time ?? null;
    const stamp = readStamp(cells[this.columns.date] ?? '', time === null ? undefined : (cells[time] ?? ''));
    if (stamp === null) {
      this.skipped.date += 1;
      return;
    }
    const read = placeStamp(stamp, this.zone);
    if (read === 'zoned') {
      this.skipped.zoned += 1;
      return;
    }
    if (read.timed && stamp.offset !== null) this.converted += 1;
    if (read.timed) this.timed = true;
    if (this.lastCalendar === null || read.calendar > this.lastCalendar) this.lastCalendar = read.calendar;
    const { date } = read;
    if (date >= this.today) {
      this.skipped.open += 1;
      return;
    }
    if (date < this.earliest) {
      this.skipped.old += 1;
      return;
    }
    if (!read.moved) this.ownDates.add(date);
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
    this.matchedRows.set(date, (this.matchedRows.get(date) ?? 0) + 1);
    let rows = this.itemRows.get(date);
    if (rows === undefined) {
      rows = new Map();
      this.itemRows.set(date, rows);
    }
    for (const { itemId, perSale } of matches) {
      day.set(itemId, (day.get(itemId) ?? 0) + quantity * perSale);
      rows.set(itemId, (rows.get(itemId) ?? 0) + 1);
    }
  }

  /**
   * The match. `includeLast` keeps the file's last business day that `cut` would leave out, for a bar that sold nothing
   * after midnight that night. It reads only what add() kept, so it can be called again with the other choice.
   */
  finish(includeLast = false): MatchOutcome {
    const dates = [...this.servings.keys()].filter((date) => this.ownDates.has(date)).sort();
    const last = dates.at(-1);
    // No row the day after the last one: an export of times may have stopped at midnight, before its sales after midnight.
    const cut = this.timed && last !== undefined && (this.lastCalendar === null || this.lastCalendar <= last) ? last : null;
    if (cut !== null && !includeLast) dates.pop();
    const sold = new Set<string>();
    const itemRows: Record<string, number> = {};
    let matchedRows = 0;
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
      for (const [itemId, rows] of this.itemRows.get(date) ?? []) itemRows[itemId] = (itemRows[itemId] ?? 0) + rows;
      matchedRows += this.matchedRows.get(date) ?? 0;
      return { date, items };
    });
    const unmatched = [...this.unmatched.values()].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
    return {
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      today: this.today,
      earliest: this.earliest,
      rowsRead: this.rowsRead,
      matchedRows,
      itemRows,
      itemsWithSales: sold.size,
      skipped: { ...this.skipped },
      converted: this.converted,
      cut,
      cutIncluded: cut !== null && includeLast,
      unmatched,
      days,
      overLimit,
    };
  }
}

/** A chunk's JSON with no days: its from and to are always 10 characters. */
const CHUNK_FRAME = JSON.stringify({ from: '2026-01-01', to: '2026-01-01', days: [] }).length;

/**
 * The requests for `days` (in date order) over [first, last]: consecutive spans of at most 31 days from `first`, each
 * with its own from and to and only its own days, so each replaces exactly its span (a date in a span that no row
 * names is deleted on the server, as the file says nothing about it). A span whose JSON would pass `maxBytes` is
 * split where it would, into spans that still meet end to end. Each day holds at most 300 items, the setup's limit,
 * under the 500 a request takes. The JSON is ASCII (ids, dates and numbers), so its length is its size in bytes.
 */
export function chunksOf(days: readonly ItemSalesDay[], first: string, last: string, maxBytes = MAX_CHUNK_BYTES): ItemSalesChunk[] {
  const chunks: ItemSalesChunk[] = [];
  for (let from = first; from <= last; from = addDays(from, MAX_CHUNK_DAYS)) {
    const end = addDays(from, MAX_CHUNK_DAYS - 1);
    const to = end < last ? end : last;
    let start = from;
    let part: ItemSalesDay[] = [];
    let bytes = CHUNK_FRAME;
    for (const day of days) {
      if (day.date < from || day.date > to) continue;
      const size = JSON.stringify(day).length;
      if (part.length > 0 && bytes + 1 + size > maxBytes) {
        chunks.push({ from: start, to: addDays(day.date, -1), days: part });
        start = day.date;
        part = [];
        bytes = CHUNK_FRAME;
      }
      bytes += (part.length > 0 ? 1 : 0) + size;
      part.push(day);
    }
    chunks.push({ from: start, to, days: part });
  }
  return chunks;
}
