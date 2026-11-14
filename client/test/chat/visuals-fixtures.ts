import type { Visual } from '../../src/chat/visuals/schema';

type Daily = Extract<Visual, { kind: 'daily' }>;
type Metrics = Extract<Visual, { kind: 'metrics' }>;

const empty = { low: null, mid: null, high: null, status: null } as const;

export const daily: Daily = {
  kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-05', forecast: null,
  days: [
    { date: '2026-10-01', value: 40, ...empty },
    { date: '2026-10-02', value: null, ...empty },
    { date: '2026-10-03', value: 90, ...empty },
    { date: '2026-10-04', value: 20, ...empty },
    { date: '2026-10-05', value: 55, ...empty },
  ],
};

/** A band with no middle: a visual stored before the API sent the forecast's middle. */
export const dailyWithBand: Daily = {
  ...daily,
  forecast: { model: 'Townwise', madeAt: '2026-09-30T12:00:00.000Z' },
  days: [
    { date: '2026-10-01', value: 40, ...empty },
    { date: '2026-10-02', value: null, ...empty },
    { date: '2026-10-03', value: 90, low: 70, mid: null, high: 110, status: null },
    { date: '2026-10-04', value: 20, low: 15, mid: null, high: 35, status: null },
    { date: '2026-10-05', value: 55, ...empty },
  ],
};

const MADE = { model: 'Townwise demand model v0', madeAt: '2026-11-12' };
const band = (low: number, mid: number, high: number) => ({ low, mid, high, status: null });

/** Next week with no sales yet (the 2026-11-13 incident): the forecast alone, with a closed and a booked day. */
export const forecastOnly: Daily = {
  kind: 'daily', metric: 'guests', from: '2026-11-16', to: '2026-11-22', forecast: MADE,
  days: [
    { date: '2026-11-16', value: null, ...band(117, 180, 256) },
    { date: '2026-11-17', value: null, ...band(90, 130, 170) },
    { date: '2026-11-18', value: null, ...empty, status: 'closed' },
    { date: '2026-11-19', value: null, ...band(100, 140, 190) },
    { date: '2026-11-20', value: null, ...band(150, 210, 280) },
    { date: '2026-11-21', value: null, ...empty, status: 'booked' },
    { date: '2026-11-22', value: null, ...band(80, 120, 160) },
  ],
};

/** Sales through yesterday, then the forecast from today, Nov 13, on. */
export const mixed: Daily = {
  kind: 'daily', metric: 'guests', from: '2026-11-10', to: '2026-11-15', forecast: MADE,
  days: [
    { date: '2026-11-10', value: 120, ...empty },
    { date: '2026-11-11', value: 95, ...empty },
    { date: '2026-11-12', value: 140, ...empty },
    { date: '2026-11-13', value: null, ...band(117, 180, 256) },
    { date: '2026-11-14', value: null, ...band(150, 210, 280) },
    { date: '2026-11-15', value: null, ...band(80, 120, 160) },
  ],
};

/** A daily visual as the API stored it before it sent `mid` and `status`, unparsed. */
export const storedBeforeMid: unknown = {
  kind: 'daily', metric: 'guests', from: '2026-10-01', to: '2026-10-03', forecast: { model: 'Townwise demand model v0', madeAt: '2026-09-30' },
  days: [{ date: '2026-10-01', value: 40, low: null, high: null }, { date: '2026-10-02', value: 52, low: 45, high: 60 }, { date: '2026-10-03', value: null, low: 50, high: 70 }],
};

export const weekdays: Extract<Visual, { kind: 'breakdown' }> = {
  kind: 'breakdown', metric: 'guests', from: '2026-10-01', to: '2026-10-31', by: 'weekday',
  bars: [
    { key: '1', value: 40, days: 4 }, { key: '2', value: null, days: 0 }, { key: '3', value: 55, days: 4 },
    { key: '4', value: 60, days: 5 }, { key: '5', value: 120, days: 5 }, { key: '6', value: 150, days: 4 }, { key: '0', value: 30, days: 4 },
  ],
};

export const daysTable: Extract<Visual, { kind: 'days_table' }> = {
  kind: 'days_table', from: '2026-10-01', to: '2026-10-02',
  rows: [{ date: '2026-10-01', guests: 40, netSales: 1234.5 }, { date: '2026-10-02', guests: null, netSales: null }],
};

export const down12: Metrics = {
  kind: 'metrics', metric: 'guests', from: '2026-10-01', to: '2026-10-31', total: 880, dailyAverage: 28, dayCount: 31,
  compare: { basis: 'last_year', from: '2025-10-02', to: '2025-11-01', total: 1000, dayCount: 31 },
};

export const previous: Metrics = {
  ...down12, metric: 'netSales', total: 5000, compare: { basis: 'previous_period', from: '2026-09-01', to: '2026-09-30', total: null, dayCount: 0 },
};
