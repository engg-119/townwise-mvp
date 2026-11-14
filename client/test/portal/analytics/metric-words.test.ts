import { metricText } from '../../../src/portal/analytics/words';

// A count of guests reads in words with its noun: one guest is singular, every other count plural.

test('one guest is singular; zero and many are plural; dollars keep their sign', () => {
  expect(metricText(1, 'guests')).toBe('1 guest');
  expect(metricText(0, 'guests')).toBe('0 guests');
  expect(metricText(1241, 'guests')).toBe('1,241 guests');
  // Net sales arrive in cents.
  expect(metricText(521_000, 'netSales')).toBe('$5,210');
});
