// A run's two tiers (spec D52, 14.6): its forecast tier ends where a D42 run made that day would have ended, and any
// later day is its outlook. Derived from the run's dates wherever it is needed, never stored on a row. Pure.
import { utcDay } from '../dates.ts';

/** A D42 run reaches its calibration's today plus this many days (the lab's forecast.FORECAST_DAYS). */
export const FORECAST_TIER_DAYS = 91;
/** ...capped at this many days after its last day of sales (the lab's forecast.FORECAST_CAP_DAYS). */
export const FORECAST_TIER_CAP_DAYS = 182;

/** The dates a run's tiers are read from. */
export interface TierRun {
  readonly madeAt: string;
  readonly dataThrough: string;
  readonly range: { readonly from: string; readonly to: string };
}

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

/** The last day of the run's forecast tier: min(madeAt + 91, dataThrough + 182). */
export function tierEnd(run: Omit<TierRun, 'range'>): string {
  const made = plusDays(run.madeAt, FORECAST_TIER_DAYS);
  const capped = plusDays(run.dataThrough, FORECAST_TIER_CAP_DAYS);
  return made < capped ? made : capped;
}

/** The run's last forecast-tier day it carries: the earlier of its last day and its tierEnd. */
export function forecastThrough(run: TierRun): string {
  const end = tierEnd(run);
  return run.range.to < end ? run.range.to : end;
}

/** Whether `date` is in the run's outlook: after its forecast tier. */
export function isOutlook(date: string, run: Omit<TierRun, 'range'>): boolean {
  return date > tierEnd(run);
}
