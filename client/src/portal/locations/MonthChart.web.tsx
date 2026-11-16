import { useCallback, useMemo, useState } from 'react';

import { analyticsInput, yearOverYear, type YearOverYear } from '../analytics/aggregates';
import { LineChart, type YearLine } from '../analytics/AnalyticsCharts';
import { fetchSalesHistory } from '../analytics/api';
import { dayContext, ruleSchedules, type DayContext } from '../analytics/days';
import { basisLine, defaultFilters, metricsWithData, type Filters } from '../analytics/filters';
import { decodeHistory, type DayRecord } from '../analytics/history';
import { MetricSwitch } from '../analytics/MetricSwitch';
import { METRIC_NOUN } from '../analytics/words';
import { useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { fetchRules, type Rule } from '../rules/api';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { fetchNotes } from './api';
import { localToday } from './dates';
import type { MonthChartProps } from './MonthChart';
import type { Series } from './sales';

// By month's chart on Sales data (spec P12), web only: Analytics' year-over-year LineChart over January to
// December, one line per calendar year, so each month can be read against the same month a year before. Its points
// are Analytics' own (aggregates.ts yearOverYear under Analytics' default filters): each month's average over its
// days with a value that are not closed, so this chart and Analytics' Year over year show the same numbers, and the
// basis line under it says what it left out, as Analytics' does. It reads what those need (the sales history, notes
// and business rules, a failed rules read counting as none, as on Analytics), so on its own load. Guests or Net sales,
// guests first as the daily chart is. The SVG is aria-hidden: the table below carries every month's days and totals.

const NO_RULES: readonly Rule[] = [];

/** Each year's line from Analytics' year over year, leaving out a year with no value for the metric. */
function yearLines(yoy: YearOverYear): YearLine[] {
  return yoy.years.map((year) => ({
    year,
    points: yoy.cells.filter((cell) => cell.year === year).map((cell) => (cell.meanPerDay === null ? null : { value: cell.meanPerDay, complete: cell.complete })),
  })).filter((line) => line.points.some((point) => point !== null));
}

function Chart(props: { days: readonly DayRecord[]; context: DayContext }): React.JSX.Element | null {
  const { days, context } = props;
  const available = useMemo(() => metricsWithData(days), [days]);
  const [metric, setMetric] = useState<Series>(available.guests ? 'guests' : 'netSales');
  const filters = useMemo<Filters>(() => ({ ...defaultFilters(days), metric }), [days, metric]);
  const lines = useMemo(() => yearLines(yearOverYear(analyticsInput(days, context, filters))), [days, context, filters]);
  if (lines.length === 0) return null;
  return (
    <Stack gap={12}>
      <MetricSwitch label="Show" value={metric} available={available} onChange={setMetric} nativeID="sales-month-metric" />
      <Small>{`Average ${METRIC_NOUN[metric]} per day in each month, one line per year.`}</Small>
      <LineChart metric={metric} lines={lines} />
      <Small>{basisLine(days, filters, context)}</Small>
    </Stack>
  );
}

export function MonthChart(props: MonthChartProps): React.JSX.Element | null {
  const { api } = usePortal();
  const [today] = useState(localToday);
  const { state, reload } = useLoad(useCallback(async () => {
    const [history, notes, rules] = await Promise.all([
      fetchSalesHistory(api, props.locationId),
      fetchNotes(api, props.locationId),
      fetchRules(api, props.locationId).then((list) => list.rules, () => NO_RULES),
    ]);
    return { days: decodeHistory(history), context: dayContext(notes, [], ruleSchedules(rules), today) };
  }, [api, props.locationId, today]));
  if (state.status === 'loading') return <LoadingLine text="Loading the chart" minHeight={280} />;
  if (state.status === 'failed') return <ErrorNotice error={state.error} onRetry={reload} />;
  return <Chart days={state.data.days} context={state.data.context} />;
}
