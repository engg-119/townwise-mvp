import { addDays, formatMonth, monthRange, plusYears } from '../../../src/portal/locations/dates';
import { checkNote, draftOf, emptyDraft, NOTE_COPY, splitNotes, startRangeCopy, weekdaysLine, type NoteDraft } from '../../../src/portal/locations/noteRules';
import {
  cellOf, chartGeometry, chartRange, chartSummary, extremes, formatDollars, seriesOf,
} from '../../../src/portal/locations/sales';
import { coverageOf, daysOf, noteOf } from './fakes';

const TODAY = '2026-11-04';

function draft(patch: Partial<NoteDraft>): NoteDraft {
  return { ...emptyDraft(), startDate: '2026-12-24', ...patch };
}

describe('the note form checks the API’s rules (api/src/handlers/notes.ts readNoteContent)', () => {
  test('a closure for one day: the end defaults to the start, no weekdays, no guests, no details', () => {
    expect(checkNote(draft({}), TODAY)).toEqual({
      input: {
        kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-24', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
        startTime: null, endTime: null,
      },
    });
  });

  test('weekdays are unique and sorted, Sunday as 0; details are trimmed; guests may have commas', () => {
    const checked = checkNote(draft({
      kind: 'private_event', effect: 'more_guests', endDate: '2027-03-29', weekdays: [6, 1, 0, 1], expectedGuests: '1,200', detail: '  A dinner.  ',
    }), TODAY);
    expect(checked).toEqual({
      input: {
        kind: 'private_event', startDate: '2026-12-24', endDate: '2027-03-29', weekdays: [0, 1, 6], effect: 'more_guests', expectedGuests: 1200,
        detail: 'A dinner.', startTime: null, endTime: null,
      },
    });
  });

  test('the start date is required, a real date, and from 2010-01-01 to today plus two years', () => {
    expect(checkNote(draft({ startDate: '' }), TODAY)).toEqual({ messages: { startDate: NOTE_COPY.start } });
    expect(checkNote(draft({ startDate: '2026-02-30' }), TODAY)).toEqual({ messages: { startDate: NOTE_COPY.date } });
    expect(checkNote(draft({ startDate: '12/24/2026' }), TODAY)).toEqual({ messages: { startDate: NOTE_COPY.date } });
    expect(checkNote(draft({ startDate: '2009-12-31' }), TODAY)).toEqual({ messages: { startDate: startRangeCopy(TODAY) } });
    expect(startRangeCopy(TODAY)).toBe('Pick a start date from Jan 1, 2010 to Nov 4, 2028.');
    expect('input' in checkNote(draft({ startDate: '2028-11-04' }), TODAY)).toBe(true);
    expect(checkNote(draft({ startDate: '2028-11-05' }), TODAY)).toEqual({ messages: { startDate: startRangeCopy(TODAY) } });
    expect('input' in checkNote(draft({ startDate: '2010-01-01' }), TODAY)).toBe(true);
  });

  test('the end is on or after the start and at most 366 days later', () => {
    expect(checkNote(draft({ endDate: '2026-12-23' }), TODAY)).toEqual({ messages: { endDate: 'The end date is before the start date.' } });
    expect('input' in checkNote(draft({ endDate: addDays('2026-12-24', 366) }), TODAY)).toBe(true);
    expect(checkNote(draft({ endDate: addDays('2026-12-24', 367) }), TODAY)).toEqual({ messages: { endDate: 'Pick a range of a year or less.' } });
    expect(checkNote(draft({ endDate: '2026-13-01' }), TODAY)).toEqual({ messages: { endDate: NOTE_COPY.date } });
    // An empty end is the start, so a bad start gives one message, not two.
    expect(checkNote(draft({ startDate: 'soon' }), TODAY)).toEqual({ messages: { startDate: NOTE_COPY.date } });
  });

  test('expected guests: a whole number from 1 to 20,000, ignored when the effect is Closed', () => {
    const guests = (expectedGuests: string, effect: NoteDraft['effect'] = 'more_guests') => checkNote(draft({ effect, expectedGuests }), TODAY);
    for (const bad of ['0', '20001', '12.5', '-3', 'many']) {
      expect(guests(bad)).toEqual({ messages: { expectedGuests: 'Enter a whole number from 1 to 20,000.' } });
    }
    expect(guests('20,000')).toMatchObject({ input: { expectedGuests: 20000 } });
    expect(guests('')).toMatchObject({ input: { expectedGuests: null } });
    expect(guests('many', 'closed')).toMatchObject({ input: { expectedGuests: null, effect: 'closed' } });
  });

  test('details: required for Other, at most 280 characters', () => {
    expect(checkNote(draft({ kind: 'other', effect: 'unknown', detail: '   ' }), TODAY)).toEqual({ messages: { detail: 'Add details for an Other note.' } });
    expect(checkNote(draft({ detail: 'x'.repeat(281) }), TODAY)).toEqual({ messages: { detail: NOTE_COPY.detailLong } });
    expect('input' in checkNote(draft({ detail: 'x'.repeat(280) }), TODAY)).toBe(true);
  });

  test('several messages at once', () => {
    expect(checkNote(draft({ startDate: '', kind: 'other', effect: 'fewer_guests', expectedGuests: '0', detail: '' }), TODAY)).toEqual({
      messages: { startDate: NOTE_COPY.start, expectedGuests: NOTE_COPY.guests, detail: 'Add details for an Other note.' },
    });
  });

  test('an existing note reads back into the form, and the form gives the same note', () => {
    const note = noteOf('n1', { kind: 'private_event', startDate: '2027-03-01', endDate: '2027-03-29', weekdays: [1], effect: 'more_guests', expectedGuests: 40, detail: 'A dinner.' });
    const checked = checkNote(draftOf(note), TODAY);
    expect(checked).toEqual({ input: { kind: 'private_event', startDate: '2027-03-01', endDate: '2027-03-29', weekdays: [1], effect: 'more_guests', expectedGuests: 40, detail: 'A dinner.', startTime: null, endTime: null } });
    expect(draftOf(noteOf('n2')).endDate).toBe('');
  });
});

describe('notes in words', () => {
  test('weekdays read Monday first, in plain words', () => {
    expect(weekdaysLine([1])).toBe('Mondays only');
    expect(weekdaysLine([0, 6])).toBe('Saturdays and Sundays only');
    expect(weekdaysLine([5, 1, 3])).toBe('Mondays, Wednesdays and Fridays only');
    expect(weekdaysLine(null)).toBeNull();
    expect(weekdaysLine([0, 1, 2, 3, 4, 5, 6])).toBeNull();
  });

  test('coming up ends today or later; past ended before today', () => {
    const notes = [noteOf('a', { startDate: '2026-10-01', endDate: '2026-11-03' }), noteOf('b', { startDate: '2026-11-01', endDate: TODAY }), noteOf('c', { startDate: '2026-12-01', endDate: '2026-12-02' })];
    const { comingUp, past } = splitNotes(notes, TODAY);
    expect(comingUp.map((note) => note.id)).toEqual(['b', 'c']);
    expect(past.map((note) => note.id)).toEqual(['a']);
  });
});

describe('sales numbers', () => {
  test('money prints in whole dollars, rounded half up, with commas', () => {
    expect(formatDollars(0)).toBe('$0');
    expect(formatDollars(49)).toBe('$0');
    expect(formatDollars(50)).toBe('$1');
    expect(formatDollars(123_456_749)).toBe('$1,234,567');
    expect(formatDollars(123_456_750)).toBe('$1,234,568');
    expect(cellOf(null, true)).toBe('No data');
    expect(cellOf(1204, false)).toBe('1,204');
  });

  test('the chart covers the last 365 days of data, ending at the last day', () => {
    const days = daysOf('2025-01-01', 400, () => ({ guests: 10, netSalesCents: 100 }));
    expect(chartRange(coverageOf(days))).toEqual({ from: addDays('2026-02-04', -364), to: '2026-02-04' });
    const short = daysOf('2026-01-01', 30, () => ({ guests: 10, netSalesCents: 100 }));
    expect(chartRange(coverageOf(short))).toEqual({ from: '2026-01-01', to: '2026-01-30' });
    expect(chartRange(coverageOf([]))).toBeNull();
  });

  test('the summary names the highest and the lowest day with data, the earliest on a tie', () => {
    const days = [
      { date: '2026-01-01', guests: 80, netSalesCents: 100_000 },
      { date: '2026-01-02', guests: null, netSalesCents: 50_000 },
      { date: '2026-01-03', guests: 115, netSalesCents: 200_049 },
      { date: '2026-01-05', guests: 115, netSalesCents: 10 },
      { date: '2026-01-06', guests: 80, netSalesCents: null },
    ];
    expect(seriesOf(days)).toBe('guests');
    expect(extremes(days, 'guests')).toEqual({ highest: { date: '2026-01-03', value: 115 }, lowest: { date: '2026-01-01', value: 80 } });
    expect(chartSummary(days, 'guests')).toBe('Daily guests, Jan 1, 2026 to Jan 6, 2026. Highest: 115 guests on Jan 3, 2026. Lowest day with data: 80 guests on Jan 1, 2026.');
    expect(chartSummary(days, 'netSales')).toBe('Daily net sales, Jan 1, 2026 to Jan 6, 2026. Highest: $2,000 on Jan 3, 2026. Lowest day with data: $0 on Jan 5, 2026.');
    const noGuests = days.map((day) => ({ ...day, guests: null }));
    expect(seriesOf(noGuests)).toBe('netSales');
  });

  test('the line breaks at a day with no value or no row, and a lone day is a dot; no point is invented', () => {
    const days = [
      { date: '2026-01-01', guests: 10, netSalesCents: null },
      { date: '2026-01-02', guests: 20, netSalesCents: null },
      { date: '2026-01-03', guests: null, netSalesCents: 5 },
      { date: '2026-01-04', guests: 30, netSalesCents: null },
      { date: '2026-01-06', guests: 20, netSalesCents: null },
      { date: '2026-01-07', guests: 10, netSalesCents: null },
    ];
    const geometry = chartGeometry(days, 'guests', 100);
    expect(geometry).toEqual({
      path: 'M0 100 L50 50 M250 50 L300 100',
      dots: [{ x: 150, y: 0 }],
      min: 10,
      max: 30,
      ticks: ['Jan 2026', 'Jan 2026', 'Jan 2026'],
    });
    expect(chartGeometry([], 'guests', 100)).toBeNull();
  });
});

describe('months', () => {
  test('a month prints with its year, and its range covers every day', () => {
    expect(formatMonth('2026-02')).toBe('Feb 2026');
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(plusYears('2024-02-29', 2)).toBe('2026-03-01');
  });
});
