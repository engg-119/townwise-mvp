// What Townwise does to any model's answer before trusting it: keep the list entries that pass a schema, read a value
// as one of a set, and replace an email address or phone number the model wrote anyway. The file readers (spec 11A.9,
// D41) and the chat's ordering suggestions (D56) share these, so they sit outside files/: chat code may not import
// file code (test/isolation.test.ts), and a copied redaction pattern could drift. Nothing here logs.
import type { z } from 'zod';

/** The entries of `raw` that pass `entry`, in order, at most `max`; anything that is not a list has none. */
export function entries<T>(raw: unknown, entry: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const kept: T[] = [];
  for (const item of raw) {
    if (kept.length >= max) break;
    const parsed = entry.safeParse(item);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], otherwise: T): T {
  return allowed.find((candidate) => candidate === value) ?? otherwise;
}

/** An email address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/**
 * A formatted phone number: ten digits in groups apart by a space, dot or dash (the first in brackets too), with an
 * optional country code. Without a +country code it is a North American number, 3, 3 and 4 digits whose first and
 * second groups don't start with 0 or 1 (603-555-0123, (603) 555-0123, 1-800-555-0199); with one, 3, 3 and 4 or 2, 4
 * and 4 digits (+1 603 555 0123, +44 20 7946 0958). Anything else is never one, so a name's sizes, counts and codes
 * keep their digits (Lager 12 16 24, IPA 1/2 BBL 15.5 gal, Item 12 750 1000, SKU 1234-5678-9012), as do a date
 * (2026-06-14), an amount, and digits run together or of another length (6035550142, 555-0142). No digit, letter or
 * number part may touch either end (a full stop or comma after one ends a sentence).
 */
const PHONE = /(?<![\w$.,/-])(?:(?:1[\s.-])?(?:\([2-9]\d{2}\)[\s.-]?|[2-9]\d{2}[\s.-])[2-9]\d{2}[\s.-]\d{4}|\+\d{1,3}[\s.-]?(?:(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}|(?:\(\d{2}\)[\s.-]?|\d{2}[\s.-])\d{4}[\s.-]\d{4}))(?![\w/-]|[.,]\d)/g;

/**
 * `text` with each email address as "[email]" and each phone number as "[phone]", within `max` characters (never
 * between the two halves of a surrogate pair). The prompt forbids them; this keeps one the model wrote anyway.
 */
export function redacted(text: string, max: number): string {
  const out = text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  if (out.length <= max) return out;
  const code = out.charCodeAt(max - 1);
  return out.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
