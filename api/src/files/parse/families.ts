// Tables of a ZIP grouped into families (spec 11A): exports such as a POS data export hold many files of a few shapes
// (one per day, per kind of report). A family is every table with the same normalized header row. Its mapping is
// decided once, on the stats of all its tables together, and one DayAggregator runs across all of them, so
// check-level rows split across daily files add up per date. Families that map to sales are ranked, and each adds
// only dates no higher-ranked family produced, so two report types covering the same days are never added together.
// Runs inside the parse thread; raw rows never leave it.
import { createHash } from 'node:crypto';

import { MAX_REPORTED_FAMILIES, MAX_ROWS } from '../limits.ts';
import type { FileAnswers } from '../../stores/files.ts';
import type { Delimiter } from './csv.ts';
import { DayAggregator, MAX_DAYS, type SalesDay } from './days.ts';
import { guessesFor, normalizedHeader } from './header.ts';
import { decideMappingWithModel, decideRowMode, type ChooseColumns, type Decider, type Decision, type KeptOutcome, type QuestionDraft } from './mapping.ts';
import { dayTotals, FirstPassReader, TableStats, tableReport, trimmed, type TableReport } from './table.ts';

/** A table cannot be read for a reason of its own (its entry's encoding, say); the others carry on. */
export class TableKept extends Error {
  readonly outcome: KeptOutcome;
  constructor(outcome: KeptOutcome) {
    super(outcome);
    this.name = 'TableKept';
    this.outcome = outcome;
  }
}

/** One table of the archive: a text entry, or one sheet or table of an entry. */
export interface TableSource {
  /** Hands every record, in order, to `visit`; called once per pass. May throw TableKept. */
  visit(visit: (cells: readonly string[]) => void): Promise<void>;
  /** The table's delimiter, known after its first pass (a semicolon file's decimal comma check needs it). */
  delimiter(): Delimiter;
  /** A text entry's table: one with a calendar export's header is kept `calendar_export` (D58). */
  readonly text?: boolean;
}

/** What became of one table. */
export interface TableFate {
  readonly used: boolean;
  readonly outcome: KeptOutcome | 'other_table_used' | null;
  /** The family's signature, when the table had a header. */
  readonly family: string | null;
}

/** spec 11A: one row of `report.families`. */
export interface FamilyReport {
  /** The first six header names. */
  label: string[];
  entries: number;
  used: boolean;
  rowMode: 'day' | 'check' | null;
  dayCount: number;
  /** `sales`, `other_table_used`, or why the family was kept. */
  why: string;
}

export type FamilyQuestion = QuestionDraft & { readonly sheet: 0; readonly family: string; readonly familyLabel: string };

export type FamiliesOutcome =
  | { kind: 'question'; question: FamilyQuestion }
  | { kind: 'done'; days: SalesDay[]; report: TableReport | null; families: FamilyReport[]; fates: TableFate[]; kept: KeptOutcome | null };

interface Member { readonly table: number; readonly headerRow: number }

interface Family {
  readonly signature: string;
  readonly header: readonly string[];
  readonly stats: TableStats;
  readonly members: Member[];
  outcome: KeptOutcome | null;
  decision: Extract<Decision, { kind: 'mapping' }> | null;
  read: { days: SalesDay[]; report: TableReport; rowMode: 'day' | 'check'; by: Decider } | null;
  contributed: number;
}

/** A header's family: SHA-256 over its normalized names. */
export function familySignature(header: readonly string[]): string {
  return createHash('sha256').update(header.map(normalizedHeader).join('\n'), 'utf8').digest('hex');
}

/** Where a family's answers live on the file (`answers['family:<signature>']`). */
export function familyKey(signature: string): string {
  return `family:${signature}`;
}

function labelOf(header: readonly string[]): string[] {
  return header.slice(0, 6);
}

function questionFor(family: Family, question: QuestionDraft): FamiliesOutcome {
  return { kind: 'question', question: { ...question, sheet: 0, family: family.signature, familyLabel: labelOf(family.header).join(', ') } };
}

const DECIDER_RANK: Readonly<Record<Decider, number>> = { rules: 0, ai: 1, you: 2 };

/** rules before AI before answers; day-level before check-level; more dates first; then signature order. */
function rank(a: Family, b: Family): number {
  const by = (family: Family): number => DECIDER_RANK[family.read?.by ?? 'rules'];
  const mode = (family: Family): number => (family.read?.rowMode === 'day' ? 0 : 1);
  return by(a) - by(b) || mode(a) - mode(b) || (b.read?.days.length ?? 0) - (a.read?.days.length ?? 0)
    || (a.signature < b.signature ? -1 : 1);
}

function hasSalesColumns(header: readonly string[], answers: FileAnswers[string] | undefined): boolean {
  if (answers?.guests !== undefined || answers?.netSales !== undefined) return true;
  return guessesFor('guests', header).length > 0 || guessesFor('netSales', header).length > 0;
}

/**
 * Reads every table of an archive as families. `answers` are the file's (a family's under familyKey); a question
 * names the family. Resolves the merged days, the primary family's report, each family's row and each table's fate.
 */
export async function readFamilies(
  tables: readonly TableSource[],
  input: { answers: FileAnswers; locationName: string; latest: string; choose?: ChooseColumns },
): Promise<FamiliesOutcome> {
  const families = new Map<string, Family>();
  const fates: TableFate[] = tables.map(() => ({ used: false, outcome: 'not_a_table', family: null }));
  const tableFamily: (Family | null)[] = tables.map(() => null);

  // First pass over every table: its header, its family, and the family's stats.
  for (const [index, table] of tables.entries()) {
    const joined: { family: Family | null } = { family: null };
    const first = new FirstPassReader((header) => {
      const signature = familySignature(header);
      let family = families.get(signature);
      if (family === undefined) {
        family = { signature, header, stats: new TableStats(header), members: [], outcome: null, decision: null, read: null, contributed: 0 };
        families.set(signature, family);
      }
      joined.family = family;
      return family.stats;
    }, { text: table.text === true });
    try {
      await table.visit((cells) => { first.add(cells); });
    } catch (err) {
      if (!(err instanceof TableKept)) throw err;
      fates[index] = { used: false, outcome: err.outcome, family: null };
      continue;
    }
    const found = first.finish();
    if ('kind' in found || joined.family === null) {
      fates[index] = { used: false, outcome: 'kind' in found ? found.outcome : 'no_header', family: null };
      continue;
    }
    joined.family.members.push({ table: index, headerRow: found.headerRow });
    tableFamily[index] = joined.family;
  }

  const ordered = [...families.values()].filter((family) => family.members.length > 0)
    .sort((a, b) => (a.signature < b.signature ? -1 : 1));

  // Decide, then read, one family. Resolves a question, or null with the family's outcome or days set.
  const settle = async (family: Family): Promise<FamiliesOutcome | null> => {
    const answers = input.answers[familyKey(family.signature)] ?? {};
    const firstMember = family.members[0];
    if (firstMember === undefined) return null;
    const decision = await decideMappingWithModel(family.stats.firstPass(firstMember.headerRow), answers, input.locationName, input.choose);
    if (decision.kind === 'question') return questionFor(family, decision.question);
    if (decision.kind === 'kept') {
      family.outcome = decision.outcome;
      return null;
    }
    family.decision = decision;
    if (answers.rowMode === 'item') {
      family.outcome = 'item_level';
      return null;
    }
    const rowMode = answers.rowMode === 'day' ? 'day' : 'check';
    const aggregator = new DayAggregator({ ...decision.mapping, rowMode }, input.latest, tables[firstMember.table]?.delimiter() ?? ',');
    for (const member of family.members) {
      let row = 0;
      try {
        await tables[member.table]?.visit((cells) => {
          row += 1;
          if (row <= member.headerRow || row > MAX_ROWS) return;
          aggregator.add(trimmed(cells), row);
        });
      } catch (err) {
        if (!(err instanceof TableKept)) throw err;
        fates[member.table] = { used: false, outcome: err.outcome, family: family.signature };
      }
    }
    const result = aggregator.finish();
    if (result.kind !== 'days') {
      family.outcome = result.kind;
      return null;
    }
    const mode = decideRowMode(aggregator.repeatedDays(), family.header, answers.rowMode);
    if (mode.kind === 'question') return questionFor(family, mode.question);
    if (mode.kind === 'kept') {
      family.outcome = mode.outcome;
      return null;
    }
    const pass = family.stats.firstPass(firstMember.headerRow);
    family.read = {
      days: result.days, report: tableReport(pass, decision, mode.rowMode, mode.by, result), rowMode: mode.rowMode,
      by: decision.decidedBy.guests ?? decision.decidedBy.netSales ?? 'rules',
    };
    return null;
  };

  // Families with a guests or net sales column first. The others are read only when none of those gave days, so a
  // POS export's payment and item reports never ask the person anything once its sales summary is found.
  const deferred: Family[] = [];
  for (const family of ordered) {
    if (!hasSalesColumns(family.header, input.answers[familyKey(family.signature)])) {
      deferred.push(family);
      continue;
    }
    const asked = await settle(family);
    if (asked !== null) return asked;
  }
  if (!ordered.some((family) => family.read !== null)) {
    for (const family of deferred) {
      const asked = await settle(family);
      if (asked !== null) return asked;
    }
  } else {
    for (const family of deferred) family.outcome = 'no_sales_columns';
  }

  const merged = new Map<string, SalesDay>();
  const used = ordered.filter((family) => family.read !== null).sort(rank);
  for (const family of used) {
    for (const day of family.read?.days ?? []) {
      if (merged.has(day.date)) continue;
      merged.set(day.date, day);
      family.contributed += 1;
    }
  }
  const days = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const tooMany = days.length > MAX_DAYS;

  for (const [index, family] of tableFamily.entries()) {
    if (family === null || fates[index]?.family === family.signature) continue;
    const usedFamily = family.contributed > 0 && !tooMany;
    fates[index] = {
      used: usedFamily,
      outcome: usedFamily ? null : family.read === null ? family.outcome ?? 'not_a_table' : 'other_table_used',
      family: family.signature,
    };
  }

  const reports: FamilyReport[] = ordered.slice(0, MAX_REPORTED_FAMILIES).map((family) => ({
    label: labelOf(family.header),
    entries: family.members.length,
    used: family.contributed > 0 && !tooMany,
    rowMode: family.read?.rowMode ?? null,
    dayCount: family.contributed,
    why: family.contributed > 0 ? 'sales' : family.read !== null ? 'other_table_used' : family.outcome ?? 'not_a_table',
  }));

  const primary = used[0]?.read ?? null;
  if (primary === null || tooMany) {
    // Nothing used: when every family was kept for the same reason, that reason is the archive's.
    const reasons = new Set(ordered.map((family) => family.outcome));
    const shared = reasons.size === 1 ? [...reasons][0] ?? null : null;
    return { kind: 'done', days: [], report: null, families: reports, fates, kept: tooMany ? 'too_many_days' : shared };
  }
  const rows = used.reduce((sum, family) => sum + (family.contributed > 0 ? family.read?.report.rows ?? 0 : 0), 0);
  return { kind: 'done', days, report: { ...primary.report, ...dayTotals(days), rows }, families: reports, fates, kept: null };
}
