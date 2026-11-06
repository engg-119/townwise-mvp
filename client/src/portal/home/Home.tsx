import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { fetchCalendar, fetchSalesHistory, type Calendar, type SalesHistory } from '../analytics/api';
import { dayContext } from '../analytics/days';
import { metricsWithData } from '../analytics/filters';
import { byDate, decodeHistory } from '../analytics/history';
import { homeCalendarRange, lastWeekComparison, lateWeekShare, leadLine, monthFacts, thisWeek, type HomeInput } from '../analytics/week';
import { useBreakpoint, useLoad } from '../hooks';
import { fetchNotes, type Note } from '../locations/api';
import { localToday } from '../locations/dates';
import { LoadFailure, Loading } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, LinkButton } from '../ui/Button';
import { ReadOnlyLine, StatusTag } from '../ui/feedback';
import { Mono, Small } from '../ui/text';
import { BarOrder } from './BarOrder';
import { HistoryCard } from './HistoryCard';
import { LastWeek } from './LastWeek';
import { HistoryStep, needsHistory } from './onboarding';
import { ThisMonth } from './ThisMonth';
import { ThisWeek } from './ThisWeek';

// P11 Home (/locations/[id], members; home.md 2, spec 16.3), built around the Monday decisions: what is on the
// calendar this week and how the same week went before, the bar order (Planned), last week against the same week
// last year, this month in town, and the location's history. Until forecasts exist, Home shows only history and
// the calendar, never a guess: every figure is a sum, an average or a share of the location's own stored days, of a
// past day. It reads three routes in parallel (sales history, notes, the town calendar) and writes nothing, so
// view-as shows it unchanged with its upload links disabled. "Today" is the device's date; weeks run Monday to
// Sunday. While onboarding's needsHistory is true, 54's HistoryStep takes the place of the cards that need days.

const READ_ONLY_ID = 'home-ro';

export const FORECAST_LINE = 'Forecasts are in development. Until then, Home shows your history and the calendar, never a guess.';
/** F5 (build plan section 7) replaces this line with the count of TownwiseAI's open questions, once it exists. */
export const QUESTIONS_PLANNED = 'Questions from TownwiseAI about your days are planned.';

interface Data {
  history: SalesHistory;
  notes: Note[];
  calendar: Calendar;
}

function Tagline(props: { kind: 'progress' | 'planned'; text: string }): React.JSX.Element {
  return (
    <View style={styles.tagline}>
      <StatusTag kind={props.kind} label={props.kind === 'progress' ? 'In progress' : 'Planned'} />
      <Small>{props.text}</Small>
    </View>
  );
}

/** Two cards side by side from 1024px (columns `left` to `right`), one column below, ruled from the block above. */
function Row(props: { left: React.ReactNode; right: React.ReactNode; split: [number, number] }): React.JSX.Element {
  const { desktop } = useBreakpoint();
  return (
    <View style={[styles.ruled, desktop ? styles.row : styles.stacked]}>
      <View style={desktop ? { flex: props.split[0], minWidth: 0 } : null}>{props.left}</View>
      {props.right === null ? null : <View style={desktop ? { flex: props.split[1], minWidth: 0 } : null}>{props.right}</View>}
    </View>
  );
}

function HomeView(props: { data: Data; today: string; locationId: string; needs: boolean; readOnlyId: string | null; readOnlyText: string }): React.JSX.Element {
  const { data, today, locationId, needs, readOnlyId } = props;
  const { history, notes, calendar } = data;
  const days = useMemo(() => decodeHistory(history), [history]);
  const context = useMemo(() => dayContext(notes, calendar.events), [notes, calendar.events]);
  const metric = metricsWithData(days).guests ? 'guests' : 'netSales';
  const input = useMemo<HomeInput>(
    () => ({ today, byDate: byDate(days), context, metric, lastDate: history.coverage.lastDate }),
    [today, days, context, metric, history.coverage.lastDate],
  );
  const week = useMemo(() => thisWeek(input), [input]);
  const lastWeek = useMemo(() => lastWeekComparison(input), [input]);
  const share = useMemo(() => lateWeekShare(input), [input]);
  const facts = useMemo(() => monthFacts(input), [input]);
  const hasDays = days.length > 0;
  const { desktop } = useBreakpoint();

  return (
    <View>
      {readOnlyId === null ? null : <View style={styles.readOnly}><ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} /></View>}
      <View style={[styles.lead, desktop ? styles.leadWide : null]}>
        <View style={styles.leadText}>
          <Mono>{leadLine(history.coverage.lastDate, calendar)}</Mono>
          <Tagline kind="progress" text={FORECAST_LINE} />
          <Tagline kind="planned" text={QUESTIONS_PLANNED} />
        </View>
        <Actions><LinkButton variant="outline" href={locationHref(locationId, 'agent')} label="Ask TownwiseAI" /></Actions>
      </View>
      {needs ? <View style={styles.step}><HistoryStep /></View> : null}
      <View style={styles.block}>
        <ThisWeek week={week} calendar={calendar} metric={metric} history={hasDays} />
      </View>
      {needs ? null : (
        <Row
          split={[7, 5]}
          left={<BarOrder share={share} metric={metric} />}
          right={<LastWeek comparison={lastWeek} metric={metric} locationId={locationId} readOnlyId={readOnlyId} />}
        />
      )}
      <Row
        split={[8, 4]}
        left={<ThisMonth today={today} context={context} calendar={calendar} facts={facts} metric={metric} />}
        right={needs ? null : (
          <HistoryCard
            coverage={history.coverage}
            uploads={history.uploads}
            days={days}
            context={context}
            metric={metric}
            locationId={locationId}
            readOnlyId={readOnlyId}
          />
        )}
      />
    </View>
  );
}

export function Home(): React.JSX.Element {
  const { location, org } = useLocation();
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [today] = useState(localToday);
  const { state, reload } = useLoad(useCallback(async () => {
    const [history, notes, calendar] = await Promise.all([
      fetchSalesHistory(api, location.id),
      fetchNotes(api, location.id),
      fetchCalendar(api, location.id, homeCalendarRange(today)),
    ]);
    return { history, notes, calendar };
  }, [api, location.id, today]));
  if (state.status === 'loading') return <Loading text={`Loading ${location.name}`} minHeight={480} />;
  if (state.status === 'failed') return <LoadFailure error={state.error} onRetry={reload} />;
  // Native has no upload (D20), so nothing on this page writes there.
  const readOnlyId = readOnly && Platform.OS === 'web' ? READ_ONLY_ID : null;
  return (
    <HomeView
      key={location.id}
      data={state.data}
      today={today}
      locationId={location.id}
      needs={needsHistory(org, org.locations)}
      readOnlyId={readOnlyId}
      readOnlyText={line}
    />
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  readOnly: { marginBottom: theme.space[4] },
  lead: { gap: theme.space[4] },
  leadWide: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: theme.space.gutter },
  leadText: { gap: theme.space[2], flexShrink: 1, minWidth: 0 },
  tagline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  step: { marginTop: theme.space[8] },
  block: { marginTop: theme.space[8] },
  ruled: { marginTop: theme.space[8], paddingTop: theme.space[8], borderTopWidth: 1, borderTopColor: c.border },
  row: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  stacked: { gap: theme.space[8] },
});
