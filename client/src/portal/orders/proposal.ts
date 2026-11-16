import { listText } from '../analytics/words';
import { formatCount, plural } from '../format';
import type { SetupRead, SetupReadItem } from './api';
import { mergeRows, type ImportProblem, type KeptField, type MergeEntry, type MergeResult, type MergeSupplier } from './merge';
import {
  normalizeName, parseDealSize, parsePerSale, parseServings, SETUP_LIMITS, WEEKDAY_NAMES, type DeliveryDraft, type SetupDraft,
} from './setupDraft';

// Reading the ordering setup with TownwiseAI (D41, P31): what TownwiseAI suggested, checked with the sheet import's own
// parsers and merged into the unsaved draft through the same merge (merge.ts). TownwiseAI never sets a par or never run
// out: a new item's par stays blank and its never run out off, and a replaced item keeps its own. A new item's blank
// category, unit, servings or supplier stays blank, so the checks name it at Save; a replaced item keeps its own value
// for each. Proposed deliveries fill only a supplier that has none. Marks: a servings value TownwiseAI estimated, and a
// name not written in what it read, each the helper of its field until the field changes. Pure.

/** A field TownwiseAI marked: the value it marked, and the helper that takes the field's place while it holds. */
export interface FieldMark {
  readonly value: string;
  readonly text: string;
}

export interface ItemMark {
  readonly servings?: FieldMark;
  readonly name?: FieldMark;
}

/** By item key. */
export type SetupMarks = Readonly<Record<string, ItemMark>>;

/** What was read: a file, or text the person pasted. */
export type ReadFrom = 'file' | 'text';

export interface ProposalImport extends MergeResult {
  /** The items TownwiseAI suggested, those left out included. */
  readonly found: number;
  /** Items whose servings per unit took TownwiseAI's estimate. */
  readonly estimated: number;
  /** Items whose name TownwiseAI didn't find written in what it read. */
  readonly notInFile: number;
  readonly marks: SetupMarks;
  readonly itemsCut: boolean;
  readonly partial: boolean;
}

function deliveryOf(delivery: SetupRead['suppliers'][number]['deliveries'][number]): DeliveryDraft {
  return {
    deliveryWeekday: String(delivery.deliveryWeekday),
    cutoffWeekday: delivery.cutoffWeekday === null ? '' : String(delivery.cutoffWeekday),
    cutoffTime: delivery.cutoffTime ?? '',
  };
}

/** One suggestion as the merge takes it, checked with the sheet import's parsers, or why it can't be used. */
function readSuggestion(item: SetupReadItem, ref: number): MergeEntry {
  const reasons: string[] = [];
  const name = item.name.trim();
  const supplier = item.supplier?.trim() ?? '';
  if (name.length < 1 || name.length > SETUP_LIMITS.itemName) reasons.push('Its name is empty or longer than 80 characters.');
  if (supplier.length > SETUP_LIMITS.supplierName) reasons.push('Its supplier’s name is longer than 60 characters.');
  const servings = item.servingsPerUnit === null ? '' : String(item.servingsPerUnit);
  if (servings !== '' && parseServings(servings) === null) reasons.push('Its servings per unit isn’t a number from 0.1 to 2,000.');
  const deal = item.dealSize === null ? '' : String(item.dealSize);
  if (parseDealSize(deal) === null) reasons.push('Its deal size isn’t a whole number from 1 to 999.');
  const posNames = item.posNames.map((pos) => ({ name: pos.name.trim(), perSale: String(pos.perSale) }));
  const posKeys = posNames.map((pos) => normalizeName(pos.name));
  if (posNames.length > SETUP_LIMITS.posNames) reasons.push('It has more than 10 point-of-sale names.');
  if (posNames.some((pos) => pos.name.length < 1 || pos.name.length > SETUP_LIMITS.posName)) {
    reasons.push('A point-of-sale name is empty or longer than 80 characters.');
  }
  if (new Set(posKeys).size !== posKeys.length) reasons.push('A point-of-sale name is listed twice.');
  if (posNames.some((pos) => parsePerSale(pos.perSale) === null)) reasons.push('A point-of-sale name’s servings per sale isn’t above 0, up to 50.');
  if (reasons.length > 0) return { ref, item: name, reasons };
  const blank = new Set<KeptField>();
  if (supplier === '') blank.add('supplier');
  if (item.category === null) blank.add('category');
  if (item.unit === null) blank.add('unit');
  if (servings === '') blank.add('servings per unit');
  if (posNames.length === 0) blank.add('point-of-sale names');
  if (deal === '') blank.add('deal size');
  return {
    ref,
    item: name,
    row: {
      name,
      supplier,
      fields: { category: item.category ?? '', unit: item.unit ?? '', servingsPerUnit: servings, par: '', dealSize: deal, neverRunOut: false, posNames },
      blank,
      keepsPar: true,
    },
  };
}

function estimateText(note: string): string {
  const clean = note.trim().replace(/[\s.]+$/, '');
  return clean === '' ? 'TownwiseAI estimated this. Check it.' : `TownwiseAI estimated this: ${clean}. Check it.`;
}

function notFoundText(from: ReadFrom): string {
  return `TownwiseAI didn’t find this name in the ${from}. Check it.`;
}

/**
 * Merges what TownwiseAI read into `draft`: its suppliers first (each fills a supplier of its name that has no
 * deliveries, or is added with its own), then its items by name, numbered from 1 in the order TownwiseAI gave them.
 */
export function importProposal(read: SetupRead, draft: SetupDraft, from: ReadFrom = 'file'): ProposalImport {
  const suppliers: MergeSupplier[] = read.suppliers.map((supplier) => ({ name: supplier.name.trim(), deliveries: supplier.deliveries.map(deliveryOf) }));
  const merged = mergeRows(draft, read.items.map((item, index) => readSuggestion(item, index + 1)), {
    suppliers,
    duplicate: (earlier) => `It’s the same item as item ${String(earlier)}.`,
  });
  const marks: Record<string, ItemMark> = {};
  let estimated = 0;
  let notInFile = 0;
  read.items.forEach((item, index) => {
    const key = merged.keys.get(index + 1);
    const placed = key === undefined ? undefined : merged.draft.items.find((each) => each.key === key);
    if (key === undefined || placed === undefined) return;
    const mark: { servings?: FieldMark; name?: FieldMark } = {};
    if (item.servingsEstimated && item.servingsPerUnit !== null && placed.servingsPerUnit === String(item.servingsPerUnit)) {
      mark.servings = { value: placed.servingsPerUnit, text: estimateText(item.note) };
      estimated += 1;
    }
    if (item.inFile === false) {
      mark.name = { value: placed.name, text: notFoundText(from) };
      notInFile += 1;
    }
    if (mark.servings !== undefined || mark.name !== undefined) marks[key] = mark;
  });
  return { ...merged, found: read.items.length, estimated, notInFile, marks, itemsCut: read.itemsCut, partial: read.partial };
}

/** The marks that still hold: each only while its item is in the draft and its field still has the marked value. */
export function pruneMarks(marks: SetupMarks, draft: SetupDraft): SetupMarks {
  const next: Record<string, ItemMark> = {};
  let changed = false;
  for (const [key, mark] of Object.entries(marks)) {
    const item = draft.items.find((each) => each.key === key);
    const servings = item !== undefined && mark.servings?.value === item.servingsPerUnit ? mark.servings : undefined;
    const name = item !== undefined && mark.name?.value === item.name ? mark.name : undefined;
    if (servings === mark.servings && name === mark.name) {
      next[key] = mark;
      continue;
    }
    changed = true;
    if (servings !== undefined || name !== undefined) next[key] = { ...(servings === undefined ? {} : { servings }), ...(name === undefined ? {} : { name }) };
  }
  return changed ? next : marks;
}

/** `current` with a new read's marks added, field by field. */
export function withMarks(current: SetupMarks, incoming: SetupMarks): SetupMarks {
  const next: Record<string, ItemMark> = { ...current };
  for (const [key, mark] of Object.entries(incoming)) next[key] = { ...current[key], ...mark };
  return next;
}

function daysOf(deliveries: readonly DeliveryDraft[]): string {
  return listText(deliveries.map((delivery) => WEEKDAY_NAMES[Number(delivery.deliveryWeekday)] ?? '').filter((day) => day !== ''));
}

/** What a read did, in lines for the page's status, ending with the lead-in to the problems when there are any. */
export function proposalSummary(result: ProposalImport, from: ReadFrom = 'file'): string[] {
  const lines: string[] = [];
  if (result.found > 0) {
    lines.push(
      `TownwiseAI found ${plural(result.found, 'item', 'items')}: ${String(result.added)} new, ${String(result.replaced)} replaced by name. `
        + 'Nothing is saved yet: check them below, then save the setup.',
    );
  } else if (result.newSuppliers.length + result.deliveriesFilled.length > 0) {
    lines.push('TownwiseAI found no items. Nothing is saved yet: check the suppliers below, then save the setup.');
  } else {
    lines.push(`TownwiseAI found nothing to add from the ${from}.`);
  }
  if (result.added > 0) lines.push(result.added === 1 ? 'Set the par of the new item.' : `Set the par of the ${formatCount(result.added)} new items.`);
  if (result.replaced > 0) {
    lines.push(result.replaced === 1
      ? 'The replaced item keeps its par and never run out, and its own values where TownwiseAI left a field blank.'
      : 'Replaced items keep their par and never run out, and their own values where TownwiseAI left a field blank.');
  }
  if (result.estimated > 0) {
    lines.push(`Check the servings per unit of ${plural(result.estimated, 'item', 'items')}: TownwiseAI estimated ${result.estimated === 1 ? 'it' : 'them'}.`);
  }
  if (result.notInFile > 0) {
    lines.push(`TownwiseAI didn’t find ${formatCount(result.notInFile)} of these names in the ${from}: check ${result.notInFile === 1 ? 'it' : 'them'}.`);
  }
  const created = result.newSuppliers.flatMap((name) => result.draft.suppliers.filter((supplier) => supplier.name === name).slice(0, 1));
  const withDays = created.filter((supplier) => supplier.deliveries.length > 0);
  const withoutDays = created.filter((supplier) => supplier.deliveries.length === 0);
  if (withDays.length > 0) {
    lines.push(
      `Added ${plural(withDays.length, 'supplier', 'suppliers')} with the delivery days TownwiseAI found: `
        + `${withDays.map((supplier) => `${supplier.name} (${daysOf(supplier.deliveries)})`).join(', ')}. Check each delivery’s order-by day and time.`,
    );
  }
  if (withoutDays.length > 0) lines.push(`Add the delivery days of the new suppliers: ${withoutDays.map((supplier) => supplier.name).join(', ')}.`);
  if (result.deliveriesFilled.length > 0) {
    lines.push(`Filled in the delivery days TownwiseAI found for ${listText(result.deliveriesFilled)}, which had none. Check each delivery’s order-by day and time.`);
  }
  if (result.suppliersLeftOut.length > 0) lines.push(`Left out ${listText(result.suppliersLeftOut)}: the setup holds up to 20 suppliers.`);
  if (result.itemsCut) lines.push(`The ${from} lists more items than TownwiseAI reads at once (150), so some were left out. Read the rest separately.`);
  if (result.partial) lines.push(`The ${from} was too long to read whole, so TownwiseAI read only the start of it.`);
  if (result.problems.length > 0) lines.push(`Left out ${plural(result.problems.length, 'item', 'items')} that failed a check:`);
  return lines;
}

/** One suggestion left out: “Item 3, {name}: {reason}”. */
export function problemLine(problem: ImportProblem): string {
  return `Item ${String(problem.row)}${problem.item === '' ? '' : `, ${problem.item}`}: ${problem.reason}`;
}
