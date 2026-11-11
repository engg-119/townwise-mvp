import { dayMonth, lastWeekLine, type LastWeek as Comparison } from '../analytics/week';
import { metricNumber, shortDate, signedPercent, type Metric } from '../analytics/words';
import { ShowNumbers, UploadAction } from '../locations/parts';
import { Actions } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { Small } from '../ui/text';
import { Block } from './Block';
import { LastWeekChart } from './LastWeekChart';

// Last week (home.md 2.4): last week, Monday to Sunday, against the same weekdays 52 weeks earlier. Until a
// forecast exists this is history against history, never against a prediction. The totals and the change are over
// the days that have the metric in both weeks, and the summary says how many. Web draws the pairs; native has the
// text and the table (D21).

export function LastWeek(props: {
  comparison: Comparison;
  metric: Metric;
  locationId: string;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { comparison, metric } = props;
  const range = comparison.state === 'no_history' || comparison.state === 'uploads_off' ? null : `${dayMonth(comparison.monday)} to ${dayMonth(comparison.sunday)}`;
  const days = comparison.state === 'compared' || comparison.state === 'no_last_year' || comparison.state === 'no_overlap' ? comparison.days : null;
  const number = (value: number | null): string => (value === null ? 'No data' : metricNumber(value, metric));
  return (
    <Block label="Last week" eyebrow={range === null ? 'Last week' : `Last week, ${range}`} title="Against the same week last year">
      {comparison.state === 'compared' ? <LastWeekChart days={comparison.days} metric={metric} /> : null}
      <Small white>{lastWeekLine(comparison, metric)}</Small>
      {comparison.state === 'no_recent' || comparison.state === 'no_days' ? (
        <Actions><UploadAction locationId={props.locationId} variant="link" readOnlyId={props.readOnlyId} /></Actions>
      ) : null}
      {days === null ? null : (
        <ShowNumbers>
          <DataTable
            label="Last week against the same week last year"
            columns={[
              { key: 'day', label: 'Day', flex: 1.4 }, { key: 'week', label: 'Last week', numeric: true },
              { key: 'year', label: 'Last year', numeric: true }, { key: 'change', label: 'Change', numeric: true },
            ]}
            rows={days.map((day) => ({
              key: day.date,
              cells: {
                day: shortDate(day.date),
                week: number(day.value),
                year: number(day.lastYear),
                change: day.value === null || day.lastYear === null || day.lastYear === 0 ? 'None' : signedPercent(day.value / day.lastYear - 1),
              },
            }))}
          />
        </ShowNumbers>
      )}
    </Block>
  );
}
