import type { OrderLine } from '../../../src/portal/orders/api';
import { coverRows } from '../../../src/portal/orders/cover';

// "Will it last?" on Orders (P30): each line's stock after this order against the use Townwise expects before the
// following delivery. Synthetic items only.

function line(fields: Partial<OrderLine> & Pick<OrderLine, 'itemId' | 'name' | 'recommended'>): OrderLine {
  return {
    supplier: 'Sample distributor', unit: 'cases', neverRunOut: false, alternative: null, par: 2, mu: 8, sigma: 1, orderUpTo: 10,
    target: 0.95, onHand: 4, countAgeDays: 1, confidence: 'high', dealSize: null, coveredDays: 56, why: '', sample: false, edit: null, rules: [],
    ...fields,
  };
}

test('a row scales its stock and its marks to the largest of them', () => {
  const [row] = coverRows({ lines: [line({ itemId: 'a', name: 'Sample lager', recommended: 6 })] });
  // 4 on hand + 6 ordered = 10, the cushion level, so the bar ends on the cushion mark.
  expect(row).toMatchObject({ itemId: 'a', name: 'Sample lager', onHandPart: 0.4, orderPart: 0.6, usePoint: 0.8, cushionPoint: 1, status: 'covered' });
  expect(row?.text).toBe('4 cases on hand + 6 ordered = 10 cases. Expected use: about 8. That covers it, with the cushion Townwise aims for.');
});

test('stock under the expected use is short, and under the cushion is thin', () => {
  const rows = coverRows({
    lines: [
      line({ itemId: 'thin', name: 'Sample seltzer', recommended: 5 }),
      line({ itemId: 'short', name: 'Sample stout', recommended: 6, edit: { quantity: 2, reason: 'Slow week' }, mu: 7.25 }),
    ],
  });
  // The short line comes first, and it counts the owner's saved change, not Townwise's quantity.
  expect(rows.map((row) => [row.itemId, row.status])).toEqual([['short', 'short'], ['thin', 'thin']]);
  expect(rows[0]?.text).toBe('4 cases on hand + 2 ordered = 6 cases. Expected use: about 7.3. That is less than the expected use.');
  expect(rows[1]?.text).toBe('4 cases on hand + 5 ordered = 9 cases. Expected use: about 8. That covers it, with less to spare than Townwise aims for.');
});

test('with no cushion yet a covered row has no cushion mark', () => {
  const [row] = coverRows({ lines: [line({ itemId: 'a', name: 'Sample keg', unit: 'kegs', recommended: 1, onHand: 0.5, mu: 1, sigma: null, orderUpTo: 1 })] });
  expect(row).toMatchObject({ cushionPoint: null, status: 'covered' });
  expect(row?.text).toBe('0.5 kegs on hand + 1 ordered = 1.5 kegs. Expected use: about 1. That covers the expected use.');
});

test('a line with no count, a count older than 7 days, or no item sales has no row', () => {
  expect(coverRows({
    lines: [
      line({ itemId: 'a', name: 'No count', recommended: 2, onHand: null, countAgeDays: null }),
      line({ itemId: 'b', name: 'Old count', recommended: 2, countAgeDays: 8 }),
      line({ itemId: 'c', name: 'No sales', recommended: 2, mu: null, orderUpTo: null }),
      line({ itemId: 'd', name: 'Nothing at all', recommended: 0, onHand: 0, mu: 0, orderUpTo: 0 }),
    ],
  })).toEqual([]);
});
