import type { Column, Row } from '../../portal/ui/DataTable';
import { MONTH_NAMES, WEEKDAY_NAMES, metricNumber, metricText, signedPercent, type Metric } from '../../portal/analytics/words';
import { dayText, formatCount, formatDay, rangeText } from '../format';
import { formatDollars, SERIES_TITLE } from '../../portal/locations/sales';
import type { Visual } from './schema';

// Townwise's words for a visual: its title, its text summary, the table behind "Show the numbers" and the metric
// cards. Pure functions over the visual. The API sends net sales in dollars; the portal's formatters take cents.

export const NATIVE_CHART = 'See the chart at townwise.tech.';
export const NO_DATA = 'No data';

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
    case 'daily': return `${SERIES_TITLE[v.metric]}, ${range}`;
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
      if (highest === null || lowest === null) return null;
      let text = `${formatCount(withData.length)} days with data. Highest: ${valueSentence(highest.value, v.metric)} on ${dayText(highest.date)}. `
        + `Lowest: ${valueSentence(lowest.value, v.metric)} on ${dayText(lowest.date)}.`;
      if (v.forecast !== null) {
        const banded = v.days.filter((day) => day.low !== null && day.high !== null).length;
        // The band is the range as the owner's notes leave it (spec 14.5), so the 8 in 10 claim holds only on days no
        // note changed, as the Calendar puts it only beside the model's own range (calendar/model.ts).
        text += ` The shaded band is ${v.forecast.model}’s forecast range, made ${formatDay(v.forecast.madeAt)}, for ${formatCount(banded)} days, plus guests from your notes on days that have them. On days without a note, about 8 in 10 land inside it.`;
      }
      return text;
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
      const band = v.days.some((day) => day.low !== null && day.high !== null);
      const columns: Column[] = [DATE_COLUMN, { key: 'value', label: METRIC_WORD[v.metric], numeric: true }];
      if (band) columns.push({ key: 'low', label: 'Forecast low', numeric: true }, { key: 'high', label: 'Forecast high', numeric: true });
      const rows = v.days.map((day): Row => ({
        key: day.date,
        cells: {
          date: dayText(day.date),
          value: valueWord(day.value, v.metric),
          ...(band ? { low: day.low === null ? '' : valueWord(day.low, v.metric), high: day.high === null ? '' : valueWord(day.high, v.metric) } : {}),
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
