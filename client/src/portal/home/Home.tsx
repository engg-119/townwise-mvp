import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { loadAgentPanel } from '../../chat/api';
import { theme } from '../../theme';
import { fetchCalendar, fetchSalesHistory, type Calendar, type SalesHistory } from '../analytics/api';
import { dayContext, ruleSchedules } from '../analytics/days';
import { metricsWithData } from '../analytics/filters';
import { byDate, decodeHistory } from '../analytics/history';
import {
  forecastRange, homeCalendarRange, lastWeekComparison, lastWeekRange, lateWeekShare, leadLine, monthFacts, nextEvent, thisWeek, type HomeInput,
} from '../analytics/week';
import { fetchOwnerCalendarEvents, type OwnerCalendarEvent } from '../calendar/api';
import { ALL_FILTERS, type CalendarInput } from '../calendar/model';
import { fetchForecast } from '../estimates/api';
import { useBreakpoint, useLoad } from '../hooks';
import { fetchNotes, type Note } from '../locations/api';
import { localToday } from '../locations/dates';
import { shownLocationName } from '../locations/naming';
import { formatCount } from '../format';
import { LoadFailure } from '../locations/parts';
import { fetchOrderBoard } from '../orders/api';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { fetchRules, type Rule } from '../rules/api';
import { useLocation } from '../shell/LocationShell';
import { HomeSkeleton } from '../skeleton';
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
// This week in {Town}, day by day; This month, a calendar whose days open in the Calendar (P28), beside Last week; the
// month's events beside Who's in town; this month in past years beside the bar order; and the location's
// history. Every figure is a sum, an average or a share of the location's own stored days, of a past day, except This
// month's days from today on, which show the published forecast's own figures (spec 16.3 P11, 14.5,
// D30), At a glance's This week, which adds up This week's seven forecast figures with no range (D43), and Last
// week's published forecast for its seven days (D42), never an unpublished guess of Home's: with no
// published forecast the lead says so and those days show none. It reads three
// routes in parallel (sales history, notes, the town calendar), then on their own TownwiseAI's questions (for the
// lead's count), the location's business rules (a schedule with more or fewer guests says a near-empty day was open,
// D31 and D32, as on the Calendar and Analytics; none while they load or if the read fails), this month's forecast
// (GET .../forecast; Home never waits for it or fails with it), Last week's forecast (the same route for the seven days
// before today, D42; likewise on its own), the month's people in town (in Who's in town) and the
// next orders (GET .../orders, read once here for Bar order and the selected day's Reorder part), the events of the
// location's own calendars over the forecast's range (D49: this month and This week's days past it, under the events
// route's 92 days; none while they load or if the read fails), and writes nothing, so view-as shows it unchanged with
// its upload links disabled. This week, This month (its grid, tooltip and day detail) and the month's list read one
// CalendarInput, the Calendar's, through the shared entries helper (calendar/entries.ts).
// "Today" is the device's date; This week in {Town} is the seven days from today, today first, and Last week the
// seven days before today. While onboarding's needsHistory is true, its HistoryStep
// takes the place of the blocks that need days, and when it has read the history Home loads again.

const READ_ONLY_ID = 'home-ro';
const NO_RULES: readonly Rule[] = [];
const NO_EVENTS: readonly OwnerCalendarEvent[] = [];

/** The lead's In progress line while no forecast is published. `locationName` is the shown name (shownLocationName). */
export function forecastLine(locationName: string): string {
  return `Townwise hasn’t published a forecast for ${locationName} yet. Until then, Home shows your history and the calendar, never a guess.`;
}

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
 * The count of TownwiseAI's open questions, weekly suggestions and suggested rules (GET .../agent, its side panel's read), linked to its page. It reads on its
 * own, so Home never waits for it or fails with it: while it loads, when the read fails and when there are none, the
 * lead shows nothing here (the page itself says "No questions right now" or the error).
 */
function QuestionsLink(props: { locationId: string }): React.JSX.Element | null {
  const { api } = usePortal();
  const { locationId } = props;
  const { state } = useLoad(useCallback(() => loadAgentPanel(api, locationId), [api, locationId]));
  // Weekly suggestions (openspec change weekly-forecast-suggestions) and suggested rules (D46) count as questions: each
  // asks the owner to decide.
  const count = state.status === 'ready' ? state.data.questions.length + state.data.suggestions.length + state.data.ruleSuggestions.length : 0;
  if (count === 0) return null;
  // ?panel=questions: the page opens with its questions showing.
  return <LinkButton href={`${locationHref(locationId, 'agent')}?panel=questions`} label={questionsLabel(count)} />;
}

function HomeView(props: {
  data: Data; rules: readonly Rule[]; today: string; locationId: string; locationName: string; needs: boolean; readOnlyId: string | null;
  readOnlyText: string; onHistory: () => void;
}): React.JSX.Element {
  const { data, rules, today, locationId, needs, readOnlyId } = props;
  const { api } = usePortal();
  // This month's published forecast, on its own: while it loads or when it fails, Home shows no forecast figure and
  // the lead keeps the not-published line.
  // It covers This week's seven days too, which can run into next month.
  const forecastRead = useLoad(useCallback(() => fetchForecast(api, locationId, forecastRange(today)), [api, locationId, today])).state;
  const forecast = forecastRead.status === 'ready' ? forecastRead.data : null;
  // A published run that doesn't cover this month is still published, so the line would be wrong there.
  const notPublished = forecast === null || (!forecast.available && forecast.reason === 'no_published_forecast');
  // Last week's published forecast, on its own too (D42): while it loads, when it fails, and with none published or
  // covering none of its days, Last week and its tile are exactly the history comparison.
  const lastWeekRead = useLoad(useCallback(() => fetchForecast(api, locationId, lastWeekRange(today)), [api, locationId, today])).state;
  const lastWeekForecast = lastWeekRead.status === 'ready' ? lastWeekRead.data : null;
  const { history, notes, calendar } = data;
  // The location's own calendars' events, on their own (D49): until they load, or if they can't, Home shows none.
  const eventsRead = useLoad(useCallback(() => fetchOwnerCalendarEvents(api, locationId, forecastRange(today)), [api, locationId, today])).state;
  const imported = eventsRead.status === 'ready' ? eventsRead.data : NO_EVENTS;
  // One read of the board for Bar order and the selected day's Reorder part; it fails on its own, in their places.
  const { state: board } = useLoad(useCallback(() => fetchOrderBoard(api, locationId), [api, locationId]));
  const days = useMemo(() => decodeHistory(history), [history]);
  // With the town's today, so only a day before it can be likely closed (D32): today's upload may be partial.
  const context = useMemo(() => dayContext(notes, calendar.events, ruleSchedules(rules), today), [notes, calendar.events, rules, today]);
  const metric = metricsWithData(days).guests ? 'guests' : 'netSales';
  const input = useMemo<HomeInput>(
    () => ({ today, byDate: byDate(days), context, metric, lastDate: history.coverage.lastDate, uploadsOff: history.uploadsOff === true }),
    [today, days, context, metric, history.coverage.lastDate, history.uploadsOff],
  );
  // The one CalendarInput every Home calendar surface reads (D49), as the Calendar builds its own.
  const entries = useMemo<CalendarInput>(() => ({
    today, covered: forecastRange(today), forecast, salesDays: [...input.byDate.values()], events: calendar.events, notes, rules, imported,
    filters: ALL_FILTERS,
  }), [today, forecast, input.byDate, calendar.events, notes, rules, imported]);
  const week = useMemo(() => thisWeek(input, entries), [input, entries]);
  const lastWeek = useMemo(() => lastWeekComparison(input, lastWeekForecast), [input, lastWeekForecast]);
  const share = useMemo(() => lateWeekShare(input), [input]);
  const facts = useMemo(() => monthFacts(input), [input]);
  const next = useMemo(() => nextEvent(today, context), [today, context]);
  const hasDays = days.length > 0;
  const { desktop } = useBreakpoint();
  // With a published forecast for last week, Show the numbers has six columns (Forecast and In range join), which a
  // third of the row can't hold from 1024px, so Last week takes a line of its own under This month.
  const wideLastWeek = lastWeek.forecast !== undefined;

  return (
    <View style={styles.page}>
      {readOnlyId === null ? null : <ReadOnlyLine text={props.readOnlyText} nativeID={readOnlyId} />}
      <View style={[styles.lead, desktop ? styles.leadWide : null]}>
        <View style={styles.leadText}>
          <Mono>{leadLine(history.coverage.lastDate, calendar, history.uploadsOff === true)}</Mono>
          {notPublished ? <Tagline kind="progress" text={forecastLine(props.locationName)} /> : null}
          <QuestionsLink locationId={locationId} />
        </View>
        <Actions><LinkButton variant="outline" href={locationHref(locationId, 'agent')} label="Ask TownwiseAI" /></Actions>
      </View>
      {needs ? <HistoryStep onDone={props.onHistory} /> : null}
      {needs || !hasDays ? null : (
        <Glance
          week={week}
          forecast={forecast?.available === true ? forecast : null}
          forecastLoading={forecastRead.status === 'loading'}
          lastWeek={lastWeek}
          next={next}
          calendar={calendar}
          until={homeCalendarRange(today).to}
          metric={metric}
          locationId={locationId}
          readOnlyId={readOnlyId}
        />
      )}
      <ThisWeek week={week} calendar={calendar} metric={metric} history={hasDays} forecast={forecast?.available === true ? forecast : null} />
      <BlockRow
        items={[
          {
            key: 'month', span: wideLastWeek ? 12 : 8,
            node: (
              <ThisMonth
                input={input} calendar={calendar} entries={entries} forecast={forecast} history={hasDays} locationId={locationId} board={board}
              />
            ),
          },
          { key: 'last', span: wideLastWeek ? 12 : 4, node: needs ? null : <LastWeek comparison={lastWeek} metric={metric} locationId={locationId} readOnlyId={readOnlyId} /> },
        ]}
      />
      <BlockRow
        items={[
          { key: 'list', span: 6, node: <MonthList today={today} entries={entries} /> },
          { key: 'people', span: 6, node: <WhoIsInTown today={today} calendar={calendar} locationId={locationId} /> },
        ]}
      />
      <BlockRow
        items={[
          { key: 'years', span: 6, node: facts.length === 0 ? null : <PastYears today={today} facts={facts} metric={metric} /> },
          { key: 'bar', span: 6, node: needs ? null : <BarOrder share={share} metric={metric} locationId={locationId} board={board} /> },
        ]}
      />
      {needs ? null : (
        <HistoryCard
          coverage={history.coverage}
          uploadsOff={history.uploadsOff === true}
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
  // On their own and never in the way: until they load, or if they can't, Home reads as if there were none.
  const { state: rulesState } = useLoad(useCallback(() => fetchRules(api, location.id), [api, location.id]));
  const rules = rulesState.status === 'ready' ? rulesState.data.rules : NO_RULES;
  if (state.status === 'loading') return <HomeSkeleton label={`Loading ${shownLocationName(location, org)}`} />;
  if (state.status === 'failed') return <LoadFailure error={state.error} onRetry={reload} />;
  // Native has no upload (D20), so nothing on this page writes there.
  const readOnlyId = readOnly && Platform.OS === 'web' ? READ_ONLY_ID : null;
  return (
    <HomeView
      key={location.id}
      data={state.data}
      rules={rules}
      today={today}
      locationId={location.id}
      locationName={shownLocationName(location, org)}
      // The step also leaves once Home's own fresh history has days, whichever of the two reloads answers first.
      needs={needsHistory(org, org.locations) && state.data.history.coverage.dayCount === 0 && state.data.history.uploadsOff !== true}
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
