import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { Calendar } from '../analytics/api';
import { plainOf, strong, type Phrase } from '../analytics/phrase';
import {
  EVENT_WORDS, lastYearDayPhrase, nextEventWhen, summaryLabel, vsUsualPhrase, type LastWeek, type NextEvent, type ThisWeek,
} from '../analytics/week';
import { METRIC_NOUN, metricNumber, shortDate, signedPercent, type Metric } from '../analytics/words';
import { plural } from '../format';
import { UploadAction } from '../locations/parts';
import { Actions } from '../ui/Button';
import { Panel } from '../ui/layout';
import { PhraseParts } from '../ui/PhraseParts';
import { Eyebrow, Small } from '../ui/text';
import { BlockRow } from './Block';

// At a glance (spec P11): the three answers Home leads with on a Monday, each a tile with one big figure or title.
// This week, last year: the total of the same 7 days last year (This week's days, today first), against that year's
// usual, and their busiest and quietest days.
// Last week: its total against the same days last year. Next on the calendar: the next holiday or town event from
// today. Every figure is history, never a guess; the cards below carry the detail, the chart and the tables.

function Tile(props: { eyebrow: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Panel style={styles.tile}>
      <Eyebrow>{props.eyebrow}</Eyebrow>
      {props.children}
    </Panel>
  );
}

function Figure(props: { value: string; unit: string }): React.JSX.Element {
  return (
    <View style={styles.figure}>
      <Text style={styles.value}>{props.value}</Text>
      {props.unit === '' ? null : <Text style={styles.unit}>{props.unit}</Text>}
    </View>
  );
}

const unitOf = (metric: Metric): string => (metric === 'guests' ? 'guests' : METRIC_NOUN[metric]);

function ThisWeekTile(props: { week: ThisWeek; metric: Metric }): React.JSX.Element {
  const { summary } = props.week;
  if (summary === null) {
    return (
      <Tile eyebrow="This week, last year">
        <Small>Fewer than 5 of the same 7 days last year have data, so there is no total to show.</Small>
      </Tile>
    );
  }
  const usualLine = vsUsualPhrase(summary);
  return (
    <Tile eyebrow="This week, last year">
      <Figure value={metricNumber(summary.total, props.metric)} unit={unitOf(props.metric)} />
      <View style={styles.lines}>
        <Small white>{summaryLabel(summary)}</Small>
        {usualLine === null ? null : <Small><PhraseParts phrase={usualLine} /></Small>}
        {summary.busiest === null || summary.busiestValue === null ? null : (
          <Small><PhraseParts phrase={lastYearDayPhrase('Busiest', summary.busiest, summary.busiestValue, props.metric)} /></Small>
        )}
        {summary.quietest === null || summary.quietestValue === null ? null : (
          <Small><PhraseParts phrase={lastYearDayPhrase('Quietest', summary.quietest, summary.quietestValue, props.metric)} /></Small>
        )}
      </View>
    </Tile>
  );
}

/** The tile's short line for each state of the comparison, the change strong; the Last week card says it in full. */
export function lastWeekGlancePhrase(comparison: LastWeek, metric: Metric): Phrase {
  switch (comparison.state) {
    case 'no_history': return ['No sales history yet.'];
    case 'uploads_off': return ['Every sales upload is turned off.'];
    case 'no_recent': return [`Your sales stop at ${shortDate(comparison.lastDate)}.`];
    case 'no_days': return [`No ${METRIC_NOUN[metric]} stored for last week.`];
    case 'no_last_year': return ['No data for the same week last year.'];
    case 'no_overlap': return ['No day has data in both weeks.'];
    case 'compared': {
      const over = comparison.comparedDays === 7 ? 'over all 7 days' : `over the ${plural(comparison.comparedDays, 'day', 'days')} both weeks have`;
      const against = `the same week last year (${metricNumber(comparison.lastYearTotal, metric)})`;
      return comparison.change === null ? [`Against ${against}, ${over}.`] : [strong(signedPercent(comparison.change)), ` against ${against}, ${over}.`];
    }
  }
}

export function lastWeekGlance(comparison: LastWeek, metric: Metric): string {
  return plainOf(lastWeekGlancePhrase(comparison, metric));
}

function LastWeekTile(props: { comparison: LastWeek; metric: Metric; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { comparison, metric } = props;
  const stale = comparison.state === 'no_recent' || comparison.state === 'no_days';
  return (
    <Tile eyebrow="Last week">
      {comparison.state === 'compared' ? <Figure value={metricNumber(comparison.total, metric)} unit={unitOf(metric)} /> : null}
      <Small white><PhraseParts phrase={lastWeekGlancePhrase(comparison, metric)} /></Small>
      {stale ? (
        <Actions><UploadAction locationId={props.locationId} variant="link" readOnlyId={props.readOnlyId} /></Actions>
      ) : null}
    </Tile>
  );
}

function NextTile(props: { next: NextEvent | null; calendar: Calendar; until: string }): React.JSX.Element {
  const { next } = props;
  if (next === null) {
    return (
      <Tile eyebrow="Next on the calendar">
        <Small>{`Nothing on ${props.calendar.town.name}’s calendar through ${shortDate(props.until)}.`}</Small>
      </Tile>
    );
  }
  const { event } = next;
  const kind = event.kind === 'holiday' && event.scope === 'national' ? 'Federal holiday' : EVENT_WORDS[event.kind];
  return (
    <Tile eyebrow="Next on the calendar">
      <Text style={styles.title}>{event.title}</Text>
      <View style={styles.lines}>
        <Small white>{nextEventWhen(next)}</Small>
        <Small>{kind}</Small>
      </View>
    </Tile>
  );
}

export function Glance(props: {
  week: ThisWeek;
  lastWeek: LastWeek;
  next: NextEvent | null;
  calendar: Calendar;
  /** The last day Home reads the calendar for. */
  until: string;
  metric: Metric;
  locationId: string;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { metric } = props;
  return (
    <View role="region" aria-label="At a glance">
      <BlockRow
        tablet
        items={[
          { key: 'week', span: 4, node: <ThisWeekTile week={props.week} metric={metric} /> },
          { key: 'last', span: 4, node: <LastWeekTile comparison={props.lastWeek} metric={metric} locationId={props.locationId} readOnlyId={props.readOnlyId} /> },
          { key: 'next', span: 4, node: <NextTile next={props.next} calendar={props.calendar} until={props.until} /> },
        ]}
      />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  tile: { flexGrow: 1, gap: theme.space[3] },
  figure: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: theme.space[2] },
  value: { ...theme.type.valuePhone, color: c.white, fontVariant: ['tabular-nums'] },
  unit: { ...theme.type.mono, color: c.text2 },
  title: { ...theme.type.h3, color: c.white },
  lines: { gap: 2 },
});
