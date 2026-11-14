import { isBlankRecord } from '../upload/csv';
import type { OrderCategory, OrderUnit } from './api';
import {
  newKey, normalizeName, parseDealSize, parsePar, parsePerSale, parseServings, SETUP_LIMITS, type ItemDraft, type PosNameDraft,
  type SetupDraft, type SupplierDraft,
} from './setupDraft';

// The ordering template and the sheet import (the order-setup spec, "Items can be imported from a sheet"). The
// template is a CSV with one row per item; an imported sheet (CSV or Excel, read in the browser by the page) is
// merged into the draft by item name, replacing an item of the same name and adding the rest, and creates the
// suppliers it names. A row that fails a check is listed with why and left out. Nothing saves until Save. Pure.

export const TEMPLATE_COLUMNS = [
  'Item', 'Supplier', 'Category', 'Unit', 'Servings per unit', 'Par', 'Deal size', 'Never run out', 'Point-of-sale names',
] as const;

export const TEMPLATE_FILE_NAME = 'townwise-ordering-template.csv';

/** Two rows that read as examples, skipped when a sheet still holds them. */
const EXAMPLES: readonly (readonly string[])[] = [
  ['Example lager cans (delete this row)', 'Example distributor', 'Bottles and cans', 'cases', '24', '3', '5', 'no', 'Example Lager Can;Example Lager Bucket x5'],
  ['Example IPA keg (delete this row)', 'Example brewery', 'Draft', 'kegs', '124', '1', '', 'yes', 'Example IPA Pint;Example IPA Pitcher x4'],
];

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The template: its header and the two example rows, CRLF between records (RFC 4180). */
export function templateCsv(): string {
  return [TEMPLATE_COLUMNS, ...EXAMPLES].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** A header as the import matches it: trimmed, case-folded, with spaces, hyphens and underscores as one space. */
export function headerKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

const REQUIRED = ['Item', 'Supplier', 'Category', 'Unit', 'Servings per unit', 'Par'] as const;
type Column = (typeof TEMPLATE_COLUMNS)[number];

const CATEGORY_WORDS: Readonly<Record<string, OrderCategory>> = {
  'bottles and cans': 'bottles_cans', 'bottles & cans': 'bottles_cans', 'bottles cans': 'bottles_cans',
  draft: 'draft', draught: 'draft',
  liquor: 'liquor', spirits: 'liquor',
  'cocktail ingredient': 'cocktail_ingredient', 'cocktail ingredients': 'cocktail_ingredient',
};

const UNIT_WORDS: Readonly<Record<string, OrderUnit>> = {
  cases: 'cases', case: 'cases', kegs: 'kegs', keg: 'kegs', bottles: 'bottles', bottle: 'bottles', units: 'units', unit: 'units',
};

const YES = new Set(['yes', 'y', 'true', '1', 'x']);
const NO = new Set(['', 'no', 'n', 'false', '0']);

/** "Lager Pitcher x4": the name, then servings per sale as a number after an x ("Vodka Soda X Large" is all name). */
const PER_SALE_SUFFIX = /^(.*\S)\s+[xX×]\s*(\d+(?:\.\d+)?|\.\d+)$/;

/**
 * The point-of-sale names of one cell: separated by semicolons, each with an optional servings-per-sale suffix
 * ("Lager Pint;Lager Pitcher x4"), or why the cell can't be read.
 */
export function parsePosNames(cell: string): { names: PosNameDraft[] } | { problem: string } {
  const names: PosNameDraft[] = [];
  const seen = new Set<string>();
  for (const piece of cell.split(';')) {
    const text = piece.trim();
    if (text === '') continue;
    const suffix = PER_SALE_SUFFIX.exec(text);
    const name = (suffix?.[1] ?? text).trim();
    const perSaleText = suffix?.[2] ?? '1';
    if (name.length > SETUP_LIMITS.posName) return { problem: 'Point-of-sale names: each name is up to 80 characters.' };
    if (parsePerSale(perSaleText) === null) return { problem: 'Point-of-sale names: servings per sale (after the x) is a number above 0, up to 50.' };
    const key = normalizeName(name);
    if (seen.has(key)) return { problem: 'Point-of-sale names: a name is listed twice.' };
    seen.add(key);
    names.push({ name, perSale: perSaleText });
  }
  if (names.length > SETUP_LIMITS.posNames) return { problem: 'Point-of-sale names: an item has up to 10.' };
  return { names };
}

export interface ImportProblem {
  /** The sheet's row number, the header being row 1. */
  readonly row: number;
  /** The row's item name, as the sheet has it (the owner's own words, shown only on the page). */
  readonly item: string;
  readonly reason: string;
}

export interface SheetImport {
  readonly draft: SetupDraft;
  readonly added: number;
  readonly replaced: number;
  /** Suppliers the sheet named that the draft did not have; each still needs its deliveries. */
  readonly newSuppliers: readonly string[];
  readonly examplesSkipped: number;
  readonly problems: readonly ImportProblem[];
}

export type ImportOutcome = { ok: true; result: SheetImport } | { ok: false; missing: readonly string[] } | { ok: false; empty: true };

interface ParsedRow {
  name: string;
  supplier: string;
  fields: Omit<ItemDraft, 'key' | 'id' | 'name' | 'supplierKey'>;
}

function readRow(cell: (column: Column) => string): { row: ParsedRow } | { reasons: string[] } {
  const reasons: string[] = [];
  const name = cell('Item').trim();
  const supplier = cell('Supplier').trim();
  if (name.length < 1 || name.length > SETUP_LIMITS.itemName) reasons.push('Item: enter a name of up to 80 characters.');
  if (supplier.length < 1 || supplier.length > SETUP_LIMITS.supplierName) reasons.push('Supplier: enter a name of up to 60 characters.');
  const category = CATEGORY_WORDS[headerKey(cell('Category'))];
  if (category === undefined) reasons.push('Category: use Bottles and cans, Draft, Liquor or Cocktail ingredient.');
  const unit = UNIT_WORDS[headerKey(cell('Unit'))];
  if (unit === undefined) reasons.push('Unit: use cases, kegs, bottles or units.');
  const servings = cell('Servings per unit').trim();
  if (parseServings(servings) === null) reasons.push('Servings per unit: enter a number above 0, up to 2,000.');
  const par = cell('Par').trim();
  if (parsePar(par) === null) reasons.push('Par: enter a whole number from 0 to 999.');
  const deal = cell('Deal size').trim();
  if (parseDealSize(deal) === null) reasons.push('Deal size: leave it empty, or enter a whole number from 1 to 999.');
  const never = cell('Never run out').trim().toLowerCase();
  if (!YES.has(never) && !NO.has(never)) reasons.push('Never run out: use yes or no.');
  const pos = parsePosNames(cell('Point-of-sale names'));
  if ('problem' in pos) reasons.push(pos.problem);
  if (reasons.length > 0 || category === undefined || unit === undefined || 'problem' in pos) return { reasons };
  return {
    row: {
      name, supplier,
      fields: { category, unit, servingsPerUnit: servings, par, dealSize: deal, neverRunOut: YES.has(never), posNames: pos.names },
    },
  };
}

/**
 * Merges a sheet's rows into `draft`. `header` is the sheet's first row; `rows` are the rows after it with their row
 * numbers. Header names match without regard to case; Item, Supplier, Category, Unit, Servings per unit and Par are
 * required, the rest optional. An item whose name matches one in the draft (trimmed, case-folded) replaces its
 * fields and keeps its id, so its sales and counts stay with it.
 */
export function importSheet(header: readonly string[], rows: readonly { row: number; cells: readonly string[] }[], draft: SetupDraft): ImportOutcome {
  const keys = header.map(headerKey);
  const index = new Map<Column, number>();
  for (const column of TEMPLATE_COLUMNS) {
    const at = keys.indexOf(headerKey(column));
    if (at !== -1) index.set(column, at);
  }
  const missing = REQUIRED.filter((column) => !index.has(column));
  if (missing.length > 0) return { ok: false, missing };
  const filled = rows.filter((row) => !isBlankRecord(row.cells));
  if (filled.length === 0) return { ok: false, empty: true };

  const suppliers = [...draft.suppliers];
  const items = [...draft.items];
  const supplierKeyOf = new Map<string, string>();
  for (const supplier of suppliers) if (!supplierKeyOf.has(normalizeName(supplier.name))) supplierKeyOf.set(normalizeName(supplier.name), supplier.key);
  const itemAt = new Map<string, number>();
  items.forEach((item, at) => { if (!itemAt.has(normalizeName(item.name))) itemAt.set(normalizeName(item.name), at); });
  const firstRow = new Map<string, number>();
  const problems: ImportProblem[] = [];
  const newSuppliers: string[] = [];
  let added = 0;
  let replaced = 0;
  let examplesSkipped = 0;

  for (const { row, cells } of filled) {
    const cell = (column: Column): string => {
      const at = index.get(column);
      return at === undefined ? '' : (cells[at] ?? '');
    };
    const itemName = cell('Item').trim();
    if (EXAMPLES.some((example) => example[0] === itemName && example[1] === cell('Supplier').trim())) {
      examplesSkipped += 1;
      continue;
    }
    const read = readRow(cell);
    if ('reasons' in read) {
      problems.push({ row, item: itemName, reason: read.reasons.join(' ') });
      continue;
    }
    const { name, supplier, fields } = read.row;
    const itemKey = normalizeName(name);
    const earlier = firstRow.get(itemKey);
    if (earlier !== undefined) {
      problems.push({ row, item: name, reason: `This item is already on row ${String(earlier)}.` });
      continue;
    }
    const existing = itemAt.get(itemKey);
    if (existing === undefined && items.length >= SETUP_LIMITS.items) {
      problems.push({ row, item: name, reason: 'The setup holds up to 300 items.' });
      continue;
    }
    let supplierKey = supplierKeyOf.get(normalizeName(supplier));
    if (supplierKey === undefined) {
      if (suppliers.length >= SETUP_LIMITS.suppliers) {
        problems.push({ row, item: name, reason: 'The setup holds up to 20 suppliers.' });
        continue;
      }
      const created: SupplierDraft = { key: newKey('supplier'), id: null, name: supplier, deliveries: [] };
      suppliers.push(created);
      supplierKeyOf.set(normalizeName(supplier), created.key);
      newSuppliers.push(supplier);
      supplierKey = created.key;
    }
    firstRow.set(itemKey, row);
    const previous = existing === undefined ? undefined : items[existing];
    if (existing !== undefined && previous !== undefined) {
      items[existing] = { ...fields, key: previous.key, id: previous.id, name, supplierKey };
      replaced += 1;
    } else {
      itemAt.set(itemKey, items.length);
      items.push({ ...fields, key: newKey('item'), id: null, name, supplierKey });
      added += 1;
    }
  }
  return { ok: true, result: { draft: { suppliers, items }, added, replaced, newSuppliers, examplesSkipped, problems } };
}
