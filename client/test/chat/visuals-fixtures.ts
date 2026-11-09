import type { Visual } from '../../src/chat/visuals/schema';

type Daily = Extract<Visual, { kind: 'daily' }>;
type Metrics = Extract<Visual, { kind: 'metrics' }>;

const empty = { low: null, high: null } as const;

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

export const dailyWithBand: Daily = {
  ...daily,
  forecast: { model: 'Townwise', madeAt: '2026-09-30T12:00:00.000Z' },
  days: [
    { date: '2026-10-01', value: 40, ...empty },
    { date: '2026-10-02', value: null, ...empty },
    { date: '2026-10-03', value: 90, low: 70, high: 110 },
    { date: '2026-10-04', value: 20, low: 15, high: 35 },
    { date: '2026-10-05', value: 55, ...empty },
  ],
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
