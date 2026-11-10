// The greeting and the name rule (the API's rule, so a refusal is rare): trimmed, NFC, inner whitespace collapsed,
// 1 to 40 characters; letters and marks, with inner spaces, hyphens, apostrophes (straight or curly) and periods.

export const NAME_MESSAGE = 'Use letters, spaces, hyphens or apostrophes, up to 40 characters.';

const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

/** The name as the API stores it: trimmed, NFC, runs of whitespace collapsed to one space. */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** The message to show for a name the API would refuse, or null. An empty name is not a problem: it means no name. */
export function nameProblem(raw: string): string | null {
  const name = normalizeName(raw);
  if (name === '') return null;
  return name.length <= 40 && NAME_SHAPE.test(name) ? null : NAME_MESSAGE;
}

/** "Welcome back, {name}." with no doubled full stop when the name ends in one, else "Welcome back." */
export function greeting(name: string | null): string {
  if (name === null || name.trim() === '') return 'Welcome back.';
  const trimmed = name.trim();
  return `Welcome back, ${trimmed}${trimmed.endsWith('.') ? '' : '.'}`;
}
