import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { lastChatStore } from '../../chat/lastChatStore';
import { theme } from '../../theme';
import { fetchCalendar, type ResearchedEvent } from '../analytics/api';
import { openAsAdminOrgId } from '../api';
import { errorCopy } from '../errors';
import { useWhenDone, useWhileRunning } from '../hooks';
import { addDays, localToday } from '../locations/dates';
import { usePortal, useReadOnly } from '../PortalProvider';
import {
  fetchResearch, runResearch, setResearch, updateResearchedEvent, type HiddenEvent, type Research,
} from '../research/api';
import { markSeen } from '../research/seen';
import { calendarHref } from '../routing';
import type { LocationSummary, OrgResponse } from '../schemas';
import { Button } from '../ui/Button';
import { ErrorNotice, LoadingLine, Notice, ReadOnlyLine, useNoticeState } from '../ui/feedback';
import { Section } from '../ui/layout';
import { Heading } from '../ui/text';
import { CompetitionCard } from './CompetitionCard';
import { EventItem, firstDay } from './EventItem';
import {
  entityLine, eventWhen, finishedNotice, gapLine, hiddenHeading, isLive, moreLine, nextLine, pressRefusal,
  RESEARCH_HEADING, RESEARCH_KICKER, RESEARCH_NOW, RESEARCH_NOW_HELP, RESEARCH_NOW_RUNNING, RESEARCH_STARTED, RESTORE,
  RESTORE_NOTICES, restoreLabel, runLine, SWITCH_FAILED, SWITCH_OPEN_AS_ADMIN, switchLabel, switchState, switchWords,
  topicLabel, topicState, WEEK_EMPTY, WEEK_FAILED, WEEK_HEADING, WEEK_MAX, WHO_HEADING,
} from './research-copy';

// P15's Research section (D66, OpenSpec change town-research-agent, design decision 15), under TownProfile: the town's
// and the location's research in topics with their states, the honest gaps, Research now (org admins, never under
// view-as or open as admin), the organization's research switch (org admins outside view-as; staff open as admin see
// it only while it is on, to turn it off), what research found for the coming week (each linking to its Calendar day),
// who and where, the events hidden by this location's team with Restore (sending the item's head), and the
// Competition card. While either run is live it re-reads GET .../research every 30 seconds (D65's useWhileRunning) and,
// when the run it saw ends, re-reads the organization in place (refreshOrg, for the dashboard's "Researching"), this
// week's events and the Competition card, and says what the run found.

const READ_ONLY_ID = 'research-read-only';

type Load<T> = { status: 'loading' } | { status: 'failed'; error: unknown } | { status: 'ready'; data: T };

/** What research found for today and the next 6 days (the Calendar's `found`); null when the API couldn't read it. */
function useWeekFound(locationId: string, tick: number): Load<ResearchedEvent[] | null> {
  const { api } = usePortal();
  const [state, setState] = useState<{ key: string; load: Load<ResearchedEvent[] | null> } | null>(null);
  const key = `${locationId}:${String(tick)}`;
  useEffect(() => {
    let live = true;
    const from = localToday();
    fetchCalendar(api, locationId, { from, to: addDays(from, 6) }).then(
      (calendar) => { if (live) setState({ key, load: { status: 'ready', data: calendar.found } }); },
      (error: unknown) => { if (live) setState({ key, load: { status: 'failed', error } }); },
    );
    return () => { live = false; };
  }, [api, locationId, key]);
  // The last answer stays while a re-read after a run loads.
  return state?.load ?? { status: 'loading' };
}

export function ResearchSection(props: { location: LocationSummary; org: OrgResponse }): React.JSX.Element {
  const { location, org } = props;
  const { api, me, refreshOrg } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [state, setState] = useState<Load<Research>>({ status: 'loading' });
  /** Bumped when a run the page saw ends: this week's events and the Competition card read again. */
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useNoticeState();

  const refresh = useCallback(async (): Promise<void> => {
    const research = await fetchResearch(api, location.id);
    setState({ status: 'ready', data: research });
  }, [api, location.id]);

  // The first read; a retry goes back to loading from its press.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchResearch(api, location.id).then(
      (data) => { if (live) setState({ status: 'ready', data }); },
      (error: unknown) => { if (live) setState({ status: 'failed', error }); },
    );
    return () => { live = false; };
  }, [api, location.id, attempt]);
  const retry = (): void => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  };

  const research = state.status === 'ready' ? state.data : null;
  const running = research !== null && (isLive(research.location) || isLive(research.town));
  const onDone = useCallback((): void => {
    setTick((value) => value + 1);
    refreshOrg().catch(() => undefined);
  }, [refreshOrg]);
  useWhileRunning(running, refresh, { onDone });
  // The location's run a person saw end says what it found, once.
  const locationRun = research?.location ?? null;
  const onLocationDone = useCallback((): void => {
    const words = finishedNotice(locationRun);
    if (words !== null) setNotice(words);
  }, [locationRun, setNotice]);
  useWhenDone(isLive(locationRun), onLocationDone);
  // Opening the Town tab clears the Calendar's research banner for the run it shows (research/seen.ts), as Dismiss does.
  const startedAt = locationRun?.startedAt;
  useEffect(() => {
    if (startedAt !== undefined) void markSeen(lastChatStore, me.user.id, location.id, { startedAt });
  }, [me.user.id, location.id, startedAt]);

  const week = useWeekFound(location.id, tick);

  if (state.status === 'loading') {
    return (
      <Section kicker={RESEARCH_KICKER} title={RESEARCH_HEADING}>
        <LoadingLine text="Loading town research" minHeight={48} />
      </Section>
    );
  }
  if (state.status === 'failed') {
    return (
      <Section kicker={RESEARCH_KICKER} title={RESEARCH_HEADING}>
        <ErrorNotice error={state.error} onRetry={retry} />
      </Section>
    );
  }
  const data = state.data;
  const admin = org.role === 'org_admin';
  const viewAs = me.viewAs !== null;
  const openAsAdmin = openAsAdminOrgId(me) !== null;
  const next = nextLine(data.next);

  return (
    <View style={styles.column}>
      <Section kicker={RESEARCH_KICKER} title={RESEARCH_HEADING}>
        <View style={styles.block}>
          {location.town.townId === null ? null : (
            <RunBlock line={runLine({ kind: 'town', name: location.town.name }, data.town)} threads={data.town?.threads ?? []} live={isLive(data.town)} />
          )}
          <RunBlock line={runLine({ kind: 'location' }, data.location)} threads={data.location?.threads ?? []} live={isLive(data.location)} />
          {next === null ? null : <Text style={styles.help}>{next}</Text>}
          {data.gaps.map((gap) => (
            <Text key={gap} style={styles.body}>
              {gapLine(gap, { town: location.town.name, admin, on: data.on, available: data.available })}
            </Text>
          ))}
          {notice === null ? null : <Notice text={notice.text} result={notice} stays={notice.stays} />}
          {admin && !viewAs && !openAsAdmin ? (
            <ResearchNow locationId={location.id} research={data} running={running} onStarted={refresh} setNotice={setNotice} />
          ) : null}
        </View>
      </Section>

      <Section title={WEEK_HEADING}>
        <WeekList locationId={location.id} week={week} />
      </Section>

      {data.entities.length === 0 ? null : (
        <Section title={WHO_HEADING}>
          <View role="list" style={styles.list}>
            {data.entities.map((entity) => (
              <View key={entity.id} role="listitem" style={styles.item}>
                <Text style={styles.itemTitle}>{entity.name}</Text>
                <Text style={styles.help}>{entityLine(entity)}</Text>
              </View>
            ))}
          </View>
        </Section>
      )}

      {data.hidden.length === 0 ? null : (
        <Section title={hiddenHeading(data.hidden.length)}>
          <HiddenList locationId={location.id} hidden={data.hidden} readOnly={readOnly} line={line} onChanged={refresh} setNotice={setNotice} />
        </Section>
      )}

      <CompetitionCard location={location} org={org} tick={tick} />

      {admin && !viewAs && (!openAsAdmin || data.on) ? (
        <Section>
          <ResearchSwitch town={location.town.name} research={data} onSwitched={(on) => {
            setState({ status: 'ready', data: { ...data, on } });
            refresh().catch(() => undefined);
          }} />
        </Section>
      ) : null}
    </View>
  );
}

/** A run's line and each of its topics with its state. */
function RunBlock(props: { line: string; threads: readonly { thread: string; status: string; code: string | null }[]; live: boolean }): React.JSX.Element {
  return (
    <View style={styles.run}>
      <Text style={styles.itemTitle} {...(props.live ? { role: 'status' as const } : {})}>{props.line}</Text>
      {props.threads.length === 0 ? null : (
        <View role="list" style={styles.topics}>
          {props.threads.map((thread) => (
            <Text key={thread.thread} role="listitem" style={styles.help}>{`${topicLabel(thread.thread)}: ${topicState(thread)}`}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

function ResearchNow(props: {
  locationId: string; research: Research; running: boolean; onStarted: () => Promise<void>;
  setNotice: (text: string | null, stays?: boolean) => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { setNotice } = props;
  const [pressing, setPressing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = props.research.on && props.research.available && !props.running;
  const press = (): void => {
    if (pressing || !usable) return;
    setPressing(true);
    setError(null);
    runResearch(api, props.locationId).then(
      async () => {
        setNotice(RESEARCH_STARTED);
        await props.onStarted().catch(() => undefined);
      },
      (failure: unknown) => {
        const words = failure instanceof ApiError && failure.kind === 'http' ? pressRefusal(failure.status, failure.code) : null;
        setError(words ?? errorCopy(failure));
        // A run someone else started shows at once.
        if (failure instanceof ApiError && failure.status === 409) props.onStarted().catch(() => undefined);
      },
    ).finally(() => { setPressing(false); });
  };
  return (
    <View style={styles.block}>
      <Text style={styles.help}>{props.running ? RESEARCH_NOW_RUNNING : RESEARCH_NOW_HELP}</Text>
      <View style={styles.actions}>
        <Button variant="outline" label={RESEARCH_NOW} disabled={pressing || !usable} onPress={press} />
      </View>
      {error === null ? null : <ErrorNotice message={error} />}
    </View>
  );
}

function WeekList(props: { locationId: string; week: Load<ResearchedEvent[] | null> }): React.JSX.Element {
  const { week } = props;
  if (week.status === 'loading') return <LoadingLine text="Loading this week" minHeight={48} />;
  if (week.status === 'failed' || week.data === null) return <Text style={styles.body}>{WEEK_FAILED}</Text>;
  // Each event on its first day this week (a season that began earlier, or a weekly market, is not listed by its start).
  const from = localToday();
  const to = addDays(from, 6);
  const events = week.data
    .flatMap((event) => {
      const day = firstDay(event, from, to);
      return day === null ? [] : [{ event, day }];
    })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.event.title < b.event.title ? -1 : 1));
  if (events.length === 0) return <Text style={styles.body}>{WEEK_EMPTY}</Text>;
  const shown = events.slice(0, WEEK_MAX);
  const more = moreLine(events.length - shown.length);
  return (
    <View style={styles.block}>
      <View role="list" style={styles.list}>
        {shown.map(({ event, day }) => <EventItem key={event.id} locationId={props.locationId} event={event} day={day} />)}
      </View>
      {more === null ? null : <Link href={calendarHref(props.locationId)} style={styles.link}>{more}</Link>}
    </View>
  );
}

function HiddenList(props: {
  locationId: string; hidden: readonly HiddenEvent[]; readOnly: boolean; line: string; onChanged: () => Promise<void>;
  setNotice: (text: string | null, stays?: boolean) => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { setNotice, onChanged } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const restore = (event: HiddenEvent): void => {
    if (busy !== null || props.readOnly) return;
    setBusy(event.id);
    setError(null);
    updateResearchedEvent(api, props.locationId, event.id, { op: 'restore', basedOn: event.head }).then(
      (result) => {
        setNotice(result.status === 'saved' ? RESTORE_NOTICES.restored : RESTORE_NOTICES.changedSince, result.status !== 'saved');
        return onChanged();
      },
      (failure: unknown) => {
        if (failure instanceof ApiError && failure.status === 404) {
          setNotice(RESTORE_NOTICES.gone, true);
          return onChanged();
        }
        setError(failure);
        return undefined;
      },
    ).catch(() => undefined).finally(() => { setBusy(null); });
  };
  return (
    <View style={styles.block}>
      <ReadOnlyLine text={props.line} nativeID={READ_ONLY_ID} />
      <View role="list" style={styles.list}>
        {props.hidden.map((event) => (
          <View key={event.id} role="listitem" style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.itemTitle}>{event.title}</Text>
              <Text style={styles.help}>{eventWhen({ start: event.start, end: event.end, startTime: null })}</Text>
            </View>
            <Button
              variant="outline"
              label={RESTORE}
              accessibilityLabel={restoreLabel(event.title)}
              disabled={props.readOnly || busy !== null}
              {...(props.readOnly ? { describedBy: READ_ONLY_ID } : {})}
              onPress={() => { restore(event); }}
            />
          </View>
        ))}
      </View>
      {error === null ? null : <ErrorNotice error={error} />}
    </View>
  );
}

function ResearchSwitch(props: { town: string; research: Research; onSwitched: (on: boolean) => void }): React.JSX.Element {
  const { api, me } = usePortal();
  const { research, onSwitched } = props;
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orgId = openAsAdminOrgId(me);
  const press = (): void => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    setResearch(api, !research.on, orgId).then(
      (now) => { onSwitched(now); },
      () => { setError(SWITCH_FAILED); },
    ).finally(() => { setSwitching(false); });
  };
  return (
    <View style={styles.block}>
      <Heading>{RESEARCH_HEADING}</Heading>
      <Text style={styles.body}>
        {switchWords(props.town)}{' '}
        <Link href="/privacy" style={styles.link}>Privacy</Link>
      </Text>
      <Text style={styles.body}>{switchState(research.on, research.available)}</Text>
      <View style={styles.actions}>
        <Button variant="outline" label={switchLabel(research.on)} disabled={switching} onPress={press} />
      </View>
      {orgId === null ? null : <Text style={styles.help}>{SWITCH_OPEN_AS_ADMIN}</Text>}
      {error === null ? null : <ErrorNotice message={error} />}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  column: { gap: 0 },
  block: { gap: theme.space[3] },
  run: { gap: theme.space[1] },
  topics: { gap: 2, paddingLeft: theme.space[3] },
  list: { gap: theme.space[3] },
  item: { gap: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[2] },
  rowText: { flexShrink: 1, gap: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2], alignItems: 'center' },
  itemTitle: { ...theme.type.small, color: c.white },
  body: { ...theme.type.small, color: c.text2 },
  help: { ...theme.type.small, color: c.text3 },
  link: { color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
});
