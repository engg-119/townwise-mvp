import { monthGrid, type MonthCell } from '../../../src/portal/analytics/week';
import { ALL_FILTERS, calendarMonth, captionOf, type CalendarCell, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { addDays } from '../../../src/portal/locations/dates';
import { note } from '../analytics/fakes';
import { forecastDay, forecastOf } from '../calendar/fakes';

// Home's This month and the Calendar give every day the same figure, caption and status (D49, design decision 9: one
// figure rule, calendar/model.ts figureOf, which Home's grid reads through dayCell). Today is Tue, Nov 17, 2026.
// Synthetic figures only.

const TODAY = '2026-11-17';

/** The 8 same weekdays before a date, at 100 guests each, so a near-empty day is likely closed (D32). */
function typicalWeeks(date: string): { date: string; guests: number; netSalesCents: number }[] {
  return Array.from({ length: 8 }, (_, at) => ({ date: addDays(date, -7 * (at + 1)), guests: 100, netSalesCents: 200_000 }));
}

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, covered: { from: '2026-11-01', to: '2026-11-30' },
    forecast: forecastOf([
      // A past day with only the run's figure, and one the run closed.
      forecastDay({ date: '2026-11-05', mid: 140, low: 120, high: 160 }),
      forecastDay({ date: '2026-11-09', status: 'closed', low: null, mid: null, high: null }),
      // Today, a future closed day, a future booked day.
      forecastDay({ date: TODAY }),
      forecastDay({ date: '2026-11-24', status: 'closed', low: null, mid: null, high: null }),
      forecastDay({
        date: '2026-11-28', status: 'booked', low: null, mid: null, high: null, noteGuests: 60,
        reasons: [{ kind: 'note', label: 'Your private buyout, 60 guests', effectPct: null, sources: [], note: { id: 'n1', guests: 60, outcome: 'booked' } }],
      }),
    ]) as ForecastWindow,
    salesDays: [
      // A past day with stored guests, and one likely closed against its weekday's 100.
      { date: '2026-11-02', guests: 98, netSalesCents: 196_000 }, ...typicalWeeks('2026-11-02'),
      { date: '2026-11-03', guests: 1, netSalesCents: 2_000 }, ...typicalWeeks('2026-11-03'),
    ],
    events: [], notes: [note({ startDate: '2026-11-28', kind: 'private_event', effect: 'closed', expectedGuests: 60 })], rules: [], imported: [],
    filters: ALL_FILTERS,
    ...fields,
  };
}

const facts = (cell: Pick<CalendarCell, 'figure' | 'status'>) => ({ figure: cell.figure, caption: captionOf(cell), status: cell.status });

function cellsOf(rows: readonly (readonly (CalendarCell | MonthCell | null)[])[]): Map<string, CalendarCell | MonthCell> {
  return new Map(rows.flat().flatMap((cell) => (cell === null ? [] : [[cell.date, cell]])));
}

test('every day of the month has the same figure, caption and status on the Calendar and on Home', () => {
  const calendar = cellsOf(calendarMonth('2026-11', input()));
  const home = cellsOf(monthGrid(TODAY, input()));
  expect([...home.keys()]).toEqual([...calendar.keys()]);
  for (const [date, cell] of calendar) {
    const other = home.get(date);
    if (other === undefined) throw new Error(`no Home cell on ${date}`);
    expect({ date, ...facts(other) }).toEqual({ date, ...facts(cell) });
  }
});

test('the fixture covers each case the rule has', () => {
  const home = cellsOf(monthGrid(TODAY, input()));
  const at = (date: string) => { const cell = home.get(date); if (cell === undefined) throw new Error(date); return facts(cell); };
  expect(at('2026-11-02')).toEqual({ figure: { value: 98, kind: 'actual' }, caption: 'guests', status: null });
  expect(at('2026-11-03')).toEqual({ figure: null, caption: null, status: 'likely_closed' });
  expect(at('2026-11-05')).toEqual({ figure: { value: 140, kind: 'past_forecast' }, caption: 'forecast', status: null });
  expect(at('2026-11-06')).toEqual({ figure: null, caption: null, status: 'no_data' });
  expect(at(TODAY)).toEqual({ figure: { value: 212, kind: 'forecast' }, caption: null, status: null });
  expect(at('2026-11-24')).toEqual({ figure: null, caption: null, status: 'closed' });
  expect(at('2026-11-28')).toEqual({ figure: { value: 60, kind: 'booked' }, caption: 'booked', status: 'booked' });
  expect(at('2026-11-30')).toEqual({ figure: null, caption: null, status: 'no_forecast' });
});

test('in net sales, a past day shows its stored net sales in dollars, and with none the run’s guest figure captioned “forecast”', () => {
  const sales = cellsOf(monthGrid(TODAY, input(), 'netSales'));
  const stored = sales.get('2026-11-02') as MonthCell;
  expect(stored).toMatchObject({ figure: { value: 196_000, kind: 'actual' }, figureText: '$1,960', caption: 'sales' });
  const run = sales.get('2026-11-05') as MonthCell;
  expect(run).toMatchObject({ figure: { value: 140, kind: 'past_forecast' }, figureText: '140', caption: 'forecast' });
  expect(stored.label).toContain('$1,960.');
});
