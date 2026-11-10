import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { loadAgentPanel } from '../../chat/api';
import { theme } from '../../theme';
import { fetchCalendar, fetchSalesHistory, type Calendar, type SalesHistory } from '../analytics/api';
import { dayContext } from '../analytics/days';
import { metricsWithData } from '../analytics/filters';
import { byDate, decodeHistory } from '../analytics/history';
import { homeCalendarRange, lastWeekComparison, lateWeekShare, leadLine, monthFacts, nextEvent, thisWeek, type HomeInput } from '../analytics/week';
import { useBreakpoint, useLoad } from '../hooks';
import { fetchNotes, type Note } from '../locations/api';
import { localToday } from '../locations/dates';
import { formatCount } from '../format';
import { LoadFailure, Loading } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, LinkButton } from '../ui/Button';
import { ReadOnlyLine, StatusTag } from '../ui/feedback';
import { Mono, Small } from '../ui/text';
import { BarOrder } from './BarOrder';
import { BlockRow, GUTTER } from './Block';
import { Glance } from './Glance';
import { HistoryCard } from './HistoryCard';
import { LastWeek } from './LastWeek';
import { HistoryStep, needsHistory } from './onboarding';
import { MonthList, PastYears, ThisMonth, WhoIsInTown } from './ThisMonth';
import { ThisWeek } from './ThisWeek';

// P11 Home (/locations/[id], members; spec 16.3), a dashboard built around the Monday decisions. Under the lead, a
// grid of blocks (Block.tsx), most practical first: At a glance (this week last year, last week, the next event);
// This week in {Town}, day by day; This month, a calendar you can open a day of, beside Last week; the month's
// events beside Who's in town; this month in past years beside the bar order (Planned); and the location's history. Until forecasts exist, Home
// shows only history and the calendar, never a guess: every figure is a sum, an average or a share of the
// location's own stored days, of a past day. It reads three routes in parallel (sales history, notes, the town
// calendar), then on their own TownwiseAI's questions (for the lead's count) and the month's people in town (in Who's
// in town), and writes nothing, so view-as shows it unchanged with its upload links disabled. "Today" is the
// device's date; weeks run Monday to Sunday. While onboarding's needsHistory is true, its HistoryStep takes the
// place of the blocks that need days, and when it has read the history Home loads again.

const READ_ONLY_ID = 'home-ro';

export const FORECAST_LINE = 'Forecasts are in development. Until then, Home shows your history and the calendar, never a guess.';

/** "2 questions from TownwiseAI": the lead's link to its page (spec P11). */
export function questionsLabel(count: number): string {
  return `${count === 1 ? '1 question' : `${formatCount(count)} questions`} from TownwiseAI`;
}

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

/**
 * The count of TownwiseAI's open questions (GET .../agent, its side panel's read), linked to its page. It reads on its
 * own, so Home never waits for it or fails with it: while it loads, when the read fails and when there are none, the
 * lead shows nothing here (the page itself says "No questions right now" or the error).
 */
function QuestionsLink(props: { locationId: string }): React.JSX.Element | null {
  const { api } = usePortal();
  const { locationId } = props;
  const { state } = useLoad(useCallback(() => loadAgentPanel(api, locationId), [api, locationId]));
  if (state.status !== 'ready' || state.data.questions.length === 0) return null;
  return <LinkButton href={locationHref(locationId, 'agent')} label={questionsLabel(state.data.questions.length)} />;
}

function HomeView(props: {
  data: Data; today: string; locationId: string; needs: boolean; readOnlyId: string | null; readOnlyText: string; onHistory: () => void;
}): React.JSX.Element {
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
  const next = useMemo(() => nextEvent(today, context), [today, context]);
  const hasDays = days.length > 0;
  const { desktop } = useBreakpoint();

  return (
    <View style={styles.page}>
      {readOnlyId === null ? null : <ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} />}
      <View style={[styles.lead, desktop ? styles.leadWide : null]}>
        <View style={styles.leadText}>
          <Mono>{leadLine(history.coverage.lastDate, calendar)}</Mono>
          <Tagline kind="progress" text={FORECAST_LINE} />
          <QuestionsLink locationId={locationId} />
        </View>
        <Actions><LinkButton variant="outline" href={locationHref(locationId, 'agent')} label="Ask TownwiseAI" /></Actions>
      </View>
      {needs ? <HistoryStep onDone={props.onHistory} /> : null}
      {needs || !hasDays ? null : (
        <Glance
          week={week}
          lastWeek={lastWeek}
          next={next}
          calendar={calendar}
          until={homeCalendarRange(today).to}
          metric={metric}
          locationId={locationId}
          readOnlyId={readOnlyId}
        />
      )}
      <ThisWeek week={week} calendar={calendar} metric={metric} history={hasDays} />
      <BlockRow
        items={[
          { key: 'month', span: 8, node: <ThisMonth input={input} calendar={calendar} history={hasDays} /> },
          { key: 'last', span: 4, node: needs ? null : <LastWeek comparison={lastWeek} metric={metric} locationId={locationId} readOnlyId={readOnlyId} /> },
        ]}
      />
      <BlockRow
        items={[
          { key: 'list', span: 6, node: <MonthList today={today} context={context} /> },
          { key: 'people', span: 6, node: <WhoIsInTown today={today} calendar={calendar} locationId={locationId} /> },
        ]}
      />
      <BlockRow
        items={[
          { key: 'years', span: 6, node: facts.length === 0 ? null : <PastYears today={today} facts={facts} metric={metric} /> },
          { key: 'bar', span: 6, node: needs ? null : <BarOrder share={share} metric={metric} /> },
        ]}
      />
      {needs ? null : (
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
      // The step also leaves once Home's own fresh history has days, whichever of the two reloads answers first.
      needs={needsHistory(org, org.locations) && state.data.history.coverage.dayCount === 0}
      onHistory={reload}
      readOnlyId={readOnlyId}
      readOnlyText={line}
    />
  );
}

const styles = StyleSheet.create({
  page: { gap: GUTTER },
  lead: { gap: theme.space[4], marginBottom: theme.space[4] },
  leadWide: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: theme.space.gutter },
  leadText: { gap: theme.space[2], flexShrink: 1, minWidth: 0 },
  tagline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
});
