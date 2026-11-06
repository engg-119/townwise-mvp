// The redacted profile (spec 11A, the AI column step): the only thing about a file that may reach a model. Built in the
// parse thread from a table's header and the first rows under it: each column's header text (at most 40 characters)
// and what kind of values it holds, and up to 15 rows with every cell replaced by a token. No data cell, figure, file
// name, ZIP entry path, sheet name, organization or location name is in it, by construction: only header text and
// tokens computed here leave this function.
import type { ColumnKind } from '../parse/columns.ts';
import { readAmount, readDateCell } from '../parse/values.ts';

export const HEADER_CHARS = 40;
export const PROFILE_ROWS = 15;

export type CellToken = '<date:iso>' | '<date:slash>' | '<int>' | '<decimal>' | '<money>' | '<empty>' | '<text>';

export interface ProfileColumn {
  readonly index: number;
  readonly header: string;
  readonly kind: ColumnKind;
  /** Share of sampled rows with a value, to one decimal. */
  readonly filled: number;
  /** How many distinct values the sampled rows hold. */
  readonly distinct: '1' | '2-10' | '11-100' | '>100';
  /** Number columns: whether every value is whole, and the median's order of magnitude (10^n); else null. */
  readonly whole: boolean | null;
  readonly magnitude: number | null;
}

export interface RedactedProfile {
  readonly columns: readonly ProfileColumn[];
  readonly rows: readonly (readonly CellToken[])[];
}

/** What one cell is, never what it says. */
export function tokenOf(cell: string): CellToken {
  const text = cell.trim();
  if (text === '') return '<empty>';
  const date = readDateCell(text);
  if (date !== null) return date.kind === 'slash' ? '<date:slash>' : '<date:iso>';
  const amount = readAmount(text);
  if (amount === null || Number.isNaN(amount)) return '<text>';
  if (text.includes('$')) return '<money>';
  return amount % 1_000_000 === 0 ? '<int>' : '<decimal>';
}

function bucket(count: number): ProfileColumn['distinct'] {
  if (count <= 1) return '1';
  if (count <= 10) return '2-10';
  return count <= 100 ? '11-100' : '>100';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The profile of a table from its header, its columns' kinds and its first rows (`sample`, under the header). */
export function redactedProfile(
  header: readonly string[], kinds: readonly ColumnKind[], sample: readonly (readonly string[])[],
): RedactedProfile {
  const columns = header.map((name, index): ProfileColumn => {
    const cells = sample.map((row) => (row[index] ?? '').trim()).filter((cell) => cell !== '');
    const kind = kinds[index] ?? 'empty';
    const amounts = kind === 'numbers'
      ? cells.map((cell) => readAmount(cell)).filter((value): value is number => value !== null && !Number.isNaN(value))
      : [];
    const middle = amounts.length === 0 ? null : Math.abs(median(amounts)) / 1_000_000;
    return {
      index,
      header: name.slice(0, HEADER_CHARS),
      kind,
      filled: sample.length === 0 ? 0 : Math.round((cells.length / sample.length) * 10) / 10,
      distinct: bucket(new Set(cells).size),
      whole: amounts.length === 0 ? null : amounts.every((value) => value % 1_000_000 === 0),
      magnitude: middle === null ? null : middle < 1 ? 0 : Math.floor(Math.log10(middle)),
    };
  });
  const rows = sample.slice(0, PROFILE_ROWS).map((row) => header.map((_, index) => tokenOf(row[index] ?? '')));
  return { columns, rows };
}
