import { fmt0, fmt1, fmtSigned, side } from '../../src/marketing/format';
import { countySeries, northeastSeries } from '../../src/marketing/map/countyData';

const MINUS = '\u2212';

test('fmt1 prints one decimal, half up, with the true minus', () => {
  expect(fmt1(103.51)).toBe('103.5');
  expect(fmt1(197)).toBe('197.0');
  // toFixed alone rounds these down (5.55 and 0.15 sit a hair under .5 in binary).
  expect(fmt1(5.55)).toBe('5.6');
  expect(fmt1(0.15)).toBe('0.2');
  expect(fmt1(-15.44)).toBe(`${MINUS}15.4`);
  expect(fmt1(-0.05)).toBe(`${MINUS}0.1`);
});

test('a value that rounds to zero has no sign', () => {
  expect(fmt1(-0.04)).toBe('0.0');
  expect(fmtSigned(-0.04)).toBe('0.0');
  expect(fmtSigned(0.04)).toBe('0.0');
  expect(fmtSigned(0)).toBe('0.0');
  expect(fmt0(-0.4)).toBe('0');
});

test('fmtSigned signs every gap that does not round to zero', () => {
  expect(fmtSigned(93.49)).toBe('+93.5');
  expect(fmtSigned(5.55)).toBe('+5.6');
  expect(fmtSigned(-7.26)).toBe(`${MINUS}7.3`);
  expect(fmtSigned(-15.44)).toBe(`${MINUS}15.4`);
});

test('fmt0 prints whole numbers, half up on the magnitude', () => {
  expect(fmt0(196.6)).toBe('197');
  expect(fmt0(103.51)).toBe('104');
  expect(fmt0(2.5)).toBe('3');
  expect(fmt0(-2.5)).toBe(`${MINUS}3`);
});

test('side gives the label word from the rounded value', () => {
  expect(side(93.49)).toBe('above');
  expect(side(-15.44)).toBe('below');
  expect(side(-0.04)).toBe('level with');
  expect(side(0.04)).toBe('level with');
});

test('every printed series value uses one decimal and never a hyphen-minus', () => {
  const values = [...northeastSeries.index, ...countySeries.flatMap((county) => [...county.index, ...county.gap])];
  for (const v of values) {
    expect(fmt1(v)).toMatch(/^\u2212?\d+\.\d$/);
    expect(fmtSigned(v)).toMatch(/^(?:[+\u2212]\d+\.\d|0\.0)$/);
  }
  for (const gap of countySeries.flatMap((county) => county.gap)) {
    const sign = fmtSigned(gap).charAt(0);
    expect(side(gap)).toBe(sign === '+' ? 'above' : sign === MINUS ? 'below' : 'level with');
  }
});
