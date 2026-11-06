import { suggestionsFor } from '../../src/chat/suggestions';

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
