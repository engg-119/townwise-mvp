import { newKey, normalizeName, SETUP_LIMITS, type DeliveryDraft, type ItemDraft, type SetupDraft, type SupplierDraft } from './setupDraft';

// The one merge of items into the Ordering setup's draft, shared by the sheet import (template.ts) and reading with
// TownwiseAI (proposal.ts, D41). By item name (trimmed, case-folded): an item of the same name is replaced and keeps its
// id, so its sales and counts stay with it, and the rest are added. A supplier an item names that the draft lacks is
// created. A replaced item keeps its own value wherever the incoming row leaves a field blank, and when the row says so
// (TownwiseAI's) it always keeps its par and never run out. An entry that failed its check, a second entry of one name,
// and an entry past the setup's 300 items or 20 suppliers are listed with why and left out. Nothing saves until Save.
// Pure.

/** A field a replaced item kept because the incoming row left it blank. */
export type KeptField = 'supplier' | 'category' | 'unit' | 'servings per unit' | 'point-of-sale names' | 'deal size' | 'never run out';

export type ItemFields = Omit<ItemDraft, 'key' | 'id' | 'name' | 'supplierKey'>;

export interface MergeRow {
  readonly name: string;
  /** The supplier it names, or '' for none: a new item then has no supplier, which the checks name at Save. */
  readonly supplier: string;
  readonly fields: ItemFields;
  /** The fields it leaves blank: a replaced item keeps its own value for each. */
  readonly blank: ReadonlySet<KeptField>;
  /** A replaced item keeps its par and never run out whatever the row holds (TownwiseAI never sets either). */
  readonly keepsPar: boolean;
}

/** A sheet row or a suggestion by its number: read, or why it can't be. */
export type MergeEntry =
  | { readonly ref: number; readonly item: string; readonly row: MergeRow }
  | { readonly ref: number; readonly item: string; readonly reasons: readonly string[] };

export interface ImportProblem {
  /** The sheet's row number (the header being row 1), or the suggestion's number. */
  readonly row: number;
  /** The item's name as the sheet or TownwiseAI has it (the owner's own words, shown only on the page). */
  readonly item: string;
  readonly reason: string;
}

/** A supplier that comes with its deliveries (TownwiseAI's), merged before the items. */
export interface MergeSupplier {
  readonly name: string;
  readonly deliveries: readonly DeliveryDraft[];
}

export interface MergeResult {
  readonly draft: SetupDraft;
  readonly added: number;
  readonly replaced: number;
  /** Replaced items that kept a value the row left blank, by the row's item name, in order. */
  readonly kept: readonly { readonly item: string; readonly fields: readonly KeptField[] }[];
  /** Suppliers the draft did not have; each still needs its deliveries unless it came with them. */
  readonly newSuppliers: readonly string[];
  /** Suppliers of the draft with no deliveries that took the incoming ones. */
  readonly deliveriesFilled: readonly string[];
  /** Incoming suppliers left out at the setup's 20. */
  readonly suppliersLeftOut: readonly string[];
  readonly problems: readonly ImportProblem[];
  /** Where each merged entry landed: its number to its item's key. */
  readonly keys: ReadonlyMap<number, string>;
}

/** A supplier has deliveries once one of them has anything filled in; a blank delivery row is none. */
function hasDeliveries(supplier: SupplierDraft): boolean {
  return supplier.deliveries.some((delivery) => delivery.deliveryWeekday !== '' || delivery.cutoffWeekday !== '' || delivery.cutoffTime.trim() !== '');
}

/** A replaced item's fields: the row's, but its own value for each field the row left blank, and its par if it keeps it. */
function replacing(row: MergeRow, previous: ItemDraft, supplierKey: string): { fields: ItemFields; supplierKey: string; kept: KeptField[] } {
  const fields = { ...row.fields };
  const kept: KeptField[] = [];
  let key = supplierKey;
  if (row.blank.has('supplier') && previous.supplierKey !== '') {
    key = previous.supplierKey;
    kept.push('supplier');
  }
  if (row.blank.has('category') && previous.category !== '') {
    fields.category = previous.category;
    kept.push('category');
  }
  if (row.blank.has('unit') && previous.unit !== '') {
    fields.unit = previous.unit;
    kept.push('unit');
  }
  if (row.blank.has('servings per unit') && previous.servingsPerUnit.trim() !== '') {
    fields.servingsPerUnit = previous.servingsPerUnit;
    kept.push('servings per unit');
  }
  if (row.blank.has('point-of-sale names') && previous.posNames.length > 0) {
    fields.posNames = previous.posNames;
    kept.push('point-of-sale names');
  }
  if (row.blank.has('deal size') && previous.dealSize.trim() !== '') {
    fields.dealSize = previous.dealSize;
    kept.push('deal size');
  }
  if (row.keepsPar) {
    fields.par = previous.par;
    fields.neverRunOut = previous.neverRunOut;
  } else if (row.blank.has('never run out') && previous.neverRunOut) {
    fields.neverRunOut = true;
    kept.push('never run out');
  }
  return { fields, supplierKey: key, kept };
}

/**
 * Merges `entries` into `draft`, in order, after `suppliers` (each fills the deliveries of a draft supplier of its name
 * that has none, or is added with them). `duplicate` words a second entry of one name, given the first one's number.
 */
export function mergeRows(
  draft: SetupDraft,
  entries: readonly MergeEntry[],
  options: { suppliers?: readonly MergeSupplier[]; duplicate: (earlier: number) => string },
): MergeResult {
  const suppliers = [...draft.suppliers];
  const items = [...draft.items];
  const supplierAt = new Map<string, number>();
  suppliers.forEach((supplier, at) => { if (!supplierAt.has(normalizeName(supplier.name))) supplierAt.set(normalizeName(supplier.name), at); });
  const itemAt = new Map<string, number>();
  items.forEach((item, at) => { if (!itemAt.has(normalizeName(item.name))) itemAt.set(normalizeName(item.name), at); });
  const firstRef = new Map<string, number>();
  const problems: ImportProblem[] = [];
  const newSuppliers: string[] = [];
  const deliveriesFilled: string[] = [];
  const suppliersLeftOut: string[] = [];
  const kept: { item: string; fields: KeptField[] }[] = [];
  const keys = new Map<number, string>();
  let added = 0;
  let replaced = 0;

  /** The key of the supplier of this name, added with `deliveries` when the draft lacks it; null at the setup's 20. */
  function supplierKeyOf(name: string, deliveries: readonly DeliveryDraft[]): string | null {
    const at = supplierAt.get(normalizeName(name));
    if (at !== undefined) return suppliers[at]?.key ?? null;
    if (suppliers.length >= SETUP_LIMITS.suppliers) return null;
    const created: SupplierDraft = { key: newKey('supplier'), id: null, name, deliveries };
    supplierAt.set(normalizeName(name), suppliers.length);
    suppliers.push(created);
    newSuppliers.push(name);
    return created.key;
  }

  for (const proposed of options.suppliers ?? []) {
    const at = supplierAt.get(normalizeName(proposed.name));
    const existing = at === undefined ? undefined : suppliers[at];
    if (at === undefined || existing === undefined) {
      if (supplierKeyOf(proposed.name, proposed.deliveries) === null) suppliersLeftOut.push(proposed.name);
    } else if (!hasDeliveries(existing) && proposed.deliveries.length > 0) {
      suppliers[at] = { ...existing, deliveries: proposed.deliveries };
      deliveriesFilled.push(existing.name);
    }
  }

  for (const entry of entries) {
    if ('reasons' in entry) {
      problems.push({ row: entry.ref, item: entry.item, reason: entry.reasons.join(' ') });
      continue;
    }
    const { row } = entry;
    const itemKey = normalizeName(row.name);
    const earlier = firstRef.get(itemKey);
    if (earlier !== undefined) {
      problems.push({ row: entry.ref, item: row.name, reason: options.duplicate(earlier) });
      continue;
    }
    const existing = itemAt.get(itemKey);
    if (existing === undefined && items.length >= SETUP_LIMITS.items) {
      problems.push({ row: entry.ref, item: row.name, reason: 'The setup holds up to 300 items.' });
      continue;
    }
    let supplierKey = '';
    if (row.supplier !== '') {
      const found = supplierKeyOf(row.supplier, []);
      if (found === null) {
        problems.push({ row: entry.ref, item: row.name, reason: 'The setup holds up to 20 suppliers.' });
        continue;
      }
      supplierKey = found;
    }
    firstRef.set(itemKey, entry.ref);
    const previous = existing === undefined ? undefined : items[existing];
    if (existing !== undefined && previous !== undefined) {
      const merged = replacing(row, previous, supplierKey);
      items[existing] = { ...merged.fields, key: previous.key, id: previous.id, name: row.name, supplierKey: merged.supplierKey };
      keys.set(entry.ref, previous.key);
      if (merged.kept.length > 0) kept.push({ item: row.name, fields: merged.kept });
      replaced += 1;
    } else {
      const key = newKey('item');
      itemAt.set(itemKey, items.length);
      items.push({ ...row.fields, key, id: null, name: row.name, supplierKey });
      keys.set(entry.ref, key);
      added += 1;
    }
  }
  return { draft: { suppliers, items }, added, replaced, kept, newSuppliers, deliveriesFilled, suppliersLeftOut, problems, keys };
}
