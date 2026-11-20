import { isBlankRecord, type Delimiter } from './csv';
import { centsOf, readAmount, readDateCell, readGuests, resolveDate, type DateOrder } from './values';

// Check the totals (spec 11.2 step 3): rows become days, with the skipped rows and left-out days counted, then
// the request body of 11.1. The client applies the server's rules of 11.3 first, so a 400 means a client bug.

/** Spec 11.3. */
export const EARLIEST_DATE = '2010-01-01';
export const MAX_GUESTS = 20_000;
export const MAX_NET_SALES_CENTS = 100_000_000;
export const MAX_DAYS = 3660;
/** The upload route's body parser, `express.json({ limit: '256kb' })` (api/src/access/routes.ts). */
export const MAX_BODY_BYTES = 256 * 1024;
/** Row numbers listed per reason, and left-out days listed by date. */
export const LIST_LIMIT = 10;

export type RowMode = 'day' | 'check' | 'item';

export interface Mapping {
  rowMode: RowMode;
  date: number | null;
  guests: number | null;
  netSales: number | null;
  location: number | null;
  /** The value of the location column that is this location. */
  locationValue: string | null;
  dateOrder: DateOrder;
}

/** Spec 10.1 SalesDay: the only thing that leaves the browser (11.1). */
export interface SalesDay { date: string; guests: number | null; netSalesCents: number | null }

export type ExclusionReason = 'after_tomorrow' | 'before_earliest' | 'negative' | 'guests_cap' | 'sales_cap' | 'no_value';

/** A count, with the first row numbers (never a value). */
export interface RowTally { count: number; rows: number[] }

export interface DaysResult {
  kind: 'days';
  /** Oldest first. */
  days: SalesDay[];
  /** Rows that went into `days`. */
  rows: number;
  noDate: RowTally;
  badNumber: RowTally;
  otherLocation: number;
  /** Oldest first, all of them; the screen lists the first 10. */
  excluded: { date: string; reason: ExclusionReason }[];
  guestsMapped: boolean;
  netSalesMapped: boolean;
  /** One row is one check or order, so rows that share a date were added up. */
  addedUp: boolean;
}

export type CheckResult =
  | DaysResult
  | { kind: 'no_dates' }
  /** A semicolon file whose net sales may use a decimal comma (1.234,50): refused rather than misread. */
  | { kind: 'decimal_comma' }
  | { kind: 'repeated_dates'; dates: number; repeats: RowTally }
  | { kind: 'too_many_days'; days: number };

/** The latest date the server accepts is its UTC date plus one; the copy says “after tomorrow” in local time. */
export function latestDate(now: Date): string {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const localTomorrow = `${String(local.getFullYear())}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const utcTomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return localTomorrow < utcTomorrow ? localTomorrow : utcTomorrow;
}

function tally(): RowTally {
  return { count: 0, rows: [] };
}

function count(into: RowTally, row: number): void {
  into.count += 1;
  if (into.rows.length < LIST_LIMIT) into.rows.push(row);
}

interface DayTotal { guests: number | null; micros: number | null; rows: number }

/**
 * How a semicolon file's net sales read with a dot and with a comma for decimals. Semicolons are the separator
 * where a comma marks decimals, so there 1.234 may be one thousand and 12,50 twelve and a half. Townwise reads only
 * a dot for decimals, so such a file goes on only when a cell proves the dot (980.00) and none needs the comma.
 */
interface MoneyMarks { dotOnly: boolean; commaOnly: boolean; eitherWay: boolean }

/** Adds rows up per date for one mapping. `latest` is the last date allowed (`latestDate`). */
export class DayAggregator {
  private readonly mapping: Mapping;
  private readonly latest: string;
  /** Checked on semicolon files only; null otherwise. */
  private readonly marks: MoneyMarks | null;
  private readonly totals = new Map<string, DayTotal>();
  private readonly noDate = tally();
  private readonly badNumber = tally();
  private readonly repeats = tally();
  private readonly repeatedDates = new Set<string>();
  private otherLocation = 0;
  private dated = 0;

  /** `delimiter` is the file's (csv.ts detectDelimiter). */
  constructor(mapping: Mapping, latest: string, delimiter: Delimiter = ',') {
    this.mapping = mapping;
    this.latest = latest;
    this.marks = delimiter === ';' && mapping.netSales !== null ? { dotOnly: false, commaOnly: false, eitherWay: false } : null;
  }

  private noteMarks(cell: string): void {
    const marks = this.marks;
    if (marks === null) return;
    const dot = readAmount(cell);
    if (dot === null) return;
    const comma = readAmount(cell, ',') ?? NaN;
    const dotReads = !Number.isNaN(dot);
    const commaReads = !Number.isNaN(comma);
    if (dotReads && !commaReads) marks.dotOnly = true;
    else if (!dotReads && commaReads) marks.commaOnly = true;
    else if (dotReads && comma !== dot) marks.eitherWay = true;
  }

  /** One data row; `row` is its spreadsheet row number (the header is row 1). */
  add(cells: readonly string[], row: number): void {
    if (isBlankRecord(cells)) return;
    const { mapping } = this;
    if (mapping.location !== null && (cells[mapping.location] ?? '').trim() !== mapping.locationValue) {
      this.otherLocation += 1;
      return;
    }
    const cell = mapping.date === null ? null : readDateCell(cells[mapping.date] ?? '');
    const date = cell === null ? null : resolveDate(cell, mapping.dateOrder);
    if (date === null) {
      count(this.noDate, row);
      return;
    }
    this.dated += 1;
    const guests = mapping.guests === null ? null : readGuests(cells[mapping.guests] ?? '');
    const sales = mapping.netSales === null ? null : cells[mapping.netSales] ?? '';
    if (sales !== null) this.noteMarks(sales);
    const micros = sales === null ? null : readAmount(sales);
    if (Number.isNaN(guests ?? 0) || Number.isNaN(micros ?? 0)) {
      count(this.badNumber, row);
      return;
    }
    const total = this.totals.get(date);
    if (total === undefined) {
      this.totals.set(date, { guests, micros, rows: 1 });
      return;
    }
    if (mapping.rowMode === 'day') {
      this.repeatedDates.add(date);
      count(this.repeats, row);
      return;
    }
    total.rows += 1;
    if (guests !== null) total.guests = (total.guests ?? 0) + guests;
    if (micros !== null) total.micros = (total.micros ?? 0) + micros;
  }

  finish(): CheckResult {
    if (this.dated === 0) return { kind: 'no_dates' };
    const marks = this.marks;
    if (marks !== null && (marks.commaOnly || (marks.eitherWay && !marks.dotOnly))) return { kind: 'decimal_comma' };
    if (this.repeatedDates.size > 0) return { kind: 'repeated_dates', dates: this.repeatedDates.size, repeats: this.repeats };
    const days: SalesDay[] = [];
    const excluded: DaysResult['excluded'] = [];
    let rows = 0;
    for (const date of [...this.totals.keys()].sort()) {
      const total = this.totals.get(date);
      if (total === undefined) continue;
      const day: SalesDay = { date, guests: total.guests, netSalesCents: total.micros === null ? null : centsOf(total.micros) };
      const reason = exclusionOf(day, this.latest);
      if (reason === null) {
        days.push(day);
        rows += total.rows;
      } else {
        excluded.push({ date, reason });
      }
    }
    if (days.length > MAX_DAYS) return { kind: 'too_many_days', days: days.length };
    return {
      kind: 'days',
      days,
      rows,
      noDate: this.noDate,
      badNumber: this.badNumber,
      otherLocation: this.otherLocation,
      excluded,
      guestsMapped: this.mapping.guests !== null,
      netSalesMapped: this.mapping.netSales !== null,
      addedUp: this.mapping.rowMode === 'check',
    };
  }
}

/** Why a day can't be sent (spec 11.2 step 3, the rules of 11.3), or null. */
export function exclusionOf(day: SalesDay, latest: string): ExclusionReason | null {
  if (day.date > latest) return 'after_tomorrow';
  if (day.date < EARLIEST_DATE) return 'before_earliest';
  if ((day.guests ?? 0) < 0 || (day.netSalesCents ?? 0) < 0) return 'negative';
  if ((day.guests ?? 0) > MAX_GUESTS) return 'guests_cap';
  if ((day.netSalesCents ?? 0) > MAX_NET_SALES_CENTS) return 'sales_cap';
  if (day.guests === null && day.netSalesCents === null) return 'no_value';
  return null;
}

/** The request body of spec 11.1: exactly `{ days }`, each day exactly its three keys. */
export function uploadBody(days: readonly SalesDay[]): { days: SalesDay[] } {
  return { days: days.map((day) => ({ date: day.date, guests: day.guests, netSalesCents: day.netSalesCents })) };
}

/** The body's size on the wire. It is ASCII (dates, digits, null), so characters are bytes. */
export function bodyBytes(body: { days: SalesDay[] }): number {
  return JSON.stringify(body).length;
}

/** Totals over the days to send: guests, and net sales in cents. */
export function totalsOf(days: readonly SalesDay[]): { guests: number; netSalesCents: number } {
  let guests = 0;
  let netSalesCents = 0;
  for (const day of days) {
    guests += day.guests ?? 0;
    netSalesCents += day.netSalesCents ?? 0;
  }
  return { guests, netSalesCents };
}

