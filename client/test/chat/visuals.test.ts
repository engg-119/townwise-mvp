import { visualSchema } from '../../src/chat/visuals/schema';
import { metricCards, visualRows, visualSummary, visualTitle } from '../../src/chat/visuals/words';
import { daily, dailyWithBand, daysTable, down12, forecastOnly, mixed, previous, storedBeforeMid, weekdays } from './visuals-fixtures';

test('titles and summarizes each kind in Townwise’s words, with years and a true minus', () => {
  expect(visualTitle(daily)).toBe('Daily guests, Oct 1 to Oct 31, 2026'.replace('Oct 31', 'Oct 5'));
  expect(visualTitle(weekdays)).toBe('Average daily guests by weekday, Oct 1 to Oct 31, 2026');
  expect(visualTitle(daysTable)).toBe('Your days, Oct 1 to Oct 2, 2026');
  expect(visualTitle(down12)).toBe('Guests, Oct 1 to Oct 31, 2026');
  expect(visualTitle({ ...previous })).toBe('Net sales, Oct 1 to Oct 31, 2026');
  expect(visualSummary(daily)).toBe('4 days with data. Highest: 90 guests on Sat, Oct 3, 2026. Lowest: 20 guests on Sun, Oct 4, 2026.');
  // The band is the range as the owner's notes leave it (spec 14.5), so the 8 in 10 claim is only for days without
  // a note, as the Calendar says it only beside the model's own range.
  expect(visualSummary(dailyWithBand)).toContain('The shaded band is Townwise’s forecast range, made Sep 30, 2026, for 2 days, plus guests from your notes on days that have them.');
  expect(visualSummary(dailyWithBand)).toContain('On days without a note, about 8 in 10 land inside it.');
  expect(visualSummary(dailyWithBand)).not.toContain('About 8 in 10 days land inside it.');
  expect(visualSummary(weekdays)).toBe('Highest: Saturday, 150 guests. Lowest: Sunday, 30 guests.');
  expect(visualSummary(daysTable)).toBe('2 days.');
  expect(metricCards(down12).at(-1)).toEqual({ label: 'Change from the same days last year', value: '−12%' });
  expect(metricCards(down12).slice(0, 3)).toEqual([
    { label: 'Total', value: '880' }, { label: 'Daily average', value: '28' }, { label: 'Days with data', value: '31' },
  ]);
});

test('a card with no value reads No data, and the previous-period label counts the range’s days', () => {
  expect(metricCards(previous)).toEqual([
    { label: 'Total', value: '$5,000' }, { label: 'Daily average', value: '$28' }, { label: 'Days with data', value: '31' },
    { label: 'Change from the 31 days before', value: 'No data' },
  ]);
});

test('drops a visual of an unknown kind or a bad shape, and strips unknown keys', () => {
  expect(visualSchema.safeParse({ kind: 'pie' }).success).toBe(false);
  expect(visualSchema.safeParse({ ...daysTable, rows: 'x' }).success).toBe(false);
  const parsed = visualSchema.safeParse({ ...daysTable, extra: 1 });
  expect(parsed.success && 'extra' in parsed.data).toBe(false);
});

test('gives every chart a numbers table with one row per day, bar or card', () => {
  expect(visualRows(daily).rows).toHaveLength(5);
  expect(visualRows(daily).columns.map((c) => c.label)).toEqual(['Date', 'Guests']);
  expect(visualRows(dailyWithBand).columns.map((c) => c.label)).toEqual(['Date', 'Guests', 'Forecast low', 'Forecast high']);
  expect(visualRows(daily).rows[1]?.cells.value).toBe('No data');
  expect(visualRows(weekdays).rows).toHaveLength(7);
  expect(visualRows(weekdays).rows[0]?.cells).toEqual({ label: 'Monday', value: '40', days: '4' });
  expect(visualRows(daysTable).rows[0]?.cells).toEqual({ date: 'Thu, Oct 1, 2026', guests: '40', netSales: '$1,235' });
  expect(visualRows(down12).rows).toHaveLength(4);
});

test('a daily visual with the forecast is titled for it and summarized in Townwise’s words, with no sales yet', () => {
  expect(visualTitle(forecastOnly)).toBe('Guests and forecast, Nov 16 to Nov 22, 2026');
  expect(visualTitle(mixed)).toBe('Guests and forecast, Nov 10 to Nov 15, 2026');
  expect(visualTitle(dailyWithBand)).toBe('Guests and forecast, Oct 1 to Oct 5, 2026');
  // The run's made-at date is a calendar date, read without a time zone.
  expect(visualSummary(forecastOnly)).toBe(
    'No sales yet for these days. The shaded band is Townwise demand model v0’s forecast range, made Nov 12, 2026, for 5 days, '
    + 'plus guests from your notes on days that have them. On days without a note, about 8 in 10 land inside it. '
    + 'The dashed line marks the forecast’s middle. Townwise’s forecast has 1 day closed and 1 day booked for a private event.',
  );
  expect(visualSummary(mixed)).toBe(
    '3 days with data. Highest: 140 guests on Thu, Nov 12, 2026. Lowest: 95 guests on Wed, Nov 11, 2026. '
    + 'The shaded band is Townwise demand model v0’s forecast range, made Nov 12, 2026, for 3 days, '
    + 'plus guests from your notes on days that have them. On days without a note, about 8 in 10 land inside it. '
    + 'The dashed line marks the forecast’s middle.',
  );
  // A visual stored before the middle was sent draws none and says none.
  expect(visualSummary(dailyWithBand)).not.toContain('dashed');
});

test('a daily visual’s numbers give the forecast’s low, middle and high, and Closed or Booked', () => {
  const { columns, rows } = visualRows(forecastOnly);
  expect(columns.map((c) => c.label)).toEqual(['Date', 'Guests', 'Forecast low', 'Forecast middle', 'Forecast high']);
  expect(rows[0]?.cells).toEqual({ date: 'Mon, Nov 16, 2026', value: 'No data', low: '117', mid: '180', high: '256' });
  expect(rows[2]?.cells).toEqual({ date: 'Wed, Nov 18, 2026', value: 'No data', low: '', mid: 'Closed', high: '' });
  expect(rows[5]?.cells).toMatchObject({ mid: 'Booked' });
  expect(visualRows(mixed).rows[0]?.cells).toEqual({ date: 'Tue, Nov 10, 2026', value: '120', low: '', mid: '', high: '' });
});

test('a daily visual stored before the forecast’s middle and status were sent parses with neither, as it was drawn', () => {
  const parsed = visualSchema.parse(storedBeforeMid);
  if (parsed.kind !== 'daily') throw new Error('not daily');
  expect(parsed.days.map((day) => [day.mid, day.status])).toEqual([[null, null], [null, null], [null, null]]);
  expect(visualTitle(parsed)).toBe('Guests and forecast, Oct 1 to Oct 3, 2026');
  expect(visualRows(parsed).columns.map((c) => c.label)).toEqual(['Date', 'Guests', 'Forecast low', 'Forecast high']);
  expect(visualSchema.safeParse({ ...forecastOnly, days: [{ ...forecastOnly.days[0], status: 'open' }] }).success).toBe(false);
});

test('a daily visual with outlook days counts only the forecast’s days for 8 in 10 and says the outlook is wider (D52)', () => {
  // A band over 10 days, 2 of them outlook days (a stale run's): 8 for the 8 in 10 sentence, and the outlook sentence.
  const days = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-11-${String(16 + i)}`, value: null, low: 100, mid: 150, high: 200, status: null, ...(i >= 8 ? { outlook: true } : {}),
  }));
  const withOutlook = { ...forecastOnly, from: '2026-11-16', to: '2026-11-25', days };
  const summary = visualSummary(withOutlook);
  expect(summary).toContain('forecast range, made Nov 12, 2026, for 8 days, plus guests from your notes on days that have them. On days without a note, about 8 in 10 land inside it. Days marked outlook have a wider range.');
  // With no outlook day the words are as before, and every day an outlook day makes no 8 in 10 claim.
  expect(visualSummary(forecastOnly)).not.toContain('outlook');
  const allOutlook = visualSummary({ ...withOutlook, days: days.map((day) => ({ ...day, outlook: true })) });
  expect(allOutlook).not.toContain('8 in 10');
  expect(allOutlook).toContain('Days marked outlook have a wider range.');
  // An old stored visual with no outlook still parses and replays.
  const parsed = visualSchema.parse(storedBeforeMid);
  expect(parsed.kind === 'daily' && parsed.days.every((day) => day.outlook === undefined)).toBe(true);
  expect(visualSchema.parse(withOutlook)).toEqual(withOutlook);
});
