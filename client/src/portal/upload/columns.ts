import { provenOrder, readAmount, readDateCell, type DateOrder } from './values';

// What the Match columns step knows about a file (spec 11.2 steps 1 and 2): each column's header and the kind
// of values in its first 200 non-empty cells, which date order its slash dates prove, the header guesses, and
// the distinct values of the one column the person names as locations. No cell is kept here except those
// location values (D11).

/** 50 MB [CONFIRM: 50 MB]. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Cells sampled per column for its kind. */
export const SAMPLE_CELLS = 200;
/** Distinct values offered for the location column. */
export const MAX_LOCATION_VALUES = 50;

export type ColumnKind = 'dates' | 'numbers' | 'text' | 'empty';

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  /** True when any cell is a slash date, so the person confirms the order. */
  slashDates: boolean;
  /** The order the column's slash dates prove (a part above 12), or null when they read either way or prove both. */
  order: DateOrder | null;
  /** Some slash dates prove day first and others month first, so the person chooses and the page says why. */
  mixedOrder: boolean;
}

/** File checks before reading: the size, then the extension (`.csv` or `.txt`). */
export function checkFile(file: { name: string; size: number }): 'too_large' | 'not_csv' | null {
  if (file.size > MAX_FILE_BYTES) return 'too_large';
  return /\.(csv|txt)$/i.test(file.name) ? null : 'not_csv';
}

/** A spreadsheet or other binary file read as text: a ZIP (xlsx) signature, or a NUL near the start. */
export function looksBinary(text: string): boolean {
  return text.startsWith('PK\u0003\u0004') || text.slice(0, 4096).includes('\u0000');
}

/** A cell that reads as a date or an amount: a value, never a name. */
export function isValueCell(cell: string): boolean {
  return readDateCell(cell) !== null || !Number.isNaN(readAmount(cell) ?? NaN);
}

/**
 * No header row: the file is empty, any cell of its first row reads as a date, or every non-empty one is a number.
 * Such a first row is data, so none of its cells may become a column label (D11): the file is refused.
 */
export function lacksHeader(header: readonly string[] | null): boolean {
  if (header === null) return true;
  const named = header.filter((cell) => cell.trim() !== '');
  return named.length === 0 || named.some((cell) => readDateCell(cell) !== null) || named.every(isValueCell);
}

interface ColumnTally {
  sampled: number;
  dates: number;
  numbers: number;
  slashDates: boolean;
  monthFirst: boolean;
  dayFirst: boolean;
}

/** Profiles a file's columns from its header and every row after it. */
export class Profiler {
  private readonly names: string[];
  private readonly tallies: ColumnTally[];

  constructor(header: readonly string[]) {
    this.names = header.map((name) => name.trim());
    this.tallies = header.map(() => ({ sampled: 0, dates: 0, numbers: 0, slashDates: false, monthFirst: false, dayFirst: false }));
  }

  add(cells: readonly string[]): void {
    const count = Math.min(cells.length, this.tallies.length);
    for (let index = 0; index < count; index += 1) {
      const cell = cells[index] ?? '';
      const tally = this.tallies[index];
      if (tally === undefined) continue;
      const sampling = tally.sampled < SAMPLE_CELLS;
      // Only cells with a slash can be slash dates, and the order needs every one of them.
      if (!sampling && !cell.includes('/')) continue;
      if (cell.trim() === '') continue;
      const date = readDateCell(cell);
      if (date?.kind === 'slash') {
        tally.slashDates = true;
        const proven = provenOrder(date);
        if (proven === 'month_first') tally.monthFirst = true;
        if (proven === 'day_first') tally.dayFirst = true;
      }
      if (!sampling) continue;
      tally.sampled += 1;
      if (date !== null) tally.dates += 1;
      else if (!Number.isNaN(readAmount(cell) ?? NaN)) tally.numbers += 1;
    }
  }

  finish(): ColumnProfile[] {
    return this.names.map((name, index) => {
      const tally = this.tallies[index] ?? { sampled: 0, dates: 0, numbers: 0, slashDates: false, monthFirst: false, dayFirst: false };
      const text = tally.sampled - tally.dates - tally.numbers;
      let kind: ColumnKind = 'empty';
      if (tally.sampled > 0) kind = tally.dates >= tally.numbers && tally.dates >= text ? 'dates' : tally.numbers >= text ? 'numbers' : 'text';
      // Spec 11.2: a first part above 12 sets the order. A second part above 12 proves month first the same way.
      // When cells prove both, no order fits every row, so the person chooses.
      const mixedOrder = tally.dayFirst && tally.monthFirst;
      const order: DateOrder | null = mixedOrder ? null : tally.dayFirst ? 'day_first' : tally.monthFirst ? 'month_first' : null;
      return { name, kind, slashDates: tally.slashDates, order, mixedOrder };
    });
  }
}

function normalized(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

const GUESSES = {
  date: ['business date', 'date'],
  guests: ['guests', 'covers', 'guest count'],
  netSales: ['net sales'],
} as const;

export interface Guesses { date: number | null; guests: number | null; netSales: number | null }

/** Spec 11.2 header guesses [CONFIRM: header guesses], earlier names in each list first. */
export function guessColumns(names: readonly string[]): Guesses {
  const keys = names.map(normalized);
  const find = (candidates: readonly string[]): number | null => {
    for (const candidate of candidates) {
      const index = keys.indexOf(candidate);
      if (index !== -1) return index;
    }
    return null;
  };
  return { date: find(GUESSES.date), guests: find(GUESSES.guests), netSales: find(GUESSES.netSales) };
}

/** The distinct values of the location column (trimmed, non-empty), up to 50. */
export class LocationValues {
  private readonly column: number;
  private readonly seen = new Set<string>();
  /** More than 50 distinct values: collecting stops. */
  more = false;

  constructor(column: number) {
    this.column = column;
  }

  /** False once there are more than 50 values, so the caller can stop reading. */
  add(cells: readonly string[]): boolean {
    const value = (cells[this.column] ?? '').trim();
    if (value === '' || this.seen.has(value)) return true;
    if (this.seen.size >= MAX_LOCATION_VALUES) {
      this.more = true;
      return false;
    }
    this.seen.add(value);
    return true;
  }

  values(): string[] {
    return [...this.seen].sort((a, b) => a.localeCompare(b));
  }
}
