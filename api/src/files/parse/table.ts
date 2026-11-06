// One table read in two passes (spec 11A): the first finds the header row, profiles every column over every row (so a
// date order is proven or not over the whole table) and collects the location column's values; the mapping is decided
// between the passes; the second adds rows up per date. Rows are handed in one at a time and never kept, so a table
// streamed from a 200 MiB file holds only its first 30 records, the profiles and the per-date totals.
import { isBlankRecord } from './csv.ts';
import { LocationValues, Profiler, type ColumnProfile } from './columns.ts';
import { DayAggregator, type DaysResult, type ExclusionReason, type RowTally, type SalesDay } from './days.ts';
import { findHeader, guessOne } from './header.ts';
import {
  decideMappingWithModel, decideRowMode, type ChooseColumns, type Decider, type DecidedBy, type Decision, type FirstPass, type KeptOutcome,
  type QuestionDraft,
} from './mapping.ts';
import type { SheetAnswers } from '../../stores/files.ts';
import type { Delimiter } from './csv.ts';
import { HEADER_SEARCH_ROWS, MAX_CLOSED_DATES, MAX_COLUMNS, MAX_ROWS } from '../limits.ts';

/** What a used table's report says (spec 11A): header names, row numbers, dates and counts; no data cell except the
 *  location value the rules or the person chose. */
export interface TableReport {
  headerRow: number;
  mapping: { date: string; guests: string | null; netSales: string | null; location: string | null };
  decidedBy: DecidedBy & { rowMode: Decider };
  locationValue: string | null;
  rowMode: 'day' | 'check';
  dateOrder: 'month_first' | 'day_first' | null;
  rows: number;
  days: number;
  skipped: { noDate: RowTally; badNumber: RowTally; otherLocation: number };
  /** At most 50. */
  excluded: { date: string; reason: ExclusionReason }[];
  firstDate: string;
  lastDate: string;
  guestsDayCount: number;
  netSalesDayCount: number;
  /** Guests 0 and net sales 0 or none; at most 60. */
  closedDates: string[];
  missingDays: number;
}

export type TableOutcome =
  | { kind: 'kept'; outcome: KeptOutcome }
  | { kind: 'question'; question: QuestionDraft }
  | { kind: 'days'; days: SalesDay[]; report: TableReport };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows kept for the AI column step's profile (only tokens and the header leave the thread). */
const PROFILE_SAMPLE_ROWS = 200;

/** At most 200 columns of a record. */
export function trimmed(cells: readonly string[]): string[] {
  return cells.length > MAX_COLUMNS ? cells.slice(0, MAX_COLUMNS) : [...cells];
}

/**
 * What a first pass learns about a table's columns from the rows under its header: each column's profile and the
 * location column's values. A ZIP's tables of one family (the same header) share one, so a date order is proven over
 * all of them together.
 */
export class TableStats {
  readonly header: readonly string[];
  private readonly profiler: Profiler;
  private readonly locationColumn: number | null;
  private readonly locations: LocationValues | null;
  private readonly sample: string[][] = [];

  constructor(header: readonly string[]) {
    this.header = header;
    this.profiler = new Profiler(header);
    this.locationColumn = guessOne('location', header);
    this.locations = this.locationColumn === null ? null : new LocationValues(this.locationColumn);
  }

  add(row: readonly string[]): void {
    this.profiler.add(row);
    this.locations?.add(row);
    if (this.sample.length < PROFILE_SAMPLE_ROWS) this.sample.push([...row]);
  }

  /** The findings, with the header row of the table they are reported for (1-based). */
  firstPass(headerRow: number): FirstPass {
    return {
      header: this.header,
      headerRow,
      profiles: this.profiler.finish(),
      locationColumn: this.locationColumn,
      locationValues: this.locations?.values() ?? [],
      tooManyLocations: this.locations?.more ?? false,
      sample: this.sample,
    };
  }
}

/**
 * The first pass. `add` takes every record in order, the header and anything above it included. `adopt` gives the
 * stats the rows under a found header go to (a ZIP family's); by default the table has its own.
 */
export class FirstPassReader {
  private readonly head: string[][] = [];
  private readonly adopt: (header: readonly string[]) => TableStats;
  private stats: TableStats | null = null;
  private headerRow = 0;
  private search: ReturnType<typeof findHeader> | null = null;
  rows = 0;
  /** More rows than the reader takes (2,000,000). */
  tooMany = false;

  constructor(adopt: (header: readonly string[]) => TableStats = (header) => new TableStats(header)) {
    this.adopt = adopt;
  }

  add(cells: readonly string[]): void {
    this.rows += 1;
    if (this.rows > MAX_ROWS) {
      this.tooMany = true;
      return;
    }
    if (this.search === null) {
      this.head.push(trimmed(cells));
      if (this.head.length >= HEADER_SEARCH_ROWS) this.settleHeader();
      return;
    }
    this.data(cells);
  }

  private settleHeader(): void {
    this.search = findHeader(this.head);
    if (this.search.kind !== 'found') return;
    const index = this.search.index;
    const header = (this.head[index] ?? []).map((name) => name.trim());
    this.headerRow = index + 1;
    this.stats = this.adopt(header);
    for (const cells of this.head.slice(index + 1)) this.data(cells);
    this.head.length = 0;
  }

  private data(cells: readonly string[]): void {
    if (this.stats === null || isBlankRecord(cells)) return;
    this.stats.add(trimmed(cells));
  }

  /** The first pass's findings, or why the table cannot be read. */
  finish(): FirstPass | { kind: 'kept'; outcome: KeptOutcome } {
    if (this.tooMany) return { kind: 'kept', outcome: 'too_complex' };
    if (this.search === null) this.settleHeader();
    const search = this.search ?? findHeader([]);
    if (search.kind !== 'found' || this.stats === null) {
      return { kind: 'kept', outcome: search.kind === 'found' ? 'no_header' : search.kind };
    }
    return this.stats.firstPass(this.headerRow);
  }
}

/** The second pass: rows after the header, added up per date under the decided mapping. */
export class SecondPassReader {
  private readonly aggregator: DayAggregator;
  private readonly headerRow: number;
  private row = 0;

  constructor(decision: Extract<Decision, { kind: 'mapping' }>, input: { headerRow: number; rowMode: 'day' | 'check'; latest: string; delimiter: Delimiter }) {
    this.aggregator = new DayAggregator({ ...decision.mapping, rowMode: input.rowMode }, input.latest, input.delimiter);
    this.headerRow = input.headerRow;
  }

  add(cells: readonly string[]): void {
    this.row += 1;
    if (this.row <= this.headerRow || this.row > MAX_ROWS) return;
    this.aggregator.add(trimmed(cells), this.row);
  }

  repeatedDays(): number {
    return this.aggregator.repeatedDays();
  }

  finish(): ReturnType<DayAggregator['finish']> {
    return this.aggregator.finish();
  }
}

/** A used table's report, from its first pass, its mapping, its row mode and its days. */
export function tableReport(
  pass: FirstPass, decision: Extract<Decision, { kind: 'mapping' }>, rowMode: 'day' | 'check', rowModeBy: Decider,
  result: DaysResult,
): TableReport {
  const { mapping } = decision;
  const name = (index: number | null): string | null => (index === null ? null : pass.header[index] ?? null);
  const days = result.days;
  const first = days[0]?.date ?? '';
  const last = days.at(-1)?.date ?? '';
  const span = first === '' ? 0 : (Date.parse(last) - Date.parse(first)) / DAY_MS + 1;
  const profile: ColumnProfile | undefined = mapping.date === null ? undefined : pass.profiles[mapping.date];
  return {
    headerRow: pass.headerRow,
    mapping: { date: name(mapping.date) ?? '', guests: name(mapping.guests), netSales: name(mapping.netSales), location: name(mapping.location) },
    decidedBy: { ...decision.decidedBy, rowMode: rowModeBy },
    locationValue: mapping.locationValue,
    rowMode,
    dateOrder: profile?.slashDates === true ? mapping.dateOrder : null,
    rows: result.rows,
    days: days.length,
    skipped: { noDate: result.noDate, badNumber: result.badNumber, otherLocation: result.otherLocation },
    excluded: result.excluded.slice(0, 50),
    firstDate: first,
    lastDate: last,
    guestsDayCount: days.filter((day) => day.guests !== null).length,
    netSalesDayCount: days.filter((day) => day.netSalesCents !== null).length,
    closedDates: days.filter((day) => day.guests === 0 && (day.netSalesCents ?? 0) === 0).map((day) => day.date).slice(0, MAX_CLOSED_DATES),
    missingDays: Math.max(0, span - days.length),
  };
}

/**
 * Reads one table: `pass(visit)` hands every record of the table, in order, to `visit`, and is called once or twice.
 * `answers` are the person's for this table, `locationName` matches a location column's value, and `delimiter` is
 * read after the first pass (a streamed text file learns it from its first bytes).
 */
export async function readTable(
  pass: (visit: (cells: readonly string[]) => void) => Promise<void>,
  input: { answers: SheetAnswers; locationName: string; latest: string; delimiter: () => Delimiter; choose?: ChooseColumns },
): Promise<TableOutcome> {
  const first = new FirstPassReader();
  await pass((cells) => { first.add(cells); });
  const found = first.finish();
  if ('kind' in found) return found;
  const decision = await decideMappingWithModel(found, input.answers, input.locationName, input.choose);
  if (decision.kind !== 'mapping') return decision;
  if (input.answers.rowMode === 'item') return { kind: 'kept', outcome: 'item_level' };
  // Day mode only when the person said so; otherwise add up, and tell the row mode from the repeats afterwards.
  const rowMode = input.answers.rowMode === 'day' ? 'day' : 'check';
  const second = new SecondPassReader(decision, { headerRow: found.headerRow, rowMode, latest: input.latest, delimiter: input.delimiter() });
  await pass((cells) => { second.add(cells); });
  const result = second.finish();
  if (result.kind !== 'days') return { kind: 'kept', outcome: result.kind };
  const mode = decideRowMode(second.repeatedDays(), found.header, input.answers.rowMode);
  if (mode.kind !== 'mode') return mode;
  return { kind: 'days', days: result.days, report: tableReport(found, decision, mode.rowMode, mode.by, result) };
}

/** A report's totals over merged days (several sheets, or several tables of a ZIP). */
export function dayTotals(days: readonly SalesDay[]): Pick<TableReport, 'firstDate' | 'lastDate' | 'guestsDayCount' | 'netSalesDayCount' | 'closedDates' | 'missingDays' | 'days'> {
  const first = days[0]?.date ?? '';
  const last = days.at(-1)?.date ?? '';
  const span = first === '' ? 0 : (Date.parse(last) - Date.parse(first)) / DAY_MS + 1;
  return {
    days: days.length,
    firstDate: first,
    lastDate: last,
    guestsDayCount: days.filter((day) => day.guests !== null).length,
    netSalesDayCount: days.filter((day) => day.netSalesCents !== null).length,
    closedDates: days.filter((day) => day.guests === 0 && (day.netSalesCents ?? 0) === 0).map((day) => day.date).slice(0, MAX_CLOSED_DATES),
    missingDays: Math.max(0, span - days.length),
  };
}
