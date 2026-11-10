import { nextFallback, suggestionsFor } from '../../src/chat/suggestions';
import type { ToolStep } from '../../src/chat/tools';

// spec P25: Ask chips only when Townwise can answer them, Tell chips always, Ask first, at most four, and none
// asks for a forecast.

const TOWN = { townName: 'Hanover', hasTownProfile: true };

function labels(input: Parameters<typeof suggestionsFor>[0]): string[] {
  return suggestionsFor(input).map((item) => `${item.kind}: ${item.label}`);
}

test('with recent sales, a long history and a researched town: three Ask chips, then one Tell', () => {
  expect(labels({ ...TOWN, coverage: { dayCount: 400, lastDate: '2026-11-01' }, today: '2026-11-05' })).toEqual([
    'ask: How did last week go?',
    'ask: Which days last month were unusual?',
    'ask: What’s coming up in December in Hanover?',
    'tell: We’re closed on …',
  ]);
});

test('each Ask chip needs what it asks about', () => {
  // Sales that stopped more than 10 days ago: no "last week".
  expect(labels({ ...TOWN, coverage: { dayCount: 400, lastDate: '2026-10-20' }, today: '2026-11-05' })).not.toContain('ask: How did last week go?');
  // Under 60 days: no "unusual days".
  expect(labels({ ...TOWN, coverage: { dayCount: 59, lastDate: '2026-11-01' }, today: '2026-11-05' })).not.toContain('ask: Which days last month were unusual?');
  // A town Townwise hasn't researched: no "coming up".
  expect(labels({ townName: 'Norwich', hasTownProfile: false, coverage: { dayCount: 0, lastDate: null }, today: '2026-11-05' })).toEqual([
    'ask: What should I upload?',
    'tell: We’re closed on …',
    'tell: We have a private event on …',
  ]);
  // December's next month is January.
  expect(labels({ ...TOWN, coverage: { dayCount: 0, lastDate: null }, today: '2026-12-15' })[0]).toBe('ask: What’s coming up in January in Hanover?');
});

test('Tell chips put the start of a sentence in the composer; none asks for a forecast', () => {
  const items = suggestionsFor({ townName: 'Norwich', hasTownProfile: false, coverage: { dayCount: 0, lastDate: null }, today: '2026-11-05' });
  expect(items.filter((item) => item.kind === 'tell').map((item) => item.text)).toEqual(['We’re closed on ', 'We have a private event on ']);
  expect(items.every((item) => !/forecast|order/i.test(item.text))).toBe(true);
});

// The fallback next questions under a settled reply that came with none of its own (owner decision 6): the first
// three rules that apply, never the message just sent, and never a forecast question.

const SALES_READ: ToolStep = {
  id: 't1', name: 'get_sales_days', state: 'done', input: { from: '2026-10-01', to: '2026-10-31' }, result: { dayCount: 31 },
};
const NOTES_READ: ToolStep = { id: 't2', name: 'list_notes', state: 'done', input: null, result: { count: 2 } };
type FallbackInput = Parameters<typeof nextFallback>[0];
const BASE: FallbackInput = {
  steps: [], hasVisual: false, coverage: { dayCount: 400, lastDate: '2026-11-01' }, today: '2026-11-05', townName: 'Hanover',
  hasTownProfile: true, lastAsked: 'How were October’s Fridays?',
};

test('after a reply that read sales days, it offers the chart, last year and the town calendar', () => {
  expect(nextFallback({ ...BASE, steps: [SALES_READ] })).toEqual([
    'Show that as a chart',
    'Compare that with the same days last year',
    'Is anything on the town calendar then?',
  ]);
  // A reply that already drew one isn’t offered a chart again, and an unresearched town has no calendar question.
  expect(nextFallback({ ...BASE, steps: [SALES_READ], hasVisual: true, hasTownProfile: false })).toEqual([
    'Compare that with the same days last year',
    'How did last week go?',
    'Which days last month were unusual?',
  ]);
  // A sales read that failed read nothing.
  expect(nextFallback({ ...BASE, steps: [{ ...SALES_READ, state: 'error', result: null }] })[0]).toBe('How did last week go?');
});

test('without a sales read, it falls back to the location’s own questions, in order', () => {
  expect(nextFallback({ ...BASE, steps: [NOTES_READ] })).toEqual([
    'How did last week go?',
    'Which days last month were unusual?',
    'What’s coming up in December in Hanover?',
  ]);
  expect(nextFallback({ ...BASE, coverage: { dayCount: 0, lastDate: null }, townName: 'Norwich', hasTownProfile: false })).toEqual([
    'What should I upload?',
    'What notes do I have?',
    'What can you read for me?',
  ]);
  // December’s next month is January.
  expect(nextFallback({ ...BASE, coverage: { dayCount: 0, lastDate: null }, today: '2026-12-15' })[0]).toBe('What’s coming up in January in Hanover?');
});

test('never repeats the message just sent, however it was typed', () => {
  expect(nextFallback({ ...BASE, steps: [SALES_READ], lastAsked: 'Show that as a chart' })).toEqual([
    'Compare that with the same days last year',
    'Is anything on the town calendar then?',
    'How did last week go?',
  ]);
  expect(nextFallback({ ...BASE, steps: [], lastAsked: '  how did last WEEK go? ' })).not.toContain('How did last week go?');
  expect(nextFallback({ ...BASE, steps: [], lastAsked: 'What\'s coming up in December in Hanover?' })).not.toContain('What’s coming up in December in Hanover?');
});

test('nextFallback always gives exactly three, never the message just sent, and never a forecast question', () => {
  const asked = ['', 'Show that as a chart', 'How did last week go?', 'What should I upload?', 'What notes do I have?', 'What can you read for me?', 'What’s missing from my data?'];
  const coverages = [{ dayCount: 0, lastDate: null }, { dayCount: 30, lastDate: '2026-10-01' }, { dayCount: 59, lastDate: '2026-11-04' }, { dayCount: 400, lastDate: '2026-11-01' }];
  for (const lastAsked of asked) {
    for (const coverage of coverages) {
      for (const hasTownProfile of [true, false]) {
        for (const steps of [[], [SALES_READ], [NOTES_READ]]) {
          for (const hasVisual of [true, false]) {
            const prompts = nextFallback({ ...BASE, lastAsked, coverage, hasTownProfile, steps, hasVisual });
            expect(prompts).toHaveLength(3);
            expect(new Set(prompts).size).toBe(3);
            expect(prompts).not.toContain(lastAsked);
            expect(prompts.every((prompt) => !/forecast|order/i.test(prompt))).toBe(true);
          }
        }
      }
    }
  }
});

test('sales that stopped over 10 days ago, in an unresearched town: asking one of the three still leaves three', () => {
  const stale = { ...BASE, coverage: { dayCount: 30, lastDate: '2026-10-01' }, hasTownProfile: false };
  expect(nextFallback(stale)).toEqual(['What notes do I have?', 'What can you read for me?', 'What’s missing from my data?']);
  expect(nextFallback({ ...stale, lastAsked: 'What notes do I have?' })).toEqual([
    'What can you read for me?',
    'What’s missing from my data?',
    'What should I upload?',
  ]);
});
