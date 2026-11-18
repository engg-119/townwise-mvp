import {
  buildGrid, buildWeek, cardWords, cellSize, entryLines, GRID_DAYS, gridDays, gridHeight, gridMonthFor, gridMove, gridRange, headLine, inGrid, pastRangeFor,
  readRangeFor, shownFor, stepWeek, weekDays, weekLabel, weekRange, weekStartFor, type DayCell, type GridSlot, type WeekCard, type WeekDay, type WeekSlot,
} from '../../../src/portal/calendar/grid';
import {
  ALL_FILTERS, calendarMonth, dayCell, dayView, monthBounds, stepMonth, tooltipLines, type CalendarInput, type ImportedEvent,
} from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { addDays, daysBetween } from '../../../src/portal/locations/dates';
import type { RuleSchedule } from '../../../src/portal/rules/api';
import { holiday, note, townEvent } from '../analytics/fakes';
import { ruleOf } from '../rules/fakes';
import { forecastDay, forecastOf, NO_FORECAST } from './fakes';

function windowOf(days: Parameters<typeof forecastOf>[0]): ForecastWindow {
  return forecastOf(days) as ForecastWindow;
}

// The Calendar's grid (P28, spec 16.3): always 42 days in 6 weeks from the Monday on or before the month's 1st, the
// month the page keeps showing, the one read range per grid, the cell sizes and the keys. Every date is a calendar
// date, moved in UTC, so a daylight saving change never shifts a day. Today is Wed, Nov 11, 2026 unless a test says.

const TODAY = '2026-11-11';

/** 0 for Monday to 6 for Sunday, from the date alone. */
function weekday(date: string): number {
  return (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

test('gridDays gives 42 contiguous dates with a Monday at the start of every row', () => {
  for (const month of ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-08']) {
    const days = gridDays(month);
    expect(days).toHaveLength(GRID_DAYS);
    days.forEach((date, index) => {
      if (index > 0) expect(date).toBe(addDays(days[index - 1] ?? '', 1));
      if (index % 7 === 0) expect(weekday(date)).toBe(0);
    });
    // The 1st is always in the first row.
    expect(days.indexOf(`${month}-01`)).toBeLessThan(7);
  }
});

test('each month starts on the Monday on or before its 1st', () => {
  const ends = (month: string): [string | undefined, string | undefined] => [gridDays(month)[0], gridDays(month)[41]];
  expect(ends('2026-11')).toEqual(['2026-10-26', '2026-12-06']);
  expect(ends('2026-12')).toEqual(['2026-11-30', '2027-01-10']);
  expect(ends('2027-01')).toEqual(['2026-12-28', '2027-02-07']);
  // Starts on a Monday and has 28 days: no leading day and 14 trailing days.
  expect(ends('2027-02')).toEqual(['2027-02-01', '2027-03-14']);
  expect(gridDays('2027-02').filter((date) => !date.startsWith('2027-02'))).toHaveLength(14);
  expect(ends('2027-08')).toEqual(['2027-07-26', '2027-09-05']);
});

test('the months that hold a daylight saving change are 42 consecutive dates too', () => {
  // Nov 1, 2026 ends daylight saving time in the US; Mar 14, 2027 starts it.
  for (const month of ['2026-11', '2027-03']) {
    const days = gridDays(month);
    expect(new Set(days).size).toBe(42);
    expect(days[41]).toBe(addDays(days[0] ?? '', 41));
  }
  expect(gridDays('2027-03')).toContain('2027-03-14');
});

test('inGrid holds both ends of the grid and nothing past them', () => {
  expect(inGrid('2026-11', '2026-10-26')).toBe(true);
  expect(inGrid('2026-11', '2026-12-06')).toBe(true);
  expect(inGrid('2026-11', '2026-10-25')).toBe(false);
  expect(inGrid('2026-11', '2026-12-07')).toBe(false);
});

test('gridMonthFor keeps the shown month while the selected day is in its grid', () => {
  expect(gridMonthFor('2026-12-03', '2026-11')).toBe('2026-11');
  expect(gridMonthFor('2026-12-07', '2026-11')).toBe('2026-12');
  expect(gridMonthFor('2026-10-25', '2026-11')).toBe('2026-10');
  expect(gridMonthFor('2027-01-04', '2026-12')).toBe('2026-12');
  expect(gridMonthFor('2027-01-11', '2026-12')).toBe('2027-01');
});

test('shownFor writes the grid month back only when ?day= changed, so a split render does not undo Next', () => {
  // Next from November with Nov 11 selected: one render sees December set with the old day, and keeps it.
  expect(shownFor('2026-12', '2026-11-11', '2026-11-11')).toBe('2026-12');
  // The next render sees Dec 1, which is in November's grid too, and still shows December.
  expect(shownFor('2026-12', '2026-11-11', '2026-12-01')).toBe('2026-12');
  // A write-back on every render would have ended on November with Dec 1 selected.
  const unguarded = gridMonthFor('2026-12-01', gridMonthFor('2026-11-11', '2026-12'));
  expect(unguarded).toBe('2026-11');
  // A day that leaves the grid moves it.
  expect(shownFor('2026-11', '2026-11-30', '2026-12-07')).toBe('2026-12');
});

test('a split render shows the grid it showed last, never a third month, until the new ?day= arrives', () => {
  // PageDown from a leading Oct 28 in November's grid: December is set while ?day= is still Oct 28, which December's
  // grid (Nov 30 to Jan 10) doesn't hold. The day's own month would show October once.
  const split = shownFor('2026-12', '2026-10-28', '2026-10-28');
  expect(gridMonthFor('2026-10-28', split)).toBe('2026-10');
  expect(gridMonthFor('2026-10-28', split, '2026-11')).toBe('2026-11');
  // Then Dec 28 arrives and December shows.
  const next = shownFor(split, '2026-10-28', '2026-12-28');
  expect(next).toBe('2026-12');
  expect(gridMonthFor('2026-12-28', next, '2026-11')).toBe('2026-12');
  // Previous from a trailing Dec 3 in November's grid: October's grid ends Nov 8, so the split render shows November.
  expect(gridMonthFor('2026-12-03', shownFor('2026-10', '2026-12-03', '2026-12-03'), '2026-11')).toBe('2026-11');
  // A kept month whose grid holds the day wins over the fallback.
  expect(gridMonthFor('2026-12-01', '2026-12', '2026-11')).toBe('2026-12');
});

test('gridRange is the 42 days clamped to the 25 months the page shows', () => {
  const bounds = monthBounds(TODAY);
  expect(gridRange('2026-11', bounds)).toEqual({ from: '2026-10-26', to: '2026-12-06' });
  expect(gridRange('2025-11', bounds)).toEqual({ from: '2025-11-01', to: '2025-12-07' });
  expect(gridRange('2027-11', bounds)).toEqual({ from: '2027-11-01', to: '2027-11-30' });
});

test('every grid read stays within 396 days of today, for every today from 2026 to 2029', () => {
  let unclamped = 0;
  for (let today = '2026-01-01'; today <= '2029-12-31'; today = addDays(today, 1)) {
    const bounds = monthBounds(today);
    for (let month = bounds.first; month <= bounds.last; month = stepMonth(month, 1)) {
      const range = gridRange(month, bounds);
      expect(daysBetween(range.from, range.to) + 1).toBeLessThanOrEqual(42);
      expect(daysBetween(range.from, today)).toBeLessThanOrEqual(396);
      expect(daysBetween(today, range.to)).toBeLessThanOrEqual(396);
      const days = gridDays(month);
      unclamped = Math.max(unclamped, daysBetween(days[0] ?? today, today), daysBetween(today, days[41] ?? today));
    }
  }
  // Without the clamp an edge grid would ask past the API's 400 days.
  expect(unclamped).toBeGreaterThan(400);
});

test('pastRangeFor reads the range’s past days and the 8 weeks before it, or nothing', () => {
  const bounds = monthBounds(TODAY);
  expect(pastRangeFor(gridRange('2026-11', bounds), TODAY)).toEqual({ from: '2026-08-31', to: '2026-11-10' });
  // October's grid is Sep 28 to Nov 8, all before today.
  expect(gridRange('2026-10', bounds)).toEqual({ from: '2026-09-28', to: '2026-11-08' });
  expect(pastRangeFor(gridRange('2026-10', bounds), TODAY)).toEqual({ from: '2026-08-03', to: '2026-11-08' });
  expect(pastRangeFor(gridRange('2026-12', bounds), TODAY)).toBeNull();
  // A range whose first day is today has no past day.
  expect(pastRangeFor({ from: TODAY, to: '2026-12-20' }, TODAY)).toBeNull();
  // At most 42 + 56 days, under the sales route's 366.
  const widest = pastRangeFor(gridRange('2026-10', bounds), TODAY);
  expect(widest === null ? 0 : daysBetween(widest.from, widest.to) + 1).toBeLessThanOrEqual(98);
});

/** The model's reads with nothing in them but `fields`. */
function reads(fields: Partial<CalendarInput> = {}): CalendarInput {
  return { today: TODAY, covered: gridRange('2026-11', monthBounds(TODAY)), forecast: null, salesDays: [], events: [], notes: [], imported: [], filters: ALL_FILTERS, ...fields };
}

test('entryLines shows every entry up to three, else the first two and “+N more”', () => {
  const titles = ['Craft fair', 'Tree lighting', 'Choir concert', 'Book sale'];
  const day = (count: number) => dayCell('2026-11-21', reads({ events: titles.slice(0, count).map((title) => townEvent({ start: '2026-11-21', title })) }));
  expect(entryLines(day(0))).toEqual({ lines: [], more: null });
  expect(entryLines(day(1))).toEqual({ lines: ['Craft fair'], more: null });
  expect(entryLines(day(3))).toEqual({ lines: ['Craft fair', 'Tree lighting', 'Choir concert'], more: null });
  expect(entryLines(day(4))).toEqual({ lines: ['Craft fair', 'Tree lighting'], more: '+2 more' });
});

test('cell heights depend on the width alone, so the grid is the same height every month', () => {
  const widths = [1280, 1024, 1023, 800, 641, 640, 375];
  expect(widths.map((width) => cellSize(width).height)).toEqual([104, 104, 64, 64, 64, 52, 52]);
  expect(widths.map((width) => cellSize(width).figure)).toEqual([22, 22, 18, 18, 18, 15, 15]);
  expect(widths.map((width) => cellSize(width).lines)).toEqual([3, 3, 0, 0, 0, 0, 0]);
  // A 16px weekday row, 6 rows and six 3px gaps.
  expect([1280, 800, 375].map(gridHeight)).toEqual([658, 418, 346]);
});

function slotOf(rows: readonly (readonly GridSlot[])[], date: string): GridSlot {
  const slot = rows.flat().find((each) => each.date === date);
  if (slot === undefined) throw new Error(`no slot for ${date}`);
  return slot;
}

function dayOf(rows: readonly (readonly GridSlot[])[], date: string): DayCell {
  const slot = slotOf(rows, date);
  if (slot.kind !== 'day') throw new Error(`${date} is ${slot.kind}`);
  return slot;
}

test('buildGrid: 6 rows of 7, the month’s own days as calendarMonth builds them, and the days either side outside', () => {
  const party = note({ startDate: '2026-11-21', expectedGuests: 70 });
  const input = reads({
    events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' }), townEvent({ start: '2026-12-03', title: 'Tree lighting' })],
    notes: [party],
    forecast: windowOf([forecastDay({ date: '2026-11-21' }), forecastDay({ date: '2026-12-02', mid: 198 })]),
    salesDays: [{ date: '2026-10-31', guests: 140, netSalesCents: 280_000 }],
  });
  const rows = buildGrid('2026-11', input, monthBounds(TODAY));
  expect(rows).toHaveLength(6);
  expect(rows.every((row) => row.length === 7)).toBe(true);
  expect(rows.flat().map((slot) => slot.date)).toEqual(gridDays('2026-11'));
  for (const cell of calendarMonth('2026-11', input).flat()) {
    if (cell !== null) expect(slotOf(rows, cell.date)).toEqual({ ...cell, kind: 'day', outside: false, pending: false });
  }
  const outside = rows.flat().filter((slot) => slot.kind === 'day' && slot.outside).map((slot) => slot.date);
  expect(outside).toEqual([...gridDays('2026-11').slice(0, 6), ...gridDays('2026-11').slice(36)]);
  expect(outside[0]).toBe('2026-10-26');
  expect(outside.at(-1)).toBe('2026-12-06');
  // A trailing day shows its own data from the same reads, and a leading day its stored guests.
  expect(dayOf(rows, '2026-12-03')).toMatchObject({ chips: ['Tree lighting'], outside: true, pending: false });
  expect(dayOf(rows, '2026-12-02')).toMatchObject({ figure: { value: 198, kind: 'forecast' }, outside: true });
  expect(dayOf(rows, '2026-10-31')).toMatchObject({ figure: { value: 140, kind: 'actual' }, outside: true });
  expect(dayOf(rows, '2026-12-03').label).toBe('Thu, Dec 3, 2026. No forecast. Tree lighting.');
});

test('days outside the 25 months are inert, with the number only and a label that says so', () => {
  const bounds = monthBounds(TODAY);
  const last = buildGrid('2027-11', reads({ covered: gridRange('2027-11', bounds) }), bounds);
  const inertLast = last.flat().filter((slot) => slot.kind === 'inert').map((slot) => slot.date);
  expect(inertLast).toEqual(gridDays('2027-11').filter((date) => date >= '2027-12-01'));
  expect(inertLast).toHaveLength(12);
  expect(slotOf(last, '2027-12-05')).toEqual({ kind: 'inert', date: '2027-12-05', label: 'Sun, Dec 5, 2027. Outside the months the calendar shows.' });
  expect(slotOf(last, '2027-11-30').kind).toBe('day');
  const first = buildGrid('2025-11', reads({ covered: gridRange('2025-11', bounds) }), bounds);
  expect(first.flat().filter((slot) => slot.kind === 'inert').map((slot) => slot.date)).toEqual(['2025-10-27', '2025-10-28', '2025-10-29', '2025-10-30', '2025-10-31']);
});

test('a grid whose reads are still for the month before shows the days they cover and the rest pending', () => {
  const input = reads({ events: [townEvent({ start: '2026-12-03', title: 'Tree lighting' }), townEvent({ start: '2026-12-12', title: 'Craft fair' })] });
  const rows = buildGrid('2026-12', input, monthBounds(TODAY));
  // November's reads cover Oct 26 to Dec 6.
  for (const date of gridDays('2026-12')) {
    expect(dayOf(rows, date).pending).toBe(date >= '2026-12-07');
  }
  expect(dayOf(rows, '2026-11-30')).toMatchObject({ outside: true, pending: false });
  expect(dayOf(rows, '2026-12-03')).toMatchObject({ chips: ['Tree lighting'], pending: false, outside: false });
  expect(dayOf(rows, '2026-12-12')).toMatchObject({
    pending: true, outside: false, chips: [], more: 0, figure: null, status: null, label: 'Sat, Dec 12, 2026. Loading.',
    marks: { event: false, note: false, imported: false },
  });
});

test('today keeps its own cell in a leading or trailing row', () => {
  const today = '2026-11-03';
  const rows = buildGrid('2026-10', reads({ today, covered: gridRange('2026-10', monthBounds(today)) }), monthBounds(today));
  expect(gridDays('2026-10')[0]).toBe('2026-09-28');
  expect(gridDays('2026-10')[41]).toBe('2026-11-08');
  expect(dayOf(rows, today)).toMatchObject({ isToday: true, outside: true, inWeek: true });
});

describe('gridMove in the month grid', () => {
  const bounds = monthBounds(TODAY);
  const move = (from: string, key: string, month = from.slice(0, 7), ctrl = false, at = bounds) => gridMove(from, key, ctrl, { layout: 'month', month, bounds: at });

  test('the arrows move a day or a week, across rows, weeks and months', () => {
    expect(move('2026-11-18', 'ArrowLeft')).toEqual({ date: '2026-11-17', month: null });
    expect(move('2026-11-15', 'ArrowRight')).toEqual({ date: '2026-11-16', month: null });
    expect(move('2026-12-06', 'ArrowRight', '2026-11')).toEqual({ date: '2026-12-07', month: null });
    expect(move('2026-11-01', 'ArrowLeft')).toEqual({ date: '2026-10-31', month: null });
    expect(move('2026-11-18', 'ArrowUp')).toEqual({ date: '2026-11-11', month: null });
    expect(move('2026-11-30', 'ArrowDown')).toEqual({ date: '2026-12-07', month: null });
  });

  test('Home and End go to the row’s Monday and Sunday; with Ctrl or Cmd, to the grid month’s first and last day', () => {
    expect(move('2026-11-18', 'Home')).toEqual({ date: '2026-11-16', month: null });
    expect(move('2026-11-18', 'End')).toEqual({ date: '2026-11-22', month: null });
    // The row's ends may be in the months either side.
    expect(move('2026-11-01', 'Home')).toEqual({ date: '2026-10-26', month: null });
    expect(move('2026-11-18', 'Home', '2026-11', true)).toEqual({ date: '2026-11-01', month: null });
    expect(move('2026-11-18', 'End', '2026-11', true)).toEqual({ date: '2026-11-30', month: null });
    // From a trailing day, the grid's month, not the day's own.
    expect(move('2026-12-03', 'Home', '2026-11', true)).toEqual({ date: '2026-11-01', month: null });
  });

  test('PageUp and PageDown change month from the grid’s, on the same day number clamped to the month’s length', () => {
    expect(move('2026-11-03', 'PageDown')).toEqual({ date: '2026-12-03', month: '2026-12' });
    expect(move('2027-01-31', 'PageDown')).toEqual({ date: '2027-02-28', month: '2027-02' });
    expect(move('2026-12-31', 'PageDown')).toEqual({ date: '2027-01-31', month: '2027-01' });
    expect(move('2028-01-31', 'PageDown', '2028-01', false, monthBounds('2027-06-15'))).toEqual({ date: '2028-02-29', month: '2028-02' });
    expect(move('2026-11-30', 'PageUp')).toEqual({ date: '2026-10-30', month: '2026-10' });
    // From a leading or trailing day the grid's month decides.
    expect(move('2026-10-28', 'PageUp', '2026-11')).toEqual({ date: '2026-10-28', month: '2026-10' });
    expect(move('2026-10-28', 'PageDown', '2026-11')).toEqual({ date: '2026-12-28', month: '2026-12' });
    expect(move('2026-12-06', 'PageDown', '2026-11')).toEqual({ date: '2026-12-06', month: '2026-12' });
  });

  test('a key past the 25 months is consumed; Home and End clamp to them', () => {
    expect(move('2027-11-30', 'ArrowRight')).toEqual({ date: '2027-11-30', month: null });
    expect(move('2027-11-28', 'ArrowDown')).toEqual({ date: '2027-11-28', month: null });
    expect(move('2025-11-01', 'ArrowLeft')).toEqual({ date: '2025-11-01', month: null });
    expect(move('2027-11-15', 'PageDown')).toEqual({ date: '2027-11-15', month: null });
    expect(move('2025-11-15', 'PageUp')).toEqual({ date: '2025-11-15', month: null });
    // Mon, Nov 29, 2027: its row's Sunday is Dec 5, past the last day.
    expect(move('2027-11-29', 'End')).toEqual({ date: '2027-11-30', month: null });
    // Sun, Nov 2, 2025: its row starts Oct 27.
    expect(move('2025-11-02', 'Home')).toEqual({ date: '2025-11-01', month: null });
  });

  test('a key it doesn’t handle gives null', () => {
    expect(move('2026-11-18', 'Enter')).toBeNull();
    expect(move('2026-11-18', 'a')).toBeNull();
    expect(move('2026-11-18', 'Tab')).toBeNull();
  });
});

describe('the week view’s 7-day blocks, counted from today', () => {
  test('weekStartFor: today starts its own block, and every day is in the block of the whole weeks from today, rounded down', () => {
    expect(weekStartFor(TODAY, TODAY)).toBe(TODAY);
    // A day later in the same block, and the next block's first day.
    expect(weekStartFor('2026-11-17', TODAY)).toBe(TODAY);
    expect(weekStartFor('2026-11-18', TODAY)).toBe('2026-11-18');
    expect(weekStartFor('2026-11-21', TODAY)).toBe('2026-11-18');
    // A day before today is in the block before, not today's.
    expect(weekStartFor('2026-11-10', TODAY)).toBe('2026-11-04');
    expect(weekStartFor('2026-11-04', TODAY)).toBe('2026-11-04');
    expect(weekStartFor('2026-10-28', TODAY)).toBe('2026-10-28');
    // Across a year, either way.
    expect(weekStartFor('2027-01-01', TODAY)).toBe('2026-12-30');
    expect(weekStartFor('2026-01-01', '2026-01-04')).toBe('2025-12-28');
    // Calendar dates only: Nov 1, 2026 ends daylight saving time in the US, and Mar 14, 2027 starts it.
    expect(weekStartFor('2026-11-05', '2026-10-29')).toBe('2026-11-05');
    expect(weekStartFor('2026-11-04', '2026-10-29')).toBe('2026-10-29');
    expect(weekStartFor('2027-03-17', '2027-03-10')).toBe('2027-03-17');
    expect(weekStartFor('2027-03-16', '2027-03-10')).toBe('2027-03-10');
  });

  test('weekDays is the block’s 7 days from its first, across a month and a year', () => {
    expect(weekDays('2026-11-15')).toEqual(['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
    expect(weekDays('2026-12-30')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']);
  });

  test('weekLabel names the block with its year once, or twice across a new year', () => {
    expect(weekLabel('2026-11-15')).toBe('Nov 15 to 21, 2026');
    expect(weekLabel('2026-11-29')).toBe('Nov 29 to Dec 5, 2026');
    expect(weekLabel('2026-12-27')).toBe('Dec 27, 2026 to Jan 2, 2027');
  });

  test('stepWeek moves the selected day a block, clamped to the 25 months, and null when that block lies wholly outside them', () => {
    const bounds = monthBounds(TODAY);
    expect(stepWeek('2026-11-18', 1, bounds, TODAY)).toBe('2026-11-25');
    expect(stepWeek('2026-11-18', -1, bounds, TODAY)).toBe('2026-11-11');
    // The last block, Nov 24 to 30, 2027, ends on the last day: the next one lies wholly past it.
    expect(stepWeek('2027-11-24', 1, bounds, TODAY)).toBeNull();
    expect(stepWeek('2027-11-30', 1, bounds, TODAY)).toBeNull();
    expect(stepWeek('2027-11-20', 1, bounds, TODAY)).toBe('2027-11-27');
    // The first block, Oct 29 to Nov 4, 2025, still holds Nov 1 to 4: a step into it clamps to Nov 1.
    expect(stepWeek('2025-11-05', -1, bounds, TODAY)).toBe('2025-11-01');
    expect(stepWeek('2025-11-08', -1, bounds, TODAY)).toBe('2025-11-01');
    expect(stepWeek('2025-11-01', -1, bounds, TODAY)).toBeNull();
    expect(stepWeek('2025-11-04', -1, bounds, TODAY)).toBeNull();
  });

  test('weekRange is the block clamped to the 25 months', () => {
    const bounds = monthBounds(TODAY);
    expect(weekRange('2026-11-18', bounds)).toEqual({ from: '2026-11-18', to: '2026-11-24' });
    expect(weekRange('2025-10-29', bounds)).toEqual({ from: '2025-11-01', to: '2025-11-04' });
    expect(weekRange('2027-11-28', bounds)).toEqual({ from: '2027-11-28', to: '2027-11-30' });
  });

  test('readRangeFor: the grid’s range in the month view, and in the week view while the clamped block lies inside it; else the block’s own days', () => {
    const bounds = monthBounds(TODAY);
    const november = { from: '2026-10-26', to: '2026-12-06' };
    expect(readRangeFor('month', '2026-11', '2026-12-06', bounds)).toEqual(november);
    // A block inside November's grid reads nothing of its own.
    expect(readRangeFor('week', '2026-11', '2026-11-15', bounds)).toEqual(november);
    expect(readRangeFor('week', '2026-11', '2026-11-29', bounds)).toEqual(november);
    // Dec 6 to 12 runs past it (today Nov 15, with Dec 6 selected in November's grid).
    expect(readRangeFor('week', '2026-11', '2026-12-06', monthBounds('2026-11-15'))).toEqual({ from: '2026-12-06', to: '2026-12-12' });
    // At the first end, Oct 29 to Nov 4, 2025 clamps to Nov 1 to 4, which November 2025's grid covers.
    expect(readRangeFor('week', '2025-11', '2025-10-29', bounds)).toEqual({ from: '2025-11-01', to: '2025-12-07' });
  });

  test('every week read stays within 7 days and 396 days of today, for every today from 2026 to 2029', () => {
    let longest = 0;
    let farthest = 0;
    for (let today = '2026-01-01'; today <= '2029-12-31'; today = addDays(today, 1)) {
      const bounds = monthBounds(today);
      for (let start = weekStartFor(`${bounds.first}-01`, today); start <= bounds.lastDay; start = addDays(start, 7)) {
        const range = weekRange(start, bounds);
        longest = Math.max(longest, daysBetween(range.from, range.to) + 1);
        farthest = Math.max(farthest, daysBetween(range.from, today), daysBetween(today, range.to));
      }
    }
    expect(longest).toBe(7);
    expect(farthest).toBeLessThanOrEqual(396);
  });
});

describe('buildWeek', () => {
  const bounds = monthBounds(TODAY);
  const SATURDAY = '2026-11-21';
  const imported = (fields: Partial<ImportedEvent> & Pick<ImportedEvent, 'title'>): ImportedEvent => ({
    calendarId: 'c1', uid: fields.title, startDate: SATURDAY, endDate: SATURDAY, startTime: null, endTime: null, ...fields,
  });
  const schedule = (fields: Partial<RuleSchedule> = {}): RuleSchedule => ({
    kind: 'closure', startDate: '2026-11-01', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null, ...fields,
  });
  const week = (input: CalendarInput, selected = SATURDAY, today = TODAY): WeekSlot[] => buildWeek(selected, today, input, bounds);
  const dayIn = (slots: readonly WeekSlot[], date: string): WeekDay => {
    const slot = slots.find((each) => each.date === date);
    if (slot?.kind !== 'day') throw new Error(`${date} is not a day`);
    return slot;
  };
  const cards = (input: CalendarInput, date = SATURDAY): WeekCard[] => dayIn(week(input), date).cards;

  test('the block from today that holds the selected day, each day as the month grid’s cell', () => {
    const input = reads({ events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })] });
    const slots = week(input);
    // Today is Wed, Nov 11: Saturday Nov 21 is in the block of Nov 18 to 24, across two of the grid's rows.
    expect(slots.map((slot) => slot.date)).toEqual(weekDays('2026-11-18'));
    const grid = buildGrid('2026-11', input, bounds).flat();
    slots.forEach((slot) => { expect(slot).toMatchObject(grid.find((each) => each.date === slot.date) ?? {}); });
    // With no day chosen the block starts on today.
    expect(week(input, TODAY).map((slot) => slot.date)).toEqual(weekDays(TODAY));
  });

  test('cards in the entries’ order (D49): notes by start, holidays, town events, imported by start, periods last', () => {
    const input = reads({
      events: [
        townEvent({ start: SATURDAY, title: 'Fall term', kind: 'term', end: '2026-11-24' }),
        townEvent({ start: SATURDAY, title: 'Dartmouth home football' }),
        holiday(SATURDAY, 'Made-up Day', 'us:madeup', 'Made-up Day'),
      ],
      notes: [
        note({ startDate: SATURDAY, expectedGuests: 70, startTime: '18:00', endTime: '21:00' }),
        note({ startDate: SATURDAY, kind: 'other' }),
      ],
      imported: [imported({ title: 'Wine delivery', startTime: '09:00', endTime: '10:00' })],
    });
    expect(cards(input).map((card) => [card.kind, card.hours, card.title, card.sub])).toEqual([
      ['note', null, 'Other', 'Your note'],
      ['note', '6 pm to 9 pm', 'Private event, 70', 'Your note'],
      ['holiday', null, 'Made-up Day', 'Federal holiday'],
      ['event', null, 'Dartmouth home football', 'Town event'],
      ['imported', '9 am to 10 am', 'Wine delivery', 'Your calendar'],
      ['term', null, 'Fall term', 'Term, Nov 21 to 24'],
    ]);
  });

  test('a title shows once across sources, but two events of one calendar keep two cards (D49)', () => {
    const input = reads({
      events: [holiday(SATURDAY, 'Veterans Day', 'us:veterans', 'Veterans Day')],
      notes: [note({ startDate: SATURDAY, title: 'Holiday party' })],
      imported: [
        imported({ title: 'Veterans day ', uid: 'v1' }),
        imported({ title: 'Private party', uid: 'p1', startTime: '12:00', endTime: '14:00' }),
        imported({ title: 'Private party', uid: 'p2', startTime: '18:00', endTime: '21:00' }),
      ],
    });
    expect(cards(input).map((card) => [card.title, card.hours])).toEqual([
      ['Holiday party', null], ['Veterans Day', null], ['Private party', 'noon to 2 pm'], ['Private party', '6 pm to 9 pm'],
    ]);
  });

  test('Term dates off removes the term and season cards; a rule shows with every filter off, with its schedule summary', () => {
    const rule = ruleOf('r1', 'Closed for the staff party', { schedule: schedule({ startDate: SATURDAY, endDate: SATURDAY }), scheduleSummary: 'Closed on Nov 21, 2026' });
    const input = reads({
      events: [townEvent({ start: SATURDAY, title: 'Fall term', kind: 'term' }), townEvent({ start: SATURDAY, title: 'Winter', kind: 'season' })],
      rules: [rule],
    });
    expect(cards(input).map((card) => [card.kind, card.sub])).toEqual([['rule', 'Closed on Nov 21, 2026'], ['term', 'Term'], ['season', 'Season']]);
    expect(cards({ ...input, filters: { ...ALL_FILTERS, terms: false } }).map((card) => card.kind)).toEqual(['rule']);
    const off = { holidays: false, events: false, terms: false, notes: false, imported: false };
    expect(cards({ ...input, filters: off })).toEqual([expect.objectContaining({ kind: 'rule', title: 'Closed for the staff party', hours: null })]);
  });

  test('a rule with no end date builds, and one with no summary reads “Your rule”; a timed rule has its hours', () => {
    const open = ruleOf('r2', 'Trivia night', { schedule: schedule({ kind: 'other', effect: 'more_guests', weekdays: [6], startTime: '19:00', endTime: '22:00' }), scheduleSummary: null });
    expect(cards(reads({ rules: [open] }))).toEqual([expect.objectContaining({ kind: 'rule', title: 'Trivia night', sub: 'Your rule', hours: '7 pm to 10 pm' })]);
  });

  test('a town event the day’s forecast names as a reason still gets a card', () => {
    const named = forecastDay({ date: SATURDAY, reasons: [{ kind: 'event', label: 'Dartmouth home football', effectPct: null, sources: [], note: null }] });
    const input = reads({ events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })], forecast: windowOf([named]) });
    // The panel leaves it out of On the calendar, since Why names it.
    expect(dayView(SATURDAY, input).events).toEqual([]);
    expect(cards(input).map((card) => card.title)).toEqual(['Dartmouth home football']);
  });

  test('multi-day items carry their span; a single day none', () => {
    const input = reads({
      events: [townEvent({ start: '2026-11-20', end: '2026-11-22', title: 'Winter carnival' })],
      notes: [note({ startDate: '2026-11-21', endDate: '2026-11-23', kind: 'other' })],
      imported: [imported({ title: 'Owner away', startDate: '2026-11-21', endDate: '2026-11-25' })],
    });
    expect(cards(input).map((card) => card.sub)).toEqual(['Your note, Nov 21 to 23', 'Town event, Nov 20 to 22', 'Your calendar, Nov 21 to 25']);
  });

  test('the head’s range equals the tooltip’s parenthesis, and “No forecast” only once the read answered without the day', () => {
    const input = reads({ forecast: windowOf([forecastDay({ date: SATURDAY, low: 180.4, mid: 212, high: 239.2 })]) });
    const saturday = dayIn(week(input), SATURDAY);
    expect(saturday.range).toBe('180 to 240');
    expect(tooltipLines(SATURDAY, input)?.lines[0]).toBe(`212 guests, forecast (likely ${saturday.range ?? ''})`);
    expect(headLine(saturday)).toBe('forecast, 180 to 240');
    expect(saturday.status).toBeNull();
    // The read answered, but not for Sunday: the status word says so, and the head's last line stays empty.
    const sunday = dayIn(week(input), '2026-11-22');
    expect(sunday).toMatchObject({ range: null, status: 'no_forecast' });
    expect(headLine(sunday)).toBeNull();
    // Loading or failed: nothing.
    expect(dayIn(week(reads()), '2026-11-22')).toMatchObject({ range: null, status: null });
    // No published forecast at all: every day from today on says so too (owner request, 2026-11-17: always something).
    expect(dayIn(week(reads({ forecast: NO_FORECAST as ForecastWindow })), '2026-11-22')).toMatchObject({ status: 'no_forecast' });
    // A past day has its guests, never a range.
    const past = reads({ salesDays: [{ date: '2026-11-10', guests: 138, netSalesCents: 276_000 }], forecast: windowOf([]) });
    const tuesday = dayIn(week(past, '2026-11-10'), '2026-11-10');
    expect(tuesday).toMatchObject({ range: null, status: null, figure: { value: 138, kind: 'actual' } });
    expect(headLine(tuesday)).toBeNull();
    // A past day with no stored guests shows the forecast made for it, captioned “forecast”.
    const missed = reads({ salesDays: [], forecast: windowOf([forecastDay({ date: '2026-11-10', low: 80, mid: 90.4, high: 110 })]) });
    const unstored = dayIn(week(missed, '2026-11-10'), '2026-11-10');
    expect(unstored).toMatchObject({ range: null, status: null, figure: { value: 90, kind: 'past_forecast' } });
    expect(headLine(unstored)).toBe('forecast');
  });

  test('across the outlook boundary (D52): an outlook day’s head says “Outlook” over its figure and keeps its range', () => {
    const input = reads({
      forecast: windowOf([
        forecastDay({ date: '2026-11-20', low: 180, mid: 212, high: 240 }),
        forecastDay({ date: SATURDAY, low: 150, mid: 212, high: 290, outlook: true }),
      ]),
    });
    const friday = dayIn(week(input), '2026-11-20');
    expect(friday).toMatchObject({ status: null, figure: { value: 212, kind: 'forecast' }, range: '180 to 240' });
    const saturday = dayIn(week(input), SATURDAY);
    expect(saturday).toMatchObject({ status: 'outlook', figure: { value: 212, kind: 'forecast' }, range: '150 to 290' });
    expect(headLine(saturday)).toBe('forecast, 150 to 290');
    expect(saturday.label).toContain('Outlook: 212 guests, forecast, likely 150 to 290.');
  });

  test('a block at the 25 months’ ends has inert days with no cards', () => {
    // Today Nov 11, 2026: the first block, Oct 29 to Nov 4, 2025, starts before the first month.
    const first = week(reads({ covered: gridRange('2025-11', bounds), events: [townEvent({ start: '2025-10-30', title: 'Harvest supper' })] }), '2025-11-01');
    expect(first.map((slot) => [slot.date, slot.kind])).toEqual([
      ['2025-10-29', 'inert'], ['2025-10-30', 'inert'], ['2025-10-31', 'inert'], ['2025-11-01', 'day'], ['2025-11-02', 'day'], ['2025-11-03', 'day'], ['2025-11-04', 'day'],
    ]);
    expect(first.find((slot) => slot.date === '2025-10-30')).toEqual({ kind: 'inert', date: '2025-10-30', label: 'Thu, Oct 30, 2025. Outside the months the calendar shows.' });
    // Its last block, Nov 24 to 30, 2027, ends on the last day.
    expect(week(reads({ covered: gridRange('2027-11', bounds) }), '2027-11-30').map((slot) => slot.kind)).toEqual(Array.from({ length: 7 }, () => 'day'));
    // Today Nov 15, 2026: the last block, Nov 28 to Dec 4, 2027, runs past it.
    const last = buildWeek('2027-11-30', '2026-11-15', reads({ today: '2026-11-15', covered: gridRange('2027-11', bounds) }), monthBounds('2026-11-15'));
    expect(last.map((slot) => [slot.date, slot.kind])).toEqual([
      ['2027-11-28', 'day'], ['2027-11-29', 'day'], ['2027-11-30', 'day'], ['2027-12-01', 'inert'], ['2027-12-02', 'inert'], ['2027-12-03', 'inert'], ['2027-12-04', 'inert'],
    ]);
  });

  test('cardWords: each card’s hours when timed, its title, then its kind words, as short sentences; null with no cards', () => {
    const input = reads({
      events: [townEvent({ start: SATURDAY, title: 'Fall term', kind: 'term', end: '2026-11-24' }), townEvent({ start: SATURDAY, title: 'Dartmouth home football' })],
      notes: [note({ startDate: SATURDAY, expectedGuests: 70, startTime: '18:00', endTime: '21:00' })],
      imported: [imported({ title: 'Open mic!', startTime: '09:00', endTime: '10:00' })],
    });
    expect(cardWords(cards(input))).toBe(
      '6 pm to 9 pm, Private event, 70. Your note. Dartmouth home football. Town event. 9 am to 10 am, Open mic! Your calendar. Fall term. Term, Nov 21 to 24.',
    );
    expect(cardWords(cards(reads()))).toBeNull();
    expect(cardWords([])).toBeNull();
  });

  test('days the kept reads don’t cover are pending, with no cards; the days they cover show theirs', () => {
    // November's reads cover Oct 26 to Dec 6; the block of Dec 2 to 8 runs past them.
    const input = reads({ events: [townEvent({ start: '2026-12-08', title: 'Craft fair' }), townEvent({ start: '2026-12-03', title: 'Tree lighting' })] });
    const slots = week(input, '2026-12-08');
    expect(slots.map((slot) => slot.date)).toEqual(weekDays('2026-12-02'));
    for (const slot of slots.slice(5)) expect(slot).toMatchObject({ kind: 'day', pending: true, cards: [], range: null });
    for (const slot of slots.slice(0, 5)) expect(slot).toMatchObject({ kind: 'day', pending: false, outside: false });
    expect(dayIn(slots, '2026-12-03').cards.map((card) => card.title)).toEqual(['Tree lighting']);
    expect(dayIn(slots, '2026-12-08').label).toBe('Tue, Dec 8, 2026. Loading.');
  });
});

describe('gridMove in the week view’s columns and its agenda', () => {
  const bounds = monthBounds(TODAY);
  const move = (layout: 'week' | 'agenda', from: string, key: string, ctrl = false, today = TODAY) => gridMove(from, key, ctrl, { layout, weekStart: weekStartFor(from, today), bounds });

  test('in the columns Up and Down move a week; in the agenda, where each day is a row, a day', () => {
    expect(move('week', '2026-11-18', 'ArrowDown')).toEqual({ date: '2026-11-25', month: null });
    expect(move('week', '2026-11-18', 'ArrowUp')).toEqual({ date: '2026-11-11', month: null });
    expect(move('agenda', '2026-11-18', 'ArrowDown')).toEqual({ date: '2026-11-19', month: null });
    expect(move('agenda', '2026-11-18', 'ArrowUp')).toEqual({ date: '2026-11-17', month: null });
    // Left and Right are a day in both, across weeks.
    for (const layout of ['week', 'agenda'] as const) {
      expect(move(layout, '2026-11-22', 'ArrowRight')).toEqual({ date: '2026-11-23', month: null });
      expect(move(layout, '2026-11-16', 'ArrowLeft')).toEqual({ date: '2026-11-15', month: null });
    }
  });

  test('Home and End go to the block’s first and last day, and Ctrl or Cmd with them the same', () => {
    // Today Sun, Nov 15: Wed, Nov 18 is in the block of Nov 15 to 21.
    for (const layout of ['week', 'agenda'] as const) {
      expect(move(layout, '2026-11-18', 'Home', false, '2026-11-15')).toEqual({ date: '2026-11-15', month: null });
      expect(move(layout, '2026-11-18', 'End', false, '2026-11-15')).toEqual({ date: '2026-11-21', month: null });
      expect(move(layout, '2026-11-18', 'Home', true, '2026-11-15')).toEqual({ date: '2026-11-15', month: null });
      expect(move(layout, '2026-11-18', 'End', true, '2026-11-15')).toEqual({ date: '2026-11-21', month: null });
    }
    // Today Wed, Nov 11: the block of Nov 18 to 24, not Monday's week.
    expect(move('week', '2026-11-21', 'Home')).toEqual({ date: '2026-11-18', month: null });
    expect(move('week', '2026-11-21', 'End')).toEqual({ date: '2026-11-24', month: null });
  });

  test('PageUp and PageDown step from the selected day’s own month, since the week view hides the grid’s', () => {
    // The grid is on November, and Oct 28 is in its leading row.
    expect(move('week', '2026-10-28', 'PageDown')).toEqual({ date: '2026-11-28', month: '2026-11' });
    expect(move('week', '2026-10-28', 'PageUp')).toEqual({ date: '2026-09-28', month: '2026-09' });
    expect(move('agenda', '2027-01-31', 'PageDown')).toEqual({ date: '2027-02-28', month: '2027-02' });
    // The month view steps from the grid's month instead.
    expect(gridMove('2026-10-28', 'PageDown', false, { layout: 'month', month: '2026-11', bounds })).toEqual({ date: '2026-12-28', month: '2026-12' });
  });

  test('at the 25 months’ ends a key is consumed, and Home and End clamp', () => {
    expect(move('week', '2027-11-30', 'ArrowRight')).toEqual({ date: '2027-11-30', month: null });
    expect(move('agenda', '2027-11-30', 'ArrowDown')).toEqual({ date: '2027-11-30', month: null });
    expect(move('week', '2027-11-15', 'PageDown')).toEqual({ date: '2027-11-15', month: null });
    // Today Nov 15, 2026: the block of Nov 28 to Dec 4, 2027 ends past the last day.
    expect(move('week', '2027-11-29', 'End', true, '2026-11-15')).toEqual({ date: '2027-11-30', month: null });
    // Today Nov 11, 2026: the block of Oct 29 to Nov 4, 2025 starts before the first.
    expect(move('agenda', '2025-11-02', 'Home')).toEqual({ date: '2025-11-01', month: null });
  });
});
