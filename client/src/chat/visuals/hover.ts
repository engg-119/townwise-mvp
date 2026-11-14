import { nearestIndex, slotIndex } from '../../portal/analytics/hoverMath';
import { dayText, formatCount } from '../format';
import { metricText, type Metric } from '../../portal/analytics/words';
import type { Visual } from './schema';
import { NO_DATA, unitsOf, valueWord } from './words';

// The words of a chart's hover tooltip (D21), pure so they are testable without a DOM. The wording is the summary's
// and "Show the numbers" table's: the date as "Fri, Oct 9, 2026", the value with its unit, "No data" for a day with
// none, and the forecast's range as "Forecast 117 to 256".

export interface TipWords {
  /** The mono first line: a date or a bar's label. */
  title: string;
  lines: string[];
}

export function dailyTip(day: Extract<Visual, { kind: 'daily' }>['days'][number], metric: Metric): TipWords {
  const lines = [day.value === null ? NO_DATA : metricText(unitsOf(day.value, metric), metric)];
  if (day.low !== null && day.high !== null) lines.push(`Forecast ${valueWord(day.low, metric)} to ${valueWord(day.high, metric)}`);
  return { title: dayText(day.date), lines };
}

/** A bar's tooltip: its long label, its average and the days behind it; null for a bar with no value. */
export function barTip(name: string, value: number | null, days: number | undefined, metric: Metric): TipWords | null {
  if (value === null) return null;
  const lines = [metricText(value, metric)];
  if (days !== undefined) lines.push(`${formatCount(days)} ${days === 1 ? 'day' : 'days'} with data`);
  return { title: name, lines };
}

export { nearestIndex, slotIndex };
