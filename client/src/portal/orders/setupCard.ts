import { listText } from '../analytics/words';
import { formatCount, plural } from '../format';
import type { OrderSetup, SetupRead } from './api';
import type { ImportProblem } from './merge';
import { importProposal, type CutWording, type ProposalImport } from './proposal';
import { locationHref } from '../routing';
import { CATEGORY_LABEL, draftOf, normalizeName, UNIT_LABEL, WEEKDAY_NAMES, type DeliveryDraft, type ItemDraft, type SetupDraft } from './setupDraft';

// The ordering setup card of a TownwiseAI chat (spec D56): what the card's suggestions would do to the live setup,
// worked out before anything is merged or saved. It runs the same merge Ordering setup runs (proposal.ts, merge.ts), so
// the card and the page it opens cannot disagree, and adds what that page does not show: each item already in the setup
// that would change, field by field, a name's spelling included. That list is the guard against a suggestion that
// quietly rewrites an item's supplier, unit or servings. Nothing here saves, and a new item's par is always blank. Pure.

/** The most items a chat's card carries (api/src/chat/tools/order-setup.ts ORDER_SETUP_ITEMS_MAX). */
export const CHAT_SETUP_ITEMS_MAX = 60;

/** How a card's suggestions say the file held more items, on the card and in Ordering setup's summary of them. */
export const CHAT_CUT: CutWording = {
  cap: CHAT_SETUP_ITEMS_MAX,
  limit: 'suggests in a chat',
  rest: 'For the rest, use Read a file with TownwiseAI on Ordering setup, on the web.',
};

/** `?proposal=` on Ordering setup: a conversation's id, a dot, and the tool call's id. Ids only, checked before any request. */
const PROPOSAL_PARAM = /^([0-9a-f]{24})\.([A-Za-z0-9_-]{1,128})$/;

/** Ordering setup opened with a card's suggestions (SetupProposal.tsx merges them into the unsaved draft). */
export function setupProposalHref(locationId: string, conversationId: string, proposalId: string): string {
  return `${locationHref(locationId, 'ordersSetup')}?proposal=${encodeURIComponent(`${conversationId}.${proposalId}`)}`;
}

/** The card a `?proposal=` value names, or null when it is not two ids. */
export function proposalParam(value: string | string[] | undefined): { conversationId: string; proposalId: string } | null {
  const match = typeof value === 'string' ? PROPOSAL_PARAM.exec(value) : null;
  return match === null ? null : { conversationId: match[1] ?? '', proposalId: match[2] ?? '' };
}

/** Said on the card and on Ordering setup when the reply that made the suggestions also read web pages. */
export const READ_WEB_LINE = 'This reply also read web pages, which Townwise didn’t check. Look over each change before you save.';

export interface FieldChange {
  readonly field: 'name' | 'supplier' | 'category' | 'unit' | 'servings per unit' | 'deal size';
  /** The setup's value now, in the page's words; "none" for an empty one. */
  readonly from: string;
  readonly to: string;
}

export interface ItemChange {
  /** The item's name as the setup has it now. */
  readonly item: string;
  readonly fields: readonly FieldChange[];
}

export interface SetupCardPreview {
  /** The merge itself: its draft is what Ordering setup would hold, unsaved. */
  readonly result: ProposalImport;
  /** The items suggested, those left out included. */
  readonly found: number;
  readonly added: number;
  /** Suggested items the setup already has, by name. */
  readonly matched: number;
  /** Each item already in the setup that would change. */
  readonly changes: readonly ItemChange[];
  /** The line above `changes`, or null with none. */
  readonly changesLead: string | null;
  /** Suggestions left out, each with why (proposal.ts problemLine words one). */
  readonly problems: readonly ImportProblem[];
  /** The line above `problems`, or null with none. */
  readonly problemsLead: string | null;
  /** No name could be looked for in the file's text (a picture). */
  readonly namesUnchecked: boolean;
  /** Nothing would be added, changed or left out: the suggestions are in the setup already. */
  readonly inSetup: boolean;
  /** What the card says, in order. */
  readonly lines: readonly string[];
}

function shown(value: string): string {
  return value.trim() === '' ? 'none' : value;
}

function daysOf(deliveries: readonly DeliveryDraft[]): string {
  return listText(deliveries.map((delivery) => WEEKDAY_NAMES[Number(delivery.deliveryWeekday)] ?? '').filter((day) => day !== ''));
}

function supplierName(draft: SetupDraft, key: string): string {
  return draft.suppliers.find((supplier) => supplier.key === key)?.name ?? '';
}

function fieldsChanged(before: ItemDraft, after: ItemDraft, was: SetupDraft, now: SetupDraft): FieldChange[] {
  const pairs: [FieldChange['field'], string, string][] = [
    ['name', before.name, after.name],
    ['supplier', supplierName(was, before.supplierKey), supplierName(now, after.supplierKey)],
    ['category', before.category === '' ? '' : CATEGORY_LABEL[before.category], after.category === '' ? '' : CATEGORY_LABEL[after.category]],
    ['unit', before.unit === '' ? '' : UNIT_LABEL[before.unit], after.unit === '' ? '' : UNIT_LABEL[after.unit]],
    ['servings per unit', before.servingsPerUnit, after.servingsPerUnit],
    ['deal size', before.dealSize, after.dealSize],
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ field, from: shown(from), to: shown(to) }));
}

/** One changed item as a line: "Sample Lager: unit cases to kegs; servings per unit 24 to 124". */
export function changeLine(change: ItemChange): string {
  return `${change.item}: ${change.fields.map((each) => `${each.field} ${each.from} to ${each.to}`).join('; ')}`;
}

/** What `read`, a card's suggestions, would do to `setup` as it is saved now (null when the location has none). */
export function setupCardPreview(read: SetupRead, setup: OrderSetup | null): SetupCardPreview {
  const before = draftOf(setup);
  const result = importProposal(read, before);
  const changes: ItemChange[] = before.items.flatMap((item) => {
    const after = result.draft.items.find((each) => each.key === item.key);
    const fields = after === undefined ? [] : fieldsChanged(item, after, before, result.draft);
    return fields.length === 0 ? [] : [{ item: item.name, fields }];
  });
  const namesUnchecked = read.items.length > 0 && read.items.every((item) => item.inFile === null);
  const base = {
    result, found: result.found, added: result.added, matched: result.replaced, changes, problems: result.problems, namesUnchecked,
    changesLead: changes.length === 0 ? null : `${plural(changes.length, 'item', 'items')} already in your setup would change:`,
    problemsLead: result.problems.length === 0 ? null : `Left out ${plural(result.problems.length, 'item', 'items')}:`,
  };
  if (read.items.length === 0 && read.suppliers.length === 0) return { ...base, inSetup: false, lines: ['TownwiseAI found nothing to suggest.'] };
  const toDo = result.added + changes.length + result.newSuppliers.length + result.deliveriesFilled.length;
  if (toDo === 0 && result.problems.length === 0 && result.suppliersLeftOut.length === 0) {
    return { ...base, inSetup: true, lines: ['These suggestions are in your ordering setup.'] };
  }

  const lines: string[] = [result.found > 0
    ? `TownwiseAI suggests ${plural(result.found, 'item', 'items')}: ${formatCount(result.added)} new and ${formatCount(result.replaced)} already in your setup by name.`
    : 'TownwiseAI suggests no items, only suppliers.'];
  if (changes.length > 0) {
    lines.push(changes.length === 1
      ? 'An item already in your setup keeps its par, its never run out and its register names.'
      : 'Items already in your setup keep their par, their never run out and their register names.');
  }
  const created = result.newSuppliers.flatMap((name) => result.draft.suppliers.filter((supplier) => supplier.name === name).slice(0, 1));
  if (created.length > 0) {
    const named = created.map((supplier) => `${supplier.name} (${supplier.deliveries.length > 0 ? daysOf(supplier.deliveries) : 'no delivery days found'})`);
    lines.push(`${created.length === 1 ? 'New supplier' : 'New suppliers'}: ${listText(named)}.`);
  }
  for (const name of result.deliveriesFilled) {
    const filled = result.draft.suppliers.find((supplier) => supplier.name === name);
    lines.push(`${name} has no delivery days in your setup, so it would take the ones TownwiseAI found (${daysOf(filled?.deliveries ?? [])}).`);
  }
  const filledKeys = new Set(result.deliveriesFilled.map(normalizeName));
  const suggestedDays = new Set(read.suppliers.filter((supplier) => supplier.deliveries.length > 0).map((supplier) => normalizeName(supplier.name)));
  const keepDays = before.suppliers.filter((supplier) => suggestedDays.has(normalizeName(supplier.name)) && !filledKeys.has(normalizeName(supplier.name)));
  if (keepDays.length > 0) lines.push(`${listText(keepDays.map((supplier) => supplier.name))} ${keepDays.length === 1 ? 'keeps' : 'keep'} the delivery days in your setup.`);
  if (result.estimated > 0) lines.push(`TownwiseAI estimated the servings per unit of ${plural(result.estimated, 'item', 'items')}.`);
  if (namesUnchecked) lines.push('The file is a picture, so these names couldn’t be checked against its text.');
  else if (result.notInFile > 0) lines.push(`TownwiseAI didn’t find ${formatCount(result.notInFile)} of these names in the file.`);
  if (result.itemsCut) lines.push(`The file lists more items than TownwiseAI ${CHAT_CUT.limit} (${String(CHAT_CUT.cap)}), so some were left out. ${CHAT_CUT.rest}`);
  if (result.partial) lines.push('The file was too long to read whole, so TownwiseAI read only the start of it.');
  if (result.suppliersLeftOut.length > 0) lines.push(`Left out ${listText(result.suppliersLeftOut)}: the setup holds up to 20 suppliers.`);
  if (toDo > 0) {
    const par = result.added === 0 ? '' : `, set the par of ${result.added === 1 ? 'the new item' : `the ${formatCount(result.added)} new items`},`;
    lines.push(`Nothing is saved yet. Review these in Ordering setup${par} and save there.`);
  }
  return { ...base, inSetup: false, lines };
}
