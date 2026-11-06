// The chips of an empty conversation (spec P25). Ask chips send at once; Tell chips put the start of a sentence
// in the composer and send nothing. Each Ask chip shows only when Townwise has what it needs to answer, and none asks
// for a forecast or an order quantity: Townwise has no forecast yet.

export interface Suggestion {
  kind: 'ask' | 'tell';
  /** What the chip says. */
  label: string;
  /** What it sends (ask) or puts in the composer (tell). */
  text: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX = 4;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

export function suggestionsFor(input: {
  /** The location's sales coverage (spec 10.3): how many days, and the last one. */
  coverage: { dayCount: number; lastDate: string | null };
  /** YYYY-MM-DD. */
  today: string;
  townName: string;
  /** Whether Townwise has researched the town (it has a town id). */
  hasTownProfile: boolean;
}): Suggestion[] {
  const { coverage, today } = input;
  const ask: Suggestion[] = [];
  const add = (text: string): void => { ask.push({ kind: 'ask', label: text, text }); };
  if (coverage.lastDate !== null && daysBetween(coverage.lastDate, today) <= 10) add('How did last week go?');
  if (coverage.dayCount >= 60) add('Which days last month were unusual?');
  if (input.hasTownProfile) {
    const month = MONTHS[(Number(today.slice(5, 7)) % 12)] ?? '';
    add(`What’s coming up in ${month} in ${input.townName}?`);
  }
  if (coverage.dayCount === 0) add('What should I upload?');
  const tell: Suggestion[] = [
    { kind: 'tell', label: 'We’re closed on …', text: 'We’re closed on ' },
    { kind: 'tell', label: 'We have a private event on …', text: 'We have a private event on ' },
  ];
  return [...ask, ...tell].slice(0, MAX);
}
