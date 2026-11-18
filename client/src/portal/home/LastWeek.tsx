import { useRouter } from 'expo-router';

import type { ChartTip } from '../analytics/barTips';
import { plainOf } from '../analytics/phrase';
import { dayMonth, lastWeekForecastCell, lastWeekForecastOnly, lastWeekPhrases, type LastWeek as Comparison, type LastWeekDay } from '../analytics/week';
import { metricNumber, metricText, shortDate, signedPercent, type Metric } from '../analytics/words';
import { ShowNumbers, UploadAction } from '../locations/parts';
import { calendarHref } from '../routing';
import { Actions } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { PhraseParts } from '../ui/PhraseParts';
import { Small } from '../ui/text';
import { Block } from './Block';
import { LastWeekChart, type ForecastBar } from './LastWeekChart';

// Last week (home.md 2.4): the seven days before today, This week's weekdays a week earlier (owner request,
// 2026-11-15), against the same weekdays 52 weeks earlier. The totals and the change are over the days that have the
// metric in both weeks, and the summary says how many. With a published forecast for these days (D42, Home's own read
// of them), the card opens with the forecast's error from the read's `accuracy`, and a day with a published forecast
// and no guests stored reads as that forecast, labeled so, never as sales and never summed. Every forecast figure is
// the read's own: never an unpublished guess. Web draws the pairs, and a forecast-only day in the forecast style;
// native has the text and the table (D21). On web a day's slot hovers with its row's words, and a click opens the day in
// the Calendar (owner request, 2026-11-17).

/** In range: the read's own `inRange` for a day it scored. */
function inRangeCell(day: LastWeekDay): string {
  if (day.forecast === null) return 'None';
  if (day.forecastOnly) return 'No guest count';
  if (day.forecast.scored !== true) return 'Not scored';
  return day.forecast.inRange === true ? 'Yes' : 'No';
}

/** Change: last week against last year, or "None" without both (or with last year at 0). */
function changeOf(day: LastWeekDay): string {
  return day.value === null || day.lastYear === null || day.lastYear === 0 ? 'None' : signedPercent(day.value / day.lastYear - 1);
}

/**
 * A day's hover words on the web chart: its row in Show the numbers, said in full. A forecast-only day leads with its
 * labeled forecast, so its tooltip never reads like a sales figure either.
 */
function tipOf(day: LastWeekDay, metric: Metric, withForecast: boolean): ChartTip {
  const text = (value: number | null): string => (value === null ? 'No data' : metricText(value, metric));
  const only = day.forecastOnly && day.forecast !== null ? lastWeekForecastOnly(day.forecast) : null;
  const forecast = withForecast && only === null && day.forecast !== null ? lastWeekForecastCell(day.forecast) : null;
  const change = changeOf(day);
  return {
    title: shortDate(day.date),
    lines: [
      only ?? `Last week: ${text(day.value)}`,
      `Same day last year: ${text(day.lastYear)}`,
      ...(change === 'None' ? [] : [`Change: ${change}`]),
      ...(forecast === null ? [] : [`Forecast: ${forecast}`]),
    ],
  };
}

/** A forecast-only day's bar on web: the run's own open day; none in another metric, since forecasts are in guests. */
function barsOf(days: readonly LastWeekDay[], metric: Metric): ForecastBar[] {
  if (metric !== 'guests') return [];
  return days.flatMap((day) => {
    const own = day.forecastOnly ? day.forecast?.model : undefined;
    return own?.status === 'open' && own.low !== null && own.mid !== null && own.high !== null
      ? [{ date: day.date, low: own.low, mid: own.mid, high: own.high }] : [];
  });
}

export function LastWeek(props: {
  comparison: Comparison;
  metric: Metric;
  locationId: string;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { comparison, metric } = props;
  const router = useRouter();
  const part = comparison.forecast;
  const range = comparison.state === 'no_history' || comparison.state === 'uploads_off' ? null : `${dayMonth(comparison.from)} to ${dayMonth(comparison.to)}`;
  const stored = comparison.state === 'compared' || comparison.state === 'no_last_year' || comparison.state === 'no_overlap' ? comparison.days : null;
  // With a forecast part, its seven days, each with the read's day; else today's, with none.
  const days: readonly LastWeekDay[] | null = part?.days ?? stored?.map((day) => ({ ...day, forecast: null, forecastOnly: false })) ?? null;
  const bars = part === undefined ? [] : barsOf(part.days, metric);
  const number = (value: number | null): string => (value === null ? 'No data' : metricNumber(value, metric));
  return (
    <Block label="Last week" eyebrow={range === null ? 'Last week' : `Last week, ${range}`} title="Against the same week last year">
      {days !== null && (comparison.state === 'compared' || bars.length > 0) ? (
        <LastWeekChart
          days={days}
          metric={metric}
          forecast={bars}
          tips={days.map((day) => tipOf(day, metric, part !== undefined))}
          onOpen={(date) => { router.push(calendarHref(props.locationId, date)); }}
        />
      ) : null}
      {lastWeekPhrases(comparison, metric).map((phrase) => <Small key={plainOf(phrase)} white><PhraseParts phrase={phrase} /></Small>)}
      {comparison.state === 'no_recent' || comparison.state === 'no_days' || days?.some((day) => day.forecastOnly) === true ? (
        <Actions><UploadAction locationId={props.locationId} variant="link" readOnlyId={props.readOnlyId} /></Actions>
      ) : null}
      {days === null ? null : (
        <ShowNumbers>
          <DataTable
            label="Last week against the same week last year"
            columns={[
              { key: 'day', label: 'Day', flex: 1.4 }, { key: 'week', label: 'Last week', numeric: true, ...(part === undefined ? {} : { flex: 2.4 }) },
              { key: 'year', label: 'Last year', numeric: true }, { key: 'change', label: 'Change', numeric: true },
              ...(part === undefined ? [] : [{ key: 'forecast', label: 'Forecast', numeric: true, flex: 1.6 }, { key: 'inRange', label: 'In range' }]),
            ]}
            rows={days.map((day) => {
              // A forecast-only day reads as its forecast, labeled so, in the Last week column: never as a sales figure.
              const only = day.forecastOnly && day.forecast !== null ? lastWeekForecastOnly(day.forecast) : null;
              return {
                key: day.date,
                cells: {
                  day: shortDate(day.date),
                  week: only ?? number(day.value),
                  year: number(day.lastYear),
                  change: changeOf(day),
                  ...(part === undefined ? {} : {
                    forecast: (day.forecast === null ? null : lastWeekForecastCell(day.forecast)) ?? 'None',
                    inRange: inRangeCell(day),
                  }),
                },
              };
            })}
          />
        </ShowNumbers>
      )}
    </Block>
  );
}
