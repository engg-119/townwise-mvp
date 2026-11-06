// Deciding a table's mapping (spec 11A, the reader's rules): which column holds the date, its order, guests, net
// sales, the location value, and what one row is. Rules first; the person's answers override them; anything the rules
// cannot settle becomes one question, whose options are header names, the location column's values or fixed ids,
// never other cells. Pure, so it runs inside the parse thread.
import type { QuestionKind } from '../../stores/imports.ts';
import type { SheetAnswers } from '../../stores/files.ts';
import type { ColumnProfile } from './columns.ts';
import type { Mapping, RowMode } from './days.ts';
import { guessesFor, guessOne, hasAny } from './header.ts';
import type { DateOrder } from './values.ts';

export type Decider = 'rules' | 'you';

/** Every reason a table, or a whole file, is kept without being used (spec 11A.6). */
export type KeptOutcome =
  | 'not_a_table' | 'no_header' | 'no_dates' | 'notes_not_read_yet' | 'too_many_locations' | 'item_level'
  | 'decimal_comma' | 'repeated_dates' | 'too_many_days' | 'too_complex' | 'bad_encoding' | 'not_a_workbook'
  | 'no_sales_columns' | 'too_large_to_read' | 'encrypted' | 'old_excel' | 'old_word' | 'numbers' | 'image' | 'type_not_read'
  | 'pdf_no_table' | 'pdf_scanned' | 'word_no_table'
  | 'zip_too_big' | 'zip_bomb' | 'zip_damaged' | 'zip_empty' | 'nothing_usable';

export interface QuestionDraft {
  readonly kind: QuestionKind;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly suggested: string | null;
}

/** What the first pass over a table learned. */
export interface FirstPass {
  /** Header names, trimmed, at most 200. */
  readonly header: readonly string[];
  /** 1-based, as a spreadsheet shows. */
  readonly headerRow: number;
  readonly profiles: readonly ColumnProfile[];
  /** The guessed location column, if any, and its distinct values (at most 50). */
  readonly locationColumn: number | null;
  readonly locationValues: readonly string[];
  readonly tooManyLocations: boolean;
}

export interface DecidedBy {
  readonly date: Decider;
  readonly dateOrder: Decider | null;
  readonly guests: Decider | null;
  readonly netSales: Decider | null;
  readonly location: Decider | null;
}

export type Decision =
  | { readonly kind: 'mapping'; readonly mapping: Omit<Mapping, 'rowMode'>; readonly decidedBy: DecidedBy }
  | { readonly kind: 'question'; readonly question: QuestionDraft }
  | { readonly kind: 'kept'; readonly outcome: KeptOutcome };

const NOT_SURE = { id: 'not_sure', label: 'not_sure' } as const;

function question(
  kind: QuestionKind, options: { id: string; label: string }[], suggested: string | null,
): { readonly kind: 'question'; readonly question: QuestionDraft } {
  return { kind: 'question', question: { kind, options: [...options, NOT_SURE], suggested } };
}

function columnOptions(header: readonly string[], columns: readonly number[]): { id: string; label: string }[] {
  return columns.map((index) => ({ id: `col:${String(index)}`, label: header[index] ?? '' }));
}

function inRange(header: readonly string[], index: number | null | undefined): index is number {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < header.length;
}

/** Steps 1 to 4: the date column, its order, guests and net sales, and the location value. */
export function decideMapping(pass: FirstPass, answers: SheetAnswers, locationName: string): Decision {
  const { header, profiles } = pass;

  let date: number;
  let dateBy: Decider = 'rules';
  if (inRange(header, answers.dateColumn)) {
    date = answers.dateColumn;
    dateBy = 'you';
  } else {
    const guessed = guessesFor('date', header);
    const dated = profiles.flatMap((profile, index) => (profile.kind === 'dates' ? [index] : []));
    const candidates = guessed.length > 0 ? guessed : dated;
    if (candidates.length === 0) return { kind: 'kept', outcome: 'no_dates' };
    if (candidates.length > 1) {
      return question('date_column', columnOptions(header, candidates), guessed.length > 0 ? `col:${String(candidates[0])}` : null);
    }
    date = candidates[0] ?? 0;
  }

  const profile = profiles[date];
  let dateOrder: DateOrder = 'month_first';
  let orderBy: Decider | null = null;
  if (answers.dateOrder !== undefined) {
    dateOrder = answers.dateOrder;
    orderBy = 'you';
  } else if (profile?.slashDates === true) {
    if (profile.order === null) {
      return question('date_order', [{ id: 'month_first', label: 'month_first' }, { id: 'day_first', label: 'day_first' }], null);
    }
    dateOrder = profile.order;
    orderBy = 'rules';
  }

  let guests: number | null;
  let netSales: number | null;
  let columnsBy: Decider;
  if (answers.guests !== undefined || answers.netSales !== undefined) {
    guests = inRange(header, answers.guests) ? answers.guests : null;
    netSales = inRange(header, answers.netSales) ? answers.netSales : null;
    columnsBy = 'you';
  } else {
    guests = guessOne('guests', header);
    netSales = guessOne('netSales', header);
    columnsBy = 'rules';
    if (guests === null && netSales === null) {
      const numbers = profiles.flatMap((candidate, index) => (candidate.kind === 'numbers' && index !== date ? [index] : []));
      if (numbers.length === 0) return { kind: 'kept', outcome: 'notes_not_read_yet' };
      return question('columns', [
        ...numbers.map((index) => ({ id: `guests:${String(index)}`, label: header[index] ?? '' })),
        { id: 'guests:none', label: 'none' },
        ...numbers.map((index) => ({ id: `netSales:${String(index)}`, label: header[index] ?? '' })),
        { id: 'netSales:none', label: 'none' },
      ], null);
    }
  }

  let location: number | null = null;
  let locationValue: string | null = null;
  let locationBy: Decider | null = null;
  const column = pass.locationColumn;
  if (column !== null && column !== date) {
    if (answers.locationValue !== undefined) {
      location = column;
      locationValue = answers.locationValue;
      locationBy = 'you';
    } else if (pass.tooManyLocations) {
      return { kind: 'kept', outcome: 'too_many_locations' };
    } else if (pass.locationValues.length > 1) {
      const wanted = locationName.trim().toLowerCase();
      const match = pass.locationValues.find((value) => value.toLowerCase() === wanted);
      if (match === undefined) {
        return question('location_value', pass.locationValues.map((value, index) => ({ id: `loc:${String(index)}`, label: value })), null);
      }
      location = column;
      locationValue = match;
      locationBy = 'rules';
    }
  }

  return {
    kind: 'mapping',
    mapping: { date, guests, netSales, location, locationValue, dateOrder },
    decidedBy: {
      date: dateBy, dateOrder: orderBy, guests: guests === null ? null : columnsBy, netSales: netSales === null ? null : columnsBy,
      location: locationBy,
    },
  };
}

export type RowModeDecision =
  | { readonly kind: 'mode'; readonly rowMode: 'day' | 'check'; readonly by: Decider }
  | { readonly kind: 'question'; readonly question: QuestionDraft }
  | { readonly kind: 'kept'; readonly outcome: 'item_level' | 'repeated_dates' };

/**
 * Step 6, after the table was read once added up per date: no date on two rows is day-level; repeated dates with
 * check signals and no item signals are checks, added up; item signals are item-level, which would inflate guests.
 * Otherwise the person says what one row is.
 */
export function decideRowMode(repeatedDays: number, header: readonly string[], answer: RowMode | undefined): RowModeDecision {
  if (answer === 'item') return { kind: 'kept', outcome: 'item_level' };
  if (answer === 'day') return repeatedDays > 0 ? { kind: 'kept', outcome: 'repeated_dates' } : { kind: 'mode', rowMode: 'day', by: 'you' };
  if (answer === 'check') return { kind: 'mode', rowMode: 'check', by: 'you' };
  if (repeatedDays === 0) return { kind: 'mode', rowMode: 'day', by: 'rules' };
  const items = hasAny('item', header);
  if (items) return { kind: 'kept', outcome: 'item_level' };
  if (hasAny('check', header)) return { kind: 'mode', rowMode: 'check', by: 'rules' };
  return question('row_mode', [{ id: 'day', label: 'day' }, { id: 'check', label: 'check' }, { id: 'item', label: 'item' }], null);
}
