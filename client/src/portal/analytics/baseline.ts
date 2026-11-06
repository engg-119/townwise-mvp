import { valueOf } from '../locations/sales';
import { addDays } from '../locations/dates';
import { classOf, type DayContext } from './days';
import type { Included } from './filters';
import type { DayRecord } from './history';
import type { Metric } from './words';

// "Usual" for a day (home.md 5.4; spec [CONFIRM: the baseline for usual]): the mean of the metric on the same
// weekday in the 4 weeks either side (8 candidate days), leaving out the day itself, days with no value, days that
// are not regular (closed, noted, holiday or event days) and days the filters leave out. Fewer than 3 such days is
// not enough to call anything usual, so the answer is null.

export const USUAL_WEEKS = 4;
export const USUAL_MIN_DAYS = 3;

export interface Usual {
  mean: number;
  /** How many days the mean is over. */
  days: number;
}

export function usual(
  date: string, metric: Metric, byDate: ReadonlyMap<string, DayRecord>, context: DayContext, included: Included,
): Usual | null {
  let sum = 0;
  let count = 0;
  for (let week = -USUAL_WEEKS; week <= USUAL_WEEKS; week += 1) {
    if (week === 0) continue;
    const other = addDays(date, week * 7);
    const day = byDate.get(other);
    const value = day === undefined ? null : valueOf(day, metric);
    if (value === null || !included(other) || classOf(other, day, context) !== 'regular') continue;
    sum += value;
    count += 1;
  }
  return count < USUAL_MIN_DAYS ? null : { mean: sum / count, days: count };
}
