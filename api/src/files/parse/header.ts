// The server's additions to the browser's column logic (spec 11A): finding the header row under a title block, and the
// longer header guess lists. [CONFIRM: header guesses]
import { isBlankRecord } from './csv.ts';
import { lacksHeader } from './columns.ts';

/** Header names, normalized as columns.ts does: trimmed, lower case, runs of spaces and underscores as one space. */
export function normalizedHeader(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/** Earlier names in each list first. */
export const HEADER_GUESSES = {
  date: ['business date', 'date', 'day', 'order date', 'opened date', 'closed date'],
  guests: ['guests', 'covers', 'guest count', 'total guests', 'number of guests', '# of guests'],
  netSales: ['net sales', 'net amount', 'net revenue', 'sales (net)', 'net'],
  location: ['location', 'restaurant', 'store', 'site'],
  check: ['check', 'check #', 'check number', 'order id', 'order #', 'order number'],
  item: ['item', 'menu item', 'qty', 'quantity', 'modifier'],
} as const;

export type GuessKind = keyof typeof HEADER_GUESSES;

/**
 * The columns whose header is the best-ranked name of the list, in column order: one column is a clear guess, more
 * than one (two columns with the same name) is a tie. Empty when no header is on the list.
 */
export function guessesFor(kind: GuessKind, names: readonly string[]): number[] {
  const keys = names.map(normalizedHeader);
  for (const candidate of HEADER_GUESSES[kind]) {
    const found = keys.flatMap((key, index) => (key === candidate ? [index] : []));
    if (found.length > 0) return found;
  }
  return [];
}

/** The single guessed column, or null for none or a tie. */
export function guessOne(kind: GuessKind, names: readonly string[]): number | null {
  const found = guessesFor(kind, names);
  return found.length === 1 ? found[0] ?? null : null;
}

export function hasAny(kind: GuessKind, names: readonly string[]): boolean {
  const keys = new Set(names.map(normalizedHeader));
  return HEADER_GUESSES[kind].some((candidate) => keys.has(candidate));
}

function namedCells(record: readonly string[]): number {
  return record.filter((cell) => cell.trim() !== '').length;
}

export type HeaderSearch =
  | { kind: 'found'; index: number }
  /** No record in the search has two or more filled cells: not a table. */
  | { kind: 'not_a_table' }
  /** Records with several cells, none of them a header (the first is data, or every one is). */
  | { kind: 'no_header' };

/**
 * The header row among the first records: the first with at least two filled cells that is a header (lacksHeader
 * says no) and names a date column, else the first such header at all.
 */
export function findHeader(records: readonly (readonly string[])[]): HeaderSearch {
  let firstHeader: number | null = null;
  let anyTable = false;
  for (const [index, record] of records.entries()) {
    if (isBlankRecord(record) || namedCells(record) < 2) continue;
    anyTable = true;
    if (lacksHeader(record)) continue;
    if (guessesFor('date', record).length > 0) return { kind: 'found', index };
    firstHeader ??= index;
  }
  if (firstHeader !== null) return { kind: 'found', index: firstHeader };
  return anyTable ? { kind: 'no_header' } : { kind: 'not_a_table' };
}
