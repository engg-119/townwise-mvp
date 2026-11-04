// Calibration states (spec 14.1): derived from a location's own sales data on every read, never stored. No model
// runs in v1, so no state claims one: no forecast, no progress, no “calibrating” and no day threshold (14.2).
// queued, calibrating, calibrated, stale and failed arrive with model storage (14.3).
import type { Coverage } from './stores/sales-days.ts';

export type Calibration =
  | { state: 'no_sales_data' }
  | { state: 'not_calibrated'; dayCount: number; firstDate: string; lastDate: string };

/** [DECISION NEEDED: minimum days of history before calibration] Until it is decided, no threshold applies. */
export function calibrationOf(coverage: Coverage): Calibration {
  if (coverage.dayCount === 0 || coverage.firstDate === null || coverage.lastDate === null) return { state: 'no_sales_data' };
  return { state: 'not_calibrated', dayCount: coverage.dayCount, firstDate: coverage.firstDate, lastDate: coverage.lastDate };
}
