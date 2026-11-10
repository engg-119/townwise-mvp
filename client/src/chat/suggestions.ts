import type { ToolStep } from './tools';

// The chips of an empty conversation (spec P25). Ask chips send at once; Tell chips put the start of a sentence
// in the composer and send nothing. Each Ask chip shows only when Townwise has what it needs to answer, and none asks
// for a forecast or an order quantity: Townwise has no forecast yet. Under a settled reply that suggested no next
// questions, nextFallback picks three by fixed rules.

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

/** "What’s coming up in December in Hanover?": the month after `today`'s. */
function comingUp(today: string, townName: string): string {
  const month = MONTHS[(Number(today.slice(5, 7)) % 12)] ?? '';
  return `What’s coming up in ${month} in ${townName}?`;
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
  if (input.hasTownProfile) add(comingUp(today, input.townName));
  if (coverage.dayCount === 0) add('What should I upload?');
  const tell: Suggestion[] = [
    { kind: 'tell', label: 'We’re closed on …', text: 'We’re closed on ' },
    { kind: 'tell', label: 'We have a private event on …', text: 'We have a private event on ' },
  ];
  return [...ask, ...tell].slice(0, MAX);
}

const UPLOAD = 'What should I upload?';

/** The same question however it was typed: case, spacing, and a straight or curly apostrophe. */
function sameQuestion(a: string, b: string): boolean {
  const plain = (text: string): string => text.trim().replace(/\s+/g, ' ').replace(/'/g, '’').toLowerCase();
  return plain(a) === plain(b);
}

/**
 * The three next questions under a settled reply that came with none of its own (owner decision 6): the first three
 * of these rules that apply, never the message just sent, and never a forecast question (P25). The last three always
 * apply; when the message just sent was one of them and nothing else does (sales that stopped over 10 days ago, under
 * 60 days of them, an unresearched town), "What should I upload?" fills the third place, so there are always three.
 */
export function nextFallback(input: {
  /** The reply's tool calls. */
  steps: readonly ToolStep[];
  /** The reply drew a visual. */
  hasVisual: boolean;
  coverage: { dayCount: number; lastDate: string | null };
  /** YYYY-MM-DD. */
  today: string;
  townName: string;
  hasTownProfile: boolean;
  /** The person's message the reply answered. */
  lastAsked: string;
}): [string, string, string] {
  const { coverage, today } = input;
  const readSales = input.steps.some((step) => step.name === 'get_sales_days' && step.state === 'done');
  const rules: [string, boolean][] = [
    ['Show that as a chart', readSales && !input.hasVisual],
    ['Compare that with the same days last year', readSales],
    ['Is anything on the town calendar then?', readSales && input.hasTownProfile],
    ['How did last week go?', coverage.lastDate !== null && daysBetween(coverage.lastDate, today) <= 10],
    ['Which days last month were unusual?', coverage.dayCount >= 60],
    [comingUp(today, input.townName), input.hasTownProfile],
    [UPLOAD, coverage.dayCount === 0],
    ['What notes do I have?', true],
    ['What can you read for me?', true],
    ['What’s missing from my data?', true],
    [UPLOAD, true],
  ];
  const picks: string[] = [];
  for (const [prompt, applies] of rules) {
    if (applies && !picks.includes(prompt) && !sameQuestion(prompt, input.lastAsked)) picks.push(prompt);
  }
  return [picks[0] ?? '', picks[1] ?? '', picks[2] ?? ''];
}
