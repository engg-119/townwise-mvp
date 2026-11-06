import { estimatesAboutSchema, fetchEstimatesAbout, fetchPeopleInTown, monthRange, peopleInTownSchema } from '../../../src/portal/estimates/api';
import {
  dayText, headcountLines, historyLine, noNumberLine, peopleLine, rangeText, reasonLine, sourceHosts, termLines, termSpans,
} from '../../../src/portal/estimates/format';
import { analyticsFake } from '../analytics/fakes';
import { ABOUT, ABOUT_PATH, LOCATION_ID, NOVEMBER, PEOPLE_PATH, period } from './fakes';

// The estimate sentences (spec 13.2): ranges rounded outward, reasons with effects only where recorded, term periods
// in words with honest gaps, headcount lines or the "can't put a number on it" line, the history line only with both
// term states, and source hosts. Synthetic data only.

describe('the two reads', () => {
  test('fetch people in town for a month and the model card facts, and keep their shapes', async () => {
    const api = analyticsFake({ [PEOPLE_PATH]: NOVEMBER, [ABOUT_PATH]: ABOUT });
    expect(await fetchPeopleInTown(api, LOCATION_ID, monthRange('2026-11'))).toEqual(NOVEMBER);
    expect(await fetchEstimatesAbout(api, LOCATION_ID)).toEqual(ABOUT);
    expect(api.paths).toEqual([PEOPLE_PATH, ABOUT_PATH]);
  });

  test('a month range runs from the first to the last day, February included', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  test('an about body that claims a forecast run fails the read until the run state exists', () => {
    expect(estimatesAboutSchema.safeParse({ ...ABOUT, forecast: { run: { id: 'r1' }, live: null } }).success).toBe(false);
    expect(peopleInTownSchema.safeParse({ ...NOVEMBER, periods: [{ from: '2026-11-01' }] }).success).toBe(false);
  });
});

describe('rangeText and reasonLine', () => {
  test('round the low end down and the high end up, with thousands commas', () => {
    expect(rangeText(180.7, 259.2)).toBe('180 to 260 guests');
    expect(rangeText(9500, 10_500, 'people')).toBe('9,500 to 10,500 people');
  });

  test('reasons carry effects only where the run recorded them, with a true minus', () => {
    expect(reasonLine([{ label: 'Saturday', effectPct: null }, { label: 'fall term', effectPct: null }, { label: 'Football vs Brown', effectPct: 12 }]))
      .toBe('Saturday, fall term, Football vs Brown (+12%).');
    expect(reasonLine([{ label: 'snow day', effectPct: -5 }])).toBe('Snow day (−5%).');
    expect(reasonLine([])).toBe('');
  });
});

describe('termLines', () => {
  test('folds events away and says each term period in words, with the days that have no term dates', () => {
    expect(termSpans(NOVEMBER.periods).map((span) => span.state)).toEqual(['in_session', 'unknown', 'finals', 'unknown']);
    expect(termLines(NOVEMBER)).toEqual([
      'Fall term classes until Tue, Nov 17.',
      'Townwise has no term dates Wed, Nov 18 to Thu, Nov 19.',
      'Fall term finals Fri, Nov 20 to Wed, Nov 25.',
      'Townwise has no term dates from Thu, Nov 26.',
    ]);
  });

  test('a break between terms says it is worked out from the term dates', () => {
    const window = {
      ...NOVEMBER,
      periods: [
        period({ from: '2026-11-01', fromWeekday: 'Sun', to: '2026-11-25', toWeekday: 'Wed', termState: 'finals', termLabel: 'Fall term finals' }),
        period({ from: '2026-11-26', fromWeekday: 'Thu', to: '2026-11-30', toWeekday: 'Mon', termState: 'between_terms', termLabel: 'Between terms (from the term dates)' }),
      ],
    };
    expect(termLines(window)).toEqual([
      'Fall term finals until Wed, Nov 25.', 'Between terms from Thu, Nov 26.', 'Between terms is worked out from the term dates.',
    ]);
  });

  test('a seasonal town with no term dates gets no term lines; a college town says it has none', () => {
    const unknown = [period({ from: '2026-07-01', fromWeekday: 'Wed', to: '2026-07-31', toWeekday: 'Fri', termState: 'unknown', termLabel: null })];
    const seasonal = { ...NOVEMBER, from: '2026-07-01', to: '2026-07-31', periods: unknown, town: { name: 'Nantucket', state: 'MA', kind: 'seasonal' as const } };
    expect(termLines(seasonal)).toEqual([]);
    expect(termLines({ ...seasonal, town: NOVEMBER.town })).toEqual(['Townwise has no term dates Wed, Jul 1 to Fri, Jul 31.']);
  });

  test('dayText gives the weekday and the day without the year', () => {
    expect(dayText('2026-11-17', 'Tue')).toBe('Tue, Nov 17');
  });
});

describe('peopleLine', () => {
  test('a headcount reads as a range of people with its source count; none reads as the honest line', () => {
    const counted = period({
      from: '2026-11-02', fromWeekday: 'Mon', to: '2026-11-06', toWeekday: 'Fri', headcountWhy: null,
      headcount: { low: 9500, high: 10_500, sourceIds: ['census-test', 'cal-1', 'bls-qcew'], excludes: [] },
    });
    expect(peopleLine(counted, { name: 'Hanover' })).toBe('Fall term classes. About 9,500 to 10,500 people in town, from 3 sources.');
    const between = period({ from: '2026-11-26', fromWeekday: 'Thu', to: '2026-11-30', toWeekday: 'Mon', termState: 'between_terms', termLabel: 'Between terms (from the term dates)' });
    expect(peopleLine(between, { name: 'Hanover' })).toBe('Between terms. Townwise can’t put a number on how many people are in Hanover yet.');
    expect(noNumberLine({ name: 'Ithaca' })).toBe('Townwise can’t put a number on how many people are in Ithaca yet.');
  });
});

describe('headcountLines', () => {
  const range = { low: 9500, high: 10_500, sourceIds: ['census-test'], excludes: [] };

  test('are empty when no day has a range, so the summary shows the term lines and the can’t-put-a-number line', () => {
    expect(headcountLines(NOVEMBER)).toEqual([]);
  });

  test('fold days with the same term and range into one dated line, split where the range changes, and say why days have none', () => {
    const window = {
      ...NOVEMBER,
      periods: [
        period({ from: '2026-11-01', fromWeekday: 'Sun', to: '2026-11-13', toWeekday: 'Fri', headcountWhy: null, headcount: range }),
        period({ from: '2026-11-14', fromWeekday: 'Sat', to: '2026-11-14', toWeekday: 'Sat', headcountWhy: null, headcount: { ...range, high: 16_500 } }),
        period({ from: '2026-11-15', fromWeekday: 'Sun', to: '2026-11-17', toWeekday: 'Tue', headcountWhy: null, headcount: range }),
        period({ from: '2026-11-18', fromWeekday: 'Wed', to: '2026-11-25', toWeekday: 'Wed', termState: 'between_terms', termLabel: 'Between terms (from the term dates)', headcountWhy: 'no_enrollment' }),
        period({ from: '2026-11-26', fromWeekday: 'Thu', to: '2026-11-30', toWeekday: 'Mon', termState: 'unknown', termLabel: null, headcountWhy: 'no_term_dates' }),
      ],
    };
    expect(headcountLines(window)).toEqual([
      'Fall term classes until Fri, Nov 13. About 9,500 to 10,500 people in town, from 1 source.',
      'Fall term classes on Sat, Nov 14. About 9,500 to 16,500 people in town, from 1 source.',
      'Fall term classes Sun, Nov 15 to Tue, Nov 17. About 9,500 to 10,500 people in town, from 1 source.',
      'Townwise can’t put a number on how many people are in Hanover, Wed, Nov 18 to Wed, Nov 25.',
      'Townwise has no term dates from Thu, Nov 26, so it can’t put a number on how many people are in town.',
      'Between terms is worked out from the term dates.',
    ]);
  });
});

describe('historyLine', () => {
  test('names the weekday with the most days that has a mean in term and between terms', () => {
    expect(historyLine({
      metric: 'guests',
      cells: [
        { state: 'in_session', weekday: 'Fri', days: 30, mean: 240 },
        { state: 'in_session', weekday: 'Sat', days: 18, mean: 250 },
        { state: 'between_terms', weekday: 'Sat', days: 6, mean: 140 },
        { state: 'between_terms', weekday: 'Fri', days: 2, mean: null },
      ],
      first: '2025-01-03', last: '2026-10-31',
    })).toBe('Your Saturdays averaged 250 guests in term and 140 between terms (18 and 6 Saturdays).');
  });

  test('speaks in whole dollars for net sales, and is null without both term states', () => {
    expect(historyLine({
      metric: 'netSales',
      cells: [{ state: 'in_session', weekday: 'Sat', days: 3, mean: 5000 }, { state: 'between_terms', weekday: 'Sat', days: 3, mean: 3200 }],
      first: '2026-01-03', last: '2026-10-31',
    })).toBe('Your Saturdays averaged $5,000 in net sales in term and $3,200 between terms (3 and 3 Saturdays).');
    expect(historyLine({ metric: 'guests', cells: [{ state: 'in_session', weekday: 'Sat', days: 9, mean: 250 }], first: null, last: null })).toBeNull();
    expect(historyLine({ metric: 'guests', cells: [], first: null, last: null })).toBeNull();
  });
});

describe('sourceHosts', () => {
  test('gives each https host once, without www., and skips anything else', () => {
    expect(sourceHosts([
      ...NOVEMBER.sources, { url: 'https://registrar.dartmouth.edu/other' }, { url: 'http://plain.example.test/' }, { url: 'not a url' },
    ])).toEqual([
      { host: 'registrar.dartmouth.edu', url: 'https://registrar.dartmouth.edu/calendars/test' },
      { host: 'opm.gov', url: 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/' },
      { host: 'bls.gov', url: 'https://www.bls.gov/cew/additional-resources/open-data/' },
    ]);
  });
});
