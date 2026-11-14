import { formatCount } from '../format';
import type { LiveBoard, OrderRule, OrderUnit } from './api';

// The Orders page's words and its input checks, pure. A quantity is checked here before it is sent, so an empty or
// non-numeric field never becomes 0 or NaN (#68 review N6).

const SINGULAR: Readonly<Record<OrderUnit, string>> = { cases: 'case', kegs: 'keg', bottles: 'bottle', units: 'unit' };

/** '1 case', '3 cases', '2.5 kegs'. */
export function amount(value: number, unit: OrderUnit): string {
  const number = Number.isInteger(value) ? formatCount(value) : String(value);
  return `${number} ${value === 1 ? SINGULAR[unit] : unit}`;
}

/** 'Adds 2 cases to every order: “a football weekend”'. The situation is the owner's own words. */
export function ruleLine(rule: Pick<OrderRule, 'delta' | 'situation'>, unit: OrderUnit): string {
  const size = amount(Math.abs(rule.delta), unit);
  return rule.delta < 0 ? `Takes ${size} off every order: “${rule.situation}”` : `Adds ${size} to every order: “${rule.situation}”`;
}

export const LINE_QUANTITY_RULE = 'Enter a whole number from 0 to 999.';
export const REASON_RULE = 'Say why, in a few words.';
export const COUNT_RULE = 'Enter a number from 0 to 9,999, in whole or half units.';

/** A line's quantity as POST .../orders/decisions takes it (a whole number, 0 to 999), or null. */
export function parseLineQuantity(text: string): number | null {
  const trimmed = text.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

/** A counted quantity (0 to 9,999 in steps of 0.5), 'empty' for a blank field, or null when it is not one. */
export function parseCount(text: string): number | 'empty' | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if (!/^\d{1,4}(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 9999 && Number.isInteger(value * 2) ? value : null;
}

/** The filled fields as a count's items, and the ids of the fields that are not a count. Blank fields are left out. */
export function countItems(fields: Readonly<Record<string, string>>): { items: Record<string, number>; invalid: string[] } {
  const items: Record<string, number> = {};
  const invalid: string[] = [];
  for (const [itemId, text] of Object.entries(fields)) {
    const value = parseCount(text);
    if (value === null) invalid.push(itemId);
    else if (value !== 'empty') items[itemId] = value;
  }
  return { items, invalid };
}

/** How many items the board orders more than 0 of, across its suppliers' orders. */
export function itemsToOrder(board: LiveBoard): number {
  return board.orders.reduce((sum, order) => sum + order.lines.filter((line) => line.recommended > 0).length, 0);
}
