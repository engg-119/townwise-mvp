import type { PeopleInTown } from '../../../src/portal/estimates/api';
import { inTownReading, jobsWords, nowLine, runWhen, runWords } from '../../../src/portal/home/InTown';
import { NOVEMBER, period } from '../estimates/fakes';

// Who's in town on Home (spec P11, 13.2), read the way an owner glances at it: the term today in plain words, then
// what changes later this week and later in the month, one row per run of days, past days left out; sources once,
// and only those the block uses; the county's jobs said as more or fewer in words. Synthetic data only.

const rows = (runs: ReturnType<typeof inTownReading>['later'], window: PeopleInTown = NOVEMBER): string[][] =>
  runs.map((run) => [runWhen(run, window), runWords(run)]);

test('on Thu, Nov 5: classes now, then the rest of the month in date order, with the registrar as the one source', () => {
  const reading = inTownReading(NOVEMBER, '2026-11-05');
  if (reading.now === null) throw new Error('no run today');
  expect(nowLine(reading.now, NOVEMBER)).toBe('Fall term classes until Tue, Nov 17.');
  expect(reading.thisWeek).toEqual([]);
  expect(rows(reading.later)).toEqual([
    ['Nov 18 to 19', 'Townwise has no term dates'],
    ['Nov 20 to 25', 'Fall term finals'],
    ['From Nov 26', 'Townwise has no term dates'],
  ]);
  expect(reading.termed).toBe(true);
  expect(reading.counted).toBe(false);
  // The holiday's source (OPM) belongs to the calendar block, not this one.
  expect(reading.sources).toEqual([{ label: 'Dartmouth Registrar', url: 'https://registrar.dartmouth.edu/calendars/test' }]);
});

test('on Mon, Nov 16: what starts by Sunday is this week, the rest is later', () => {
  const reading = inTownReading(NOVEMBER, '2026-11-16');
  expect(reading.now?.to).toBe('2026-11-17');
  expect(rows(reading.thisWeek)).toEqual([['Nov 18 to 19', 'Townwise has no term dates'], ['Nov 20 to 25', 'Fall term finals']]);
  expect(rows(reading.later)).toEqual([['From Nov 26', 'Townwise has no term dates']]);
});

test('past days are left out, and a run that reaches the end of the read says the rest of the month', () => {
  const reading = inTownReading(NOVEMBER, '2026-11-27');
  if (reading.now === null) throw new Error('no run today');
  expect(nowLine(reading.now, NOVEMBER)).toBe('Townwise has no term dates for the rest of November.');
  expect(reading.thisWeek).toEqual([]);
  expect(reading.later).toEqual([]);
  expect(reading.sources).toEqual([]);
});

test('between terms reads as words, and a headcount brings its own sources after the term’s', () => {
  const range = { low: 9500, high: 10_500, sourceIds: ['census-test'], excludes: [] };
  const window: PeopleInTown = {
    ...NOVEMBER,
    periods: [
      period({ from: '2026-11-01', fromWeekday: 'Sun', to: '2026-11-21', toWeekday: 'Sat', headcount: range, headcountWhy: null }),
      period({ from: '2026-11-22', fromWeekday: 'Sun', to: '2026-11-30', toWeekday: 'Mon', termState: 'between_terms', termLabel: null }),
    ],
    sources: [...NOVEMBER.sources, { id: 'census-test', label: 'Synthetic census', url: 'https://census.example.test/p1', confidence: 'high' }],
  };
  const reading = inTownReading(window, '2026-11-05');
  expect(reading.now?.headcount).toEqual({ low: 9500, high: 10_500 });
  expect(reading.counted).toBe(true);
  expect(rows(reading.later, window)).toEqual([['From Nov 22', 'Between terms']]);
  expect(reading.sources.map((source) => source.label)).toEqual(['Dartmouth Registrar', 'Synthetic census']);
});

test('a town with no term dates at all has no term to read', () => {
  const window: PeopleInTown = {
    ...NOVEMBER,
    town: { name: 'Stowe', state: 'VT', kind: 'seasonal' },
    periods: [period({ from: '2026-11-01', fromWeekday: 'Sun', to: '2026-11-30', toWeekday: 'Mon', termState: 'unknown', termLabel: null, termSourceIds: [], headcountWhy: 'visitors_unknown' })],
  };
  expect(inTownReading(window, '2026-11-05').termed).toBe(false);
});

test('county jobs say more or fewer in words, against the year’s average month', () => {
  expect(jobsWords(97.43, 'November').join('')).toBe('2.6% fewer jobs in November 2024 than in an average month that year.');
  expect(jobsWords(104.24, 'June').join('')).toBe('4.2% more jobs in June 2024 than in an average month that year.');
  expect(jobsWords(100.04, 'October').join('')).toBe('About as many jobs in October 2024 as in an average month that year.');
  // The figure is the part printed large.
  expect(jobsWords(97.43, 'November')[0]).toBe('2.6% fewer');
});
