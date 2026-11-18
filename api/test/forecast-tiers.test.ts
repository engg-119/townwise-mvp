// A run's two tiers (spec D52, 14.6; forecast-outlook delta, "A run's two tiers").
import { describe, expect, it } from 'vitest';

import { FORECAST_TIER_CAP_DAYS, FORECAST_TIER_DAYS, forecastThrough, isOutlook, tierEnd } from '../src/forecasts/tiers.ts';

describe('forecast tiers', () => {
  it('the tier constants are D42’s reach and cap', () => {
    expect(FORECAST_TIER_DAYS).toBe(91);
    expect(FORECAST_TIER_CAP_DAYS).toBe(182);
  });

  it('the boundary: a run made 2026-11-23 with current sales has 2027-02-22 as its last forecast day', () => {
    const run = { madeAt: '2026-11-23', dataThrough: '2026-11-22', range: { from: '2026-11-23', to: '2027-11-23' } };
    expect(tierEnd(run)).toBe('2027-02-22');
    expect(forecastThrough(run)).toBe('2027-02-22');
    expect(isOutlook('2027-02-22', run)).toBe(false);
    expect(isOutlook('2027-02-23', run)).toBe(true);
    expect(isOutlook('2026-11-23', run)).toBe(false);
  });

  it('sales lagging past three months: the tier ends 182 days after the last day of sales', () => {
    const run = { madeAt: '2026-11-23', dataThrough: '2026-08-01', range: { from: '2026-08-02', to: '2027-09-05' } };
    expect(tierEnd(run)).toBe('2027-01-30');
    expect(isOutlook('2027-01-30', run)).toBe(false);
    expect(isOutlook('2027-01-31', run)).toBe(true);
  });

  it('a 91-day run’s forecastThrough is its last day, and none of its days is an outlook day', () => {
    const run = { madeAt: '2026-11-23', dataThrough: '2026-11-22', range: { from: '2026-11-23', to: '2027-02-22' } };
    expect(forecastThrough(run)).toBe(run.range.to);
    expect(isOutlook(run.range.to, run)).toBe(false);
  });

  it('a run that stops short of its tier (D42’s 28-day stop) is all forecast, through its last day', () => {
    const run = { madeAt: '2026-11-23', dataThrough: '2026-11-22', range: { from: '2026-11-23', to: '2026-12-20' } };
    expect(forecastThrough(run)).toBe('2026-12-20');
    expect(tierEnd(run)).toBe('2027-02-22');
  });
});
