import { aboutDraft } from '../../src/chat/about';

// F7: what `?about=YYYY-MM-DD` puts in the Agent page's composer. Only one real date in get_day's range is used.

const TODAY = '2026-11-06';

test('a day this year reads with its weekday, and another year adds the year', () => {
  expect(aboutDraft('2026-11-21', TODAY)).toBe('Tell me about Sat, Nov 21');
  expect(aboutDraft('2026-01-01', TODAY)).toBe('Tell me about Thu, Jan 1');
  expect(aboutDraft('2025-11-22', TODAY)).toBe('Tell me about Sat, Nov 22, 2025');
  expect(aboutDraft('2010-01-01', TODAY)).toBe('Tell me about Fri, Jan 1, 2010');
  // 400 days after today is the last day get_day reads.
  expect(aboutDraft('2027-12-11', TODAY)).toBe('Tell me about Sat, Dec 11, 2027');
});

test('anything else leaves the composer alone', () => {
  for (const about of [undefined, '', 'tomorrow', '2026-11-31', '2026-2-03', '20261121', '2026-11-21T00:00', '2009-12-31', '2027-12-12', ['2026-11-21', '2026-11-22'], 20261121]) {
    expect(aboutDraft(about, TODAY)).toBeNull();
  }
});
