import type { Column, Row } from '../../portal/ui/DataTable';
import { MONTH_NAMES, WEEKDAY_NAMES, metricNumber, metricText, signedPercent, type Metric } from '../../portal/analytics/words';
import { dayText, formatCount, rangeText } from '../format';
import { formatDate, plural } from '../../portal/format';
import { formatDollars, SERIES_TITLE } from '../../portal/locations/sales';
import type { Visual } from './schema';

// Townwise's words for a visual: its title, its text summary, the table behind "Show the numbers" and the metric
// cards. Pure functions over the visual. The API sends net sales in dollars; the portal's formatters take cents. A
// daily visual's forecast is worded as the product words it (Home's day detail, the Calendar): about the middle,
// likely the low to the high, and a closed or booked day by its status.

export const NATIVE_CHART = 'See the chart at townwise.tech.';
export const NO_DATA = 'No data';
export const NO_SALES_YET = 'No sales yet for these days.';

type DailyDay = Extract<Visual, { kind: 'daily' }>['days'][number];

/** A closed or booked day's word in the numbers table, as the Calendar's status word gives it. */
const STATUS_WORD: Readonly<Record<'closed' | 'booked', string>> = { closed: 'Closed', booked: 'Booked' };

const SHORT_WEEKDAYS = WEEKDAY_NAMES.map((name) => name.slice(0, 3));

/** A value in the portal formatters' units: guests as they are, dollars as cents. */
export function unitsOf(value: number, metric: Metric): number {
  return Math.round(metric === 'netSales' ? value * 100 : value);
}

export function valueWord(value: number | null, metric: Metric): string {
  return value === null ? NO_DATA : metricNumber(unitsOf(value, metric), metric);
}

function valueSentence(value: number, metric: Metric): string {
  return metricText(unitsOf(value, metric), metric);
}

const METRIC_WORD: Readonly<Record<Metric, string>> = { guests: 'Guests', netSales: 'Net sales' };

function hasBand(day: DailyDay): boolean {
  return day.low !== null && day.high !== null;
}

/**
 * A day's forecast in a line: “Forecast about 180, likely 117 to 256”, “Forecast 117 to 256” for a visual stored
 * before the middle was sent, “Forecast: closed” or “Forecast: booked for a private event”; null with none.
 */
export function forecastLine(day: DailyDay, metric: Metric): string | null {
  if (day.low !== null && day.high !== null) {
    const range = `${valueWord(day.low, metric)} to ${valueWord(day.high, metric)}`;
    return day.mid === null ? `Forecast ${range}` : `Forecast about ${valueWord(day.mid, metric)}, likely ${range}`;
  }
  if (day.status === 'closed') return 'Forecast: closed';
  if (day.status === 'booked') return 'Forecast: booked for a private event';
  return null;
}

/** “Townwise’s forecast has 1 day closed and 2 days booked for a private event.”; null with neither. */
function statusSentence(days: readonly DailyDay[]): string | null {
  const closed = days.filter((day) => day.status === 'closed').length;
  const booked = days.filter((day) => day.status === 'booked').length;
  const parts = [
    ...(closed > 0 ? [`${plural(closed, 'day', 'days')} closed`] : []),
    ...(booked > 0 ? [`${plural(booked, 'day', 'days')} booked for a private event`] : []),
  ];
  return parts.length === 0 ? null : `Townwise’s forecast has ${parts.join(' and ')}.`;
}

/** The bar's long label: "Saturday", "October 2026". */
export function barLabel(key: string): string {
  if (/^[0-6]$/.test(key)) return WEEKDAY_NAMES[Number(key)] ?? key;
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const month = match === null ? undefined : MONTH_NAMES[Number(match[2]) - 1];
  return match === null || month === undefined ? key : `${month} ${match[1] ?? ''}`;
}

/** The bar's short label under the chart: "Sat", "Oct", or "Oct ’26" when the bars span more than one year. */
export function barShortLabel(key: string, manyYears: boolean): string {
  if (/^[0-6]$/.test(key)) return SHORT_WEEKDAYS[Number(key)] ?? key;
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const month = match === null ? undefined : MONTH_NAMES[Number(match[2]) - 1]?.slice(0, 3);
  if (match === null || month === undefined) return key;
  return manyYears ? `${month} ’${(match[1] ?? '').slice(2)}` : month;
}

export function visualTitle(v: Visual): string {
  const range = rangeText(v.from, v.to);
  switch (v.kind) {
    case 'daily': return v.forecast === null ? `${SERIES_TITLE[v.metric]}, ${range}` : `Guests and forecast, ${range}`;
    case 'breakdown': return `Average daily ${v.metric === 'guests' ? 'guests' : 'net sales'} by ${v.by}, ${range}`;
    case 'days_table': return `Your days, ${range}`;
    case 'metrics': return `${METRIC_WORD[v.metric]}, ${range}`;
  }
}

export function visualSummary(v: Visual): string | null {
  switch (v.kind) {
    case 'daily': {
      const withData = v.days.filter((day) => day.value !== null);
      let highest: { date: string; value: number } | null = null;
      let lowest: { date: string; value: number } | null = null;
      for (const day of withData) {
        if (day.value === null) continue;
        if (highest === null || day.value > highest.value) highest = { date: day.date, value: day.value };
        if (lowest === null || day.value < lowest.value) lowest = { date: day.date, value: day.value };
      }
      const sales = highest === null || lowest === null ? null
        : `${formatCount(withData.length)} days with data. Highest: ${valueSentence(highest.value, v.metric)} on ${dayText(highest.date)}. `
          + `Lowest: ${valueSentence(lowest.value, v.metric)} on ${dayText(lowest.date)}.`;
      let forecast: string | null = null;
      if (v.forecast !== null) {
        const banded = v.days.filter(hasBand).length;
        // The band is the range as the owner's notes leave it (spec 14.5), so the 8 in 10 claim holds only on days no
        // note changed, as the Calendar puts it only beside the model's own range (calendar/model.ts).
        // madeAt is the run's YYYY-MM-DD date, read without a time zone (formatDay would read it as a UTC instant).
        forecast = `The shaded band is ${v.forecast.model}’s forecast range, made ${formatDate(v.forecast.madeAt)}, for ${formatCount(banded)} days, plus guests from your notes on days that have them. On days without a note, about 8 in 10 land inside it.`;
        if (v.days.some((day) => day.mid !== null)) forecast += ' The dashed line marks the forecast’s middle.';
      }
      const statuses = statusSentence(v.days);
      // Days with no sales yet (the days from today on) can still have Townwise's forecast.
      if (sales === null && forecast === null && statuses === null) return null;
      return [sales ?? NO_SALES_YET, forecast, statuses].filter((part) => part !== null).join(' ');
    }
    case 'breakdown': {
      const withData = v.bars.filter((bar) => bar.value !== null);
      let highest: { key: string; value: number } | null = null;
      let lowest: { key: string; value: number } | null = null;
      for (const bar of withData) {
        if (bar.value === null) continue;
        if (highest === null || bar.value > highest.value) highest = { key: bar.key, value: bar.value };
        if (lowest === null || bar.value < lowest.value) lowest = { key: bar.key, value: bar.value };
      }
      if (highest === null || lowest === null) return null;
      return `Highest: ${barLabel(highest.key)}, ${valueSentence(highest.value, v.metric)}. Lowest: ${barLabel(lowest.key)}, ${valueSentence(lowest.value, v.metric)}.`;
    }
    case 'days_table': return `${formatCount(v.rows.length)} days.`;
    case 'metrics': return null;
  }
}

function cardsOf(v: Extract<Visual, { kind: 'metrics' }>): { label: string; value: string }[] {
  const cards = [
    { label: 'Total', value: valueWord(v.total, v.metric) },
    { label: 'Daily average', value: valueWord(v.dailyAverage, v.metric) },
    { label: 'Days with data', value: formatCount(v.dayCount) },
  ];
  const { compare } = v;
  if (compare === null) return cards;
  const span = Math.round((Date.parse(`${v.to}T00:00:00.000Z`) - Date.parse(`${v.from}T00:00:00.000Z`)) / 86_400_000) + 1;
  const label = compare.basis === 'last_year' ? 'Change from the same days last year' : `Change from the ${formatCount(span)} days before`;
  const value = v.total === null || compare.total === null || compare.total === 0 ? NO_DATA : signedPercent((v.total - compare.total) / compare.total);
  return [...cards, { label, value }];
}

export function metricCards(v: Extract<Visual, { kind: 'metrics' }>): { label: string; value: string }[] {
  return cardsOf(v);
}

const DATE_COLUMN: Column = { key: 'date', label: 'Date', flex: 1.5 };

/** The table behind "Show the numbers": one row per day, bar or card. */
export function visualRows(v: Visual): { columns: Column[]; rows: Row[] } {
  switch (v.kind) {
    case 'daily': {
      // The forecast's columns show with a band or a closed or booked day; the middle's with a middle or a status (a
      // visual stored before the middle was sent has neither), where a closed or booked day says which it is.
      const forecast = v.days.some((day) => hasBand(day) || day.status !== null);
      const middle = v.days.some((day) => day.mid !== null || day.status !== null);
      const columns: Column[] = [DATE_COLUMN, { key: 'value', label: METRIC_WORD[v.metric], numeric: true }];
      if (forecast) {
        columns.push(
          { key: 'low', label: 'Forecast low', numeric: true },
          ...(middle ? [{ key: 'mid', label: 'Forecast middle', numeric: true }] : []),
          { key: 'high', label: 'Forecast high', numeric: true },
        );
      }
      const word = (value: number | null): string => (value === null ? '' : valueWord(value, v.metric));
      const rows = v.days.map((day): Row => ({
        key: day.date,
        cells: {
          date: dayText(day.date),
          value: valueWord(day.value, v.metric),
          ...(forecast ? { low: word(day.low), high: word(day.high) } : {}),
          ...(middle ? { mid: day.status === null ? word(day.mid) : STATUS_WORD[day.status] } : {}),
        },
      }));
      return { columns, rows };
    }
    case 'breakdown': {
      const columns: Column[] = [
        { key: 'label', label: v.by === 'weekday' ? 'Weekday' : 'Month', flex: 1.5 },
        { key: 'value', label: v.metric === 'guests' ? 'Average guests' : 'Average net sales', numeric: true },
        { key: 'days', label: 'Days with data', numeric: true },
      ];
      const rows = v.bars.map((bar): Row => ({
        key: bar.key,
        cells: { label: barLabel(bar.key), value: valueWord(bar.value, v.metric), days: formatCount(bar.days) },
      }));
      return { columns, rows };
    }
    case 'days_table': {
      const columns: Column[] = [DATE_COLUMN, { key: 'guests', label: 'Guests', numeric: true }, { key: 'netSales', label: 'Net sales', numeric: true }];
      const rows = v.rows.map((day): Row => ({
        key: day.date,
        cells: {
          date: dayText(day.date),
          guests: day.guests === null ? NO_DATA : formatCount(Math.round(day.guests)),
          netSales: day.netSales === null ? NO_DATA : formatDollars(Math.round(day.netSales * 100)),
        },
      }));
      return { columns, rows };
    }
    case 'metrics': {
      const columns: Column[] = [{ key: 'label', label: 'Measure', flex: 2 }, { key: 'value', label: 'Value', numeric: true }];
      const rows = cardsOf(v).map((card): Row => ({ key: card.label, cells: card }));
      return { columns, rows };
    }
  }
}
