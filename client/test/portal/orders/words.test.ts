import { amount, countItems, parseCount, parseLineQuantity, ruleLine } from '../../../src/portal/orders/words';

// The Orders page's input checks (#68 review N6): what the server takes (api/src/handlers/orders.ts decisionBody, and
// order-setup.ts countBody) and nothing else, so an empty field never becomes 0 and text never becomes NaN.

test('a line’s quantity is a whole number from 0 to 999', () => {
  expect(['0', '7', ' 12 ', '999'].map(parseLineQuantity)).toEqual([0, 7, 12, 999]);
  for (const text of ['', ' ', 'abc', '1000', '-1', '2.5', '1e2', '0x10', '7 cases']) expect(parseLineQuantity(text)).toBeNull();
});

test('a count is 0 to 9,999 in whole or half units; a blank field is left out', () => {
  expect(['0', '3', '2.5', ' 4.0 ', '9999'].map(parseCount)).toEqual([0, 3, 2.5, 4, 9999]);
  expect(parseCount('')).toBe('empty');
  expect(parseCount('  ')).toBe('empty');
  for (const text of ['1.3', '9999.5', '10000', '-1', 'two', '1e3', '.5', '3,5']) expect(parseCount(text)).toBeNull();
  expect(countItems({ a: '3', b: '', c: '2.5', d: 'x' })).toEqual({ items: { a: 3, c: 2.5 }, invalid: ['d'] });
});

test('amounts and rules in words', () => {
  expect([amount(1, 'cases'), amount(2, 'kegs'), amount(2.5, 'bottles'), amount(1200, 'units')]).toEqual(['1 case', '2 kegs', '2.5 bottles', '1,200 units']);
  expect(ruleLine({ delta: 2, situation: 'a football weekend' }, 'cases')).toBe('Adds 2 cases to every order: “a football weekend”');
  expect(ruleLine({ delta: -1, situation: 'slow week' }, 'kegs')).toBe('Takes 1 keg off every order: “slow week”');
});
