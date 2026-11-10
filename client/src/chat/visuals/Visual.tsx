import { Platform, StyleSheet, Text, View } from 'react-native';

import { BarChart } from '../../portal/analytics/AnalyticsCharts';
import { ShowNumbers } from '../../portal/locations/parts';
import { DataTable } from '../../portal/ui/DataTable';
import { Small } from '../../portal/ui/text';
import { theme } from '../../theme';
import { DailyChart } from './DailyChart';
import { MetricCards } from './MetricCards';
import type { Visual } from './schema';
import { barShortLabel, NATIVE_CHART, unitsOf, visualRows, visualSummary, visualTitle } from './words';

// One visual under a reply (tuning-chat.md, show_visual): a square block with its title, the chart (web; native says
// where it is), the summary in words and "Show the numbers". A days table is the table itself; metrics are cards.

const C = theme.color;

function Chart(props: { visual: Visual }): React.JSX.Element | null {
  const { visual } = props;
  if (visual.kind === 'daily') return <DailyChart visual={visual} />;
  if (visual.kind !== 'breakdown') return null;
  if (Platform.OS !== 'web') return <Small>{NATIVE_CHART}</Small>;
  const manyYears = new Set(visual.bars.map((bar) => bar.key.slice(0, 4))).size > 1;
  const bars = visual.bars.map((bar) => ({
    label: barShortLabel(bar.key, visual.by === 'month' && manyYears),
    value: bar.value === null ? null : unitsOf(bar.value, visual.metric),
  }));
  return <BarChart bars={bars} metric={visual.metric} />;
}

export function VisualView(props: { visual: Visual }): React.JSX.Element {
  const { visual } = props;
  const title = visualTitle(visual);
  const summary = visualSummary(visual);
  const { columns, rows } = visualRows(visual);
  return (
    <View style={styles.block}>
      <Text style={styles.title}>{title}</Text>
      {visual.kind === 'metrics' ? <MetricCards visual={visual} /> : null}
      {visual.kind === 'days_table' ? <DataTable label={title} columns={columns} rows={rows} /> : null}
      <Chart visual={visual} />
      {summary === null ? null : <Text style={styles.summary}>{summary}</Text>}
      {visual.kind === 'daily' || visual.kind === 'breakdown' ? (
        <ShowNumbers><DataTable label={title} columns={columns} rows={rows} /></ShowNumbers>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[3], padding: theme.space[4], backgroundColor: C.panel, borderWidth: 1, borderColor: C.border },
  title: { ...theme.type.ui, color: C.white },
  summary: { ...theme.type.small, color: C.text2 },
});
