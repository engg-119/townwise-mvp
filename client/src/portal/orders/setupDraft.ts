import {
  ORDER_CATEGORIES, ORDER_UNITS, type Delivery, type OrderCategory, type OrderSetup, type OrderSetupInput, type OrderUnit,
  type SetupItemInput, type SetupSupplierInput,
} from './api';

// The Ordering setup page's draft and its checks (the order-setup spec): every field as the person typed it, checked
// against the server's own limits (api/src/orders/setup.ts setupInput and checkSetup) before Save, so a setup the
// server would refuse is caught here, field by field. Pure, shared by the page, the sheet import (template.ts) and
// their tests. A stored row's key is its id; a new row's key is minted here, and a new supplier is sent with that key,
// which its items name it by until the server mints its id.

export const SETUP_LIMITS = {
  suppliers: 20,
  deliveries: 7,
  items: 300,
  posNames: 10,
  supplierName: 60,
  itemName: 80,
  posName: 80,
  /** Servings per unit run from 0.1 to 2,000, as the server takes them. */
  servingsPerUnitMin: 0.1,
  servingsPerUnit: 2000,
  par: 999,
  dealSize: 999,
  perSale: 50,
} as const;

/** 0 = Sunday, as the server counts weekdays. */
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const CATEGORY_LABEL: Readonly<Record<OrderCategory, string>> = {
  bottles_cans: 'Bottles and cans', draft: 'Draft', liquor: 'Liquor', cocktail_ingredient: 'Cocktail ingredient',
};

export const UNIT_LABEL: Readonly<Record<OrderUnit, string>> = { cases: 'cases', kegs: 'kegs', bottles: 'bottles', units: 'units' };

export const CATEGORY_OPTIONS = ORDER_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABEL[value] }));
export const UNIT_OPTIONS = ORDER_UNITS.map((value) => ({ value, label: UNIT_LABEL[value] }));
export const WEEKDAY_OPTIONS = WEEKDAY_NAMES.map((label, index) => ({ value: String(index), label }));

export interface DeliveryDraft {
  /** '0' to '6', or '' before one is chosen. */
  readonly deliveryWeekday: string;
  readonly cutoffWeekday: string;
  /** As typed; HH:MM, 24 hour, once checked. */
  readonly cutoffTime: string;
}

export interface SupplierDraft {
  readonly key: string;
  /** The stored id, or null for a supplier this draft added. */
  readonly id: string | null;
  readonly name: string;
  readonly deliveries: readonly DeliveryDraft[];
}

export interface PosNameDraft {
  readonly name: string;
  /** As typed; empty reads as 1. */
  readonly perSale: string;
}

export interface ItemDraft {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  /** A supplier's key, or '' before one is chosen. */
  readonly supplierKey: string;
  readonly category: OrderCategory | '';
  readonly unit: OrderUnit | '';
  readonly servingsPerUnit: string;
  readonly par: string;
  /** Empty for none. */
  readonly dealSize: string;
  readonly neverRunOut: boolean;
  readonly posNames: readonly PosNameDraft[];
}

export interface SetupDraft {
  readonly suppliers: readonly SupplierDraft[];
  readonly items: readonly ItemDraft[];
}

let minted = 0;

/** A key for a row this draft adds: never a 24-hex id, and at most 40 characters, as the server takes a new supplier's key. */
export function newKey(kind: 'supplier' | 'item'): string {
  minted += 1;
  return `new-${kind}-${String(minted)}`;
}

export const EMPTY_DELIVERY: DeliveryDraft = { deliveryWeekday: '', cutoffWeekday: '', cutoffTime: '' };
export const EMPTY_POS_NAME: PosNameDraft = { name: '', perSale: '1' };

export function newSupplier(name = ''): SupplierDraft {
  return { key: newKey('supplier'), id: null, name, deliveries: [EMPTY_DELIVERY] };
}

export function newItem(supplierKey: string): ItemDraft {
  return {
    key: newKey('item'), id: null, name: '', supplierKey, category: '', unit: '', servingsPerUnit: '', par: '', dealSize: '',
    neverRunOut: false, posNames: [],
  };
}

/** The draft of a stored setup (an empty one when the location has none). */
export function draftOf(setup: OrderSetup | null): SetupDraft {
  if (setup === null) return { suppliers: [], items: [] };
  return {
    suppliers: setup.suppliers.map((supplier) => ({
      key: supplier.id,
      id: supplier.id,
      name: supplier.name,
      deliveries: supplier.deliveries.map((delivery) => ({
        deliveryWeekday: String(delivery.deliveryWeekday), cutoffWeekday: String(delivery.cutoffWeekday), cutoffTime: delivery.cutoffTime,
      })),
    })),
    items: setup.items.map((item) => ({
      key: item.id,
      id: item.id,
      name: item.name,
      supplierKey: item.supplierId,
      category: item.category,
      unit: item.unit,
      servingsPerUnit: String(item.servingsPerUnit),
      par: String(item.par),
      dealSize: item.dealSize === null ? '' : String(item.dealSize),
      neverRunOut: item.neverRunOut,
      posNames: item.posNames.map((pos) => ({ name: pos.name, perSale: String(pos.perSale) })),
    })),
  };
}

/** A name as point-of-sale names are matched: trimmed, case-folded, and runs of spaces as one. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Servings per unit: from 0.1 to 2,000; null when the text is not one. */
export function parseServings(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= SETUP_LIMITS.servingsPerUnitMin && value <= SETUP_LIMITS.servingsPerUnit ? value : null;
}

/** A par: a whole number from 0 to 999. */
export function parsePar(text: string): number | null {
  const trimmed = text.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

/** A deal size: empty for none, else a whole number from 1 to 999; null when the text is neither. */
export function parseDealSize(text: string): { value: number | null } | null {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  return /^\d{1,3}$/.test(trimmed) && Number(trimmed) >= 1 ? { value: Number(trimmed) } : null;
}

/** Servings per sale: empty reads as 1, else above 0 and at most 50. */
export function parsePerSale(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 1;
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 && value <= SETUP_LIMITS.perSale ? value : null;
}

/** An order-by time as the server takes it (HH:MM, 24 hour); "9:00" reads as "09:00". */
export function parseTime(text: string): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return match === null ? null : `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? ''}`;
}

function parseWeekday(text: string): number | null {
  return /^[0-6]$/.test(text) ? Number(text) : null;
}

/** A name of 1 to `max` characters once trimmed, as the server trims it. */
function nameFits(name: string, max: number): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= max;
}

export const SETUP_COPY = {
  supplierName: 'Enter a name of up to 60 characters.',
  noDelivery: 'Add at least one delivery.',
  sameDay: 'Two deliveries are on the same day. Keep one delivery per day.',
  deliveryDay: 'Choose the delivery day.',
  cutoffDay: 'Choose the order-by day.',
  cutoffTime: 'Enter the order-by time as HH:MM, 24 hour, such as 14:00.',
  itemName: 'Enter a name of up to 80 characters.',
  supplier: 'Choose a supplier.',
  category: 'Choose a category.',
  unit: 'Choose a unit.',
  servings: 'Enter a number from 0.1 to 2,000.',
  par: 'Enter a whole number from 0 to 999.',
  dealSize: 'Leave it empty, or enter a whole number from 1 to 999.',
  posName: 'Enter a name of up to 80 characters.',
  posTwice: 'This name is already listed for this item.',
  perSale: 'Enter a number above 0, up to 50.',
  tooManyDeliveries: 'A supplier has up to 7 deliveries, one per day.',
  tooManyPosNames: 'An item has up to 10 point-of-sale names.',
  tooManySuppliers: 'The setup holds up to 20 suppliers. Remove one before saving.',
  tooManyItems: 'The setup holds up to 300 items. Remove some before saving.',
} as const;

/** Where a check's message shows: a field of a supplier, a delivery, an item or a point-of-sale name, or the whole setup. */
export const fieldId = {
  setup: 'setup',
  supplier: (key: string, field: 'name' | 'deliveries'): string => `s:${key}:${field}`,
  delivery: (key: string, index: number, field: 'delivery' | 'cutoff' | 'time'): string => `s:${key}:d${String(index)}:${field}`,
  item: (key: string, field: 'name' | 'supplier' | 'category' | 'unit' | 'servings' | 'par' | 'deal' | 'posNames'): string => `i:${key}:${field}`,
  pos: (key: string, index: number, field: 'name' | 'perSale'): string => `i:${key}:p${String(index)}:${field}`,
} as const;

export type SetupProblems = Readonly<Record<string, readonly string[]>>;

export type DraftCheck = { ok: true; input: OrderSetupInput } | { ok: false; problems: SetupProblems; count: number };

/**
 * The draft as PUT .../orders/setup takes it, or every field that fails a check. Mirrors the server: names trimmed to
 * 1 to 60 (suppliers) or 80 (items, point-of-sale names) characters; 1 to 7 deliveries per supplier on different
 * days; order-by times HH:MM; an item's supplier in the setup; its category and unit; servings per unit, par and
 * deal size in range; up to 10 point-of-sale names, none twice. One stricter rule: two point-of-sale names that differ
 * only in spaces count as the same, since matching would count each sale twice.
 */
export function checkDraft(draft: SetupDraft): DraftCheck {
  const problems: Record<string, string[]> = {};
  let count = 0;
  const flag = (id: string, message: string): void => {
    (problems[id] ??= []).push(message);
    count += 1;
  };
  if (draft.suppliers.length > SETUP_LIMITS.suppliers) flag(fieldId.setup, SETUP_COPY.tooManySuppliers);
  if (draft.items.length > SETUP_LIMITS.items) flag(fieldId.setup, SETUP_COPY.tooManyItems);

  const suppliers: SetupSupplierInput[] = [];
  const refOf = new Map<string, string>();
  for (const supplier of draft.suppliers) {
    if (!nameFits(supplier.name, SETUP_LIMITS.supplierName)) flag(fieldId.supplier(supplier.key, 'name'), SETUP_COPY.supplierName);
    if (supplier.deliveries.length === 0) flag(fieldId.supplier(supplier.key, 'deliveries'), SETUP_COPY.noDelivery);
    if (supplier.deliveries.length > SETUP_LIMITS.deliveries) flag(fieldId.supplier(supplier.key, 'deliveries'), SETUP_COPY.tooManyDeliveries);
    const deliveries: Delivery[] = [];
    supplier.deliveries.forEach((delivery, index) => {
      const deliveryWeekday = parseWeekday(delivery.deliveryWeekday);
      const cutoffWeekday = parseWeekday(delivery.cutoffWeekday);
      const cutoffTime = parseTime(delivery.cutoffTime);
      if (deliveryWeekday === null) flag(fieldId.delivery(supplier.key, index, 'delivery'), SETUP_COPY.deliveryDay);
      if (cutoffWeekday === null) flag(fieldId.delivery(supplier.key, index, 'cutoff'), SETUP_COPY.cutoffDay);
      if (cutoffTime === null) flag(fieldId.delivery(supplier.key, index, 'time'), SETUP_COPY.cutoffTime);
      if (deliveryWeekday !== null && cutoffWeekday !== null && cutoffTime !== null) {
        deliveries.push({ deliveryWeekday, cutoffWeekday, cutoffTime });
      }
    });
    const days = supplier.deliveries.map((delivery) => delivery.deliveryWeekday).filter((day) => day !== '');
    if (new Set(days).size !== days.length) flag(fieldId.supplier(supplier.key, 'deliveries'), SETUP_COPY.sameDay);
    const name = supplier.name.trim();
    suppliers.push(supplier.id === null ? { key: supplier.key, name, deliveries } : { id: supplier.id, name, deliveries });
    refOf.set(supplier.key, supplier.id ?? supplier.key);
  }

  const items: SetupItemInput[] = [];
  for (const item of draft.items) {
    const id = (field: Parameters<typeof fieldId.item>[1]): string => fieldId.item(item.key, field);
    if (!nameFits(item.name, SETUP_LIMITS.itemName)) flag(id('name'), SETUP_COPY.itemName);
    const supplierId = refOf.get(item.supplierKey);
    if (supplierId === undefined) flag(id('supplier'), SETUP_COPY.supplier);
    if (item.category === '') flag(id('category'), SETUP_COPY.category);
    if (item.unit === '') flag(id('unit'), SETUP_COPY.unit);
    const servingsPerUnit = parseServings(item.servingsPerUnit);
    if (servingsPerUnit === null) flag(id('servings'), SETUP_COPY.servings);
    const par = parsePar(item.par);
    if (par === null) flag(id('par'), SETUP_COPY.par);
    const deal = parseDealSize(item.dealSize);
    if (deal === null) flag(id('deal'), SETUP_COPY.dealSize);
    if (item.posNames.length > SETUP_LIMITS.posNames) flag(id('posNames'), SETUP_COPY.tooManyPosNames);
    const seen = new Set<string>();
    const posNames = item.posNames.flatMap((pos, index) => {
      const perSale = parsePerSale(pos.perSale);
      const fits = nameFits(pos.name, SETUP_LIMITS.posName);
      if (!fits) flag(fieldId.pos(item.key, index, 'name'), SETUP_COPY.posName);
      else if (seen.has(normalizeName(pos.name))) flag(fieldId.pos(item.key, index, 'name'), SETUP_COPY.posTwice);
      seen.add(normalizeName(pos.name));
      if (perSale === null) flag(fieldId.pos(item.key, index, 'perSale'), SETUP_COPY.perSale);
      return fits && perSale !== null ? [{ name: pos.name.trim(), perSale }] : [];
    });
    if (
      supplierId === undefined || item.category === '' || item.unit === '' || servingsPerUnit === null || par === null || deal === null
    ) continue;
    const fields = {
      name: item.name.trim(), supplierId, category: item.category, unit: item.unit, servingsPerUnit, par, dealSize: deal.value,
      neverRunOut: item.neverRunOut, posNames,
    };
    items.push(item.id === null ? fields : { id: item.id, ...fields });
  }
  return count === 0 ? { ok: true, input: { suppliers, items } } : { ok: false, problems, count };
}
