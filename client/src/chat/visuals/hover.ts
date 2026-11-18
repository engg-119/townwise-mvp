import { nearestIndex, slotIndex } from '../../portal/analytics/hoverMath';
import { dayText, formatCount } from '../format';
import { metricText, type Metric } from '../../portal/analytics/words';
import type { Visual } from './schema';
import { forecastLine, NO_DATA, unitsOf } from './words';

// The words of a chart's hover tooltip (D21), pure so they are testable without a DOM. The wording is the summary's
// and "Show the numbers" table's: the date as "Fri, Oct 9, 2026", the value with its unit, and the forecast as the
// product words it, "Forecast about 180, likely 117 to 256" ("Outlook about 180, likely 117 to 256" for an outlook day,
// D52; "Forecast 117 to 256" for a visual stored before the middle was sent, "Forecast: closed" or "Forecast: booked for
// a private event"); "No data" for a day with neither.

export interface TipWords {
  /** The mono first line: a date or a bar's label. */
  title: string;
  lines: string[];
}

export function dailyTip(day: Extract<Visual, { kind: 'daily' }>['days'][number], metric: Metric): TipWords {
  const forecast = forecastLine(day, metric);
  // Beside a forecast, the value says it is the actual (D49, design decision 10), as the Calendar's tooltip does.
  const value = day.value === null ? null : forecast === null ? metricText(unitsOf(day.value, metric), metric) : `${metricText(unitsOf(day.value, metric), metric)}, actual`;
  const lines = [...(value === null ? [] : [value]), ...(forecast === null ? [] : [forecast])];
  return { title: dayText(day.date), lines: lines.length === 0 ? [NO_DATA] : lines };
}

/** A bar's tooltip: its long label, its average and the days behind it; null for a bar with no value. */
export function barTip(name: string, value: number | null, days: number | undefined, metric: Metric): TipWords | null {
  if (value === null) return null;
  const lines = [metricText(value, metric)];
  if (days !== undefined) lines.push(`${formatCount(days)} ${days === 1 ? 'day' : 'days'} with data`);
  return { title: name, lines };
}

export { nearestIndex, slotIndex };
