import { aboutDraft, orderDraft, type OrderDraftBoard } from '../../src/chat/about';

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

const BOARD: OrderDraftBoard = {
  delivery: '2026-11-12',
  lines: [{ itemId: 'sample-lager', name: 'Sample lager' }],
};

test('an order link names the item and the delivery, and never a quantity', () => {
  expect(orderDraft('2026-11-12', 'sample-lager', BOARD)).toBe('Why Sample lager for the Thu, Nov 12 delivery?');
  expect(orderDraft('2026-11-12', undefined, BOARD)).toBe('Explain the order for the Thu, Nov 12 delivery');
  expect(orderDraft('2026-11-12', '', BOARD)).toBe('Explain the order for the Thu, Nov 12 delivery');
});

test('a date or item the board does not have leaves the composer alone', () => {
  expect(orderDraft('2026-11-13', 'sample-lager', BOARD)).toBeNull();
  expect(orderDraft('2026-11-12', 'missing', BOARD)).toBeNull();
  expect(orderDraft('2026-11-12', 'sample-lager', null)).toBeNull();
  expect(orderDraft(undefined, undefined, BOARD)).toBeNull();
});

test('anything else leaves the composer alone', () => {
  for (const about of [undefined, '', 'tomorrow', '2026-11-31', '2026-2-03', '20261121', '2026-11-21T00:00', '2009-12-31', '2027-12-12', ['2026-11-21', '2026-11-22'], 20261121]) {
    expect(aboutDraft(about, TODAY)).toBeNull();
  }
});
