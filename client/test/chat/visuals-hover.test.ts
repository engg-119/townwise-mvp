import { barTip, dailyTip, nearestIndex, slotIndex } from '../../src/chat/visuals/hover';

test('nearestIndex snaps to the closest of N points and clamps', () => {
  expect(nearestIndex(0, 5)).toBe(0);
  expect(nearestIndex(0.4, 5)).toBe(2);
  expect(nearestIndex(0.37, 5)).toBe(1);
  expect(nearestIndex(1, 5)).toBe(4);
  expect(nearestIndex(-0.2, 5)).toBe(0);
  expect(nearestIndex(1.3, 5)).toBe(4);
  expect(nearestIndex(0.9, 1)).toBe(0);
  expect(nearestIndex(0.5, 0)).toBeNull();
  expect(nearestIndex(Number.NaN, 5)).toBeNull();
});

test('slotIndex finds the bar under an x fraction', () => {
  expect(slotIndex(0, 7)).toBe(0);
  expect(slotIndex(0.5, 7)).toBe(3);
  expect(slotIndex(1, 7)).toBe(6);
  expect(slotIndex(1.01, 7)).toBeNull();
  expect(slotIndex(-0.01, 7)).toBeNull();
});

const none = { low: null, mid: null, high: null, status: null } as const;

test('dailyTip words a day like the summary and table do', () => {
  // A visual stored before the API sent the forecast's middle.
  expect(dailyTip({ date: '2026-10-09', value: 180, low: 117, mid: null, high: 256, status: null }, 'guests'))
    .toEqual({ title: 'Fri, Oct 9, 2026', lines: ['180 guests', 'Forecast 117 to 256'] });
  expect(dailyTip({ date: '2026-10-09', value: null, ...none }, 'guests').lines).toEqual(['No data']);
  expect(dailyTip({ date: '2026-10-09', value: 1234.5, ...none }, 'netSales').lines).toEqual(['$1,235']);
});

test('dailyTip gives a forecast day as the product does, about the middle and likely the range, and the actual with sales', () => {
  expect(dailyTip({ date: '2026-11-16', value: null, low: 117, mid: 180, high: 256, status: null }, 'guests'))
    .toEqual({ title: 'Mon, Nov 16, 2026', lines: ['Forecast about 180, likely 117 to 256'] });
  expect(dailyTip({ date: '2026-11-16', value: 1204, low: 1100, mid: 1500, high: 2100, status: null }, 'guests').lines)
    .toEqual(['1,204 guests', 'Forecast about 1,500, likely 1,100 to 2,100']);
  expect(dailyTip({ date: '2026-11-18', value: null, ...none, status: 'closed' }, 'guests').lines).toEqual(['Forecast: closed']);
  expect(dailyTip({ date: '2026-11-21', value: null, ...none, status: 'booked' }, 'guests').lines).toEqual(['Forecast: booked for a private event']);
});

test('barTip gives the label, value and days, and nothing for a bar with no value', () => {
  expect(barTip('Saturday', 150, 4, 'guests')).toEqual({ title: 'Saturday', lines: ['150 guests', '4 days with data'] });
  expect(barTip('Saturday', 150, 1, 'guests')?.lines[1]).toBe('1 day with data');
  expect(barTip('Sunday', null, 0, 'guests')).toBeNull();
});
