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
  entityLine, eventWhen, finishedNotice, gapLine, hiddenHeading, isLive, moreLine, nextLine, pressOpensLine, pressRefusal,
  RESEARCH_HEADING, RESEARCH_KICKER, RESEARCH_NOW, RESEARCH_NOW_HELP, RESEARCH_NOW_RUNNING, RESEARCH_STARTED, RESTORE,
  RESTORE_NOTICES, restoreLabel, runLine, SWITCH_FAILED, SWITCH_OPEN_AS_ADMIN, switchLabel, switchState, switchWords,
  topicLabel, topicState, townHolds, WEEK_EMPTY, WEEK_FAILED, WEEK_HEADING, WEEK_MAX, WEEK_OFF, WHO_HEADING,
} from './research-copy';

// P15's Research section (D66, OpenSpec change town-research-agent, design decision 15), under TownProfile: the town's
// and the location's research in topics with their states, the honest gaps, Research now (org admins, never under
// view-as or open as admin), the organization's research switch (org admins outside view-as; staff open as admin see
// it only while it is on, to turn it off), what research found for the coming week (each linking to its Calendar day),
// who and where, the events hidden by this location's team with Restore (sending the item's head), and the
// Competition card. While either run is live it re-reads GET .../research every 30 seconds (D65's useWhileRunning) and,
// when the run it saw ends, re-reads the organization in place (refreshOrg, for the dashboard's "Researching"), this
// week's events and the Competition card, and says what the run found. Turning the switch re-reads those two as well,
// and while it is off the week reads the off line, not "nothing found". Within 6 hours of the last run (`pressAt`)
// Research now is disabled and says when it opens again, re-enabling itself then.

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
  /** Bumped when a run the page saw ends or the switch changes: this week's events and the Competition card read again. */
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
  // Research off for the organization (or not running here): a live run is paused, so nothing is polled and the run
  // lines say paused, not running (the sweep leaves a switched-off organization's run as it is).
  const active = research !== null && research.on && research.available;
  const running = active && (isLive(research.location) || isLive(research.town));
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
  // The Town tab clears the Calendar's research banner for the run it shows (research/seen.ts), as Dismiss does, once
  // it has shown the run's end: a person who presses Research now and leaves at once still sees the banner there.
  const endedRunId = locationRun !== null && !isLive(locationRun) ? locationRun.id : null;
  useEffect(() => {
    if (endedRunId !== null) void markSeen(lastChatStore, me.user.id, location.id, { id: endedRunId });
  }, [me.user.id, location.id, endedRunId]);

  const week = useWeekFound(location.id, tick);
  // A restore (or a Restore someone beat) puts an event back on the calendar: this week and the Competition card read
  // again too, as after a run or the switch (UI review).
  const onHiddenChanged = useCallback(async (): Promise<void> => {
    await refresh();
    setTick((value) => value + 1);
  }, [refresh]);

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
            <RunBlock line={runLine({ kind: 'town', name: location.town.name }, data.town, !active)} threads={data.town?.threads ?? []} live={active && isLive(data.town)} />
          )}
          <RunBlock line={runLine({ kind: 'location' }, data.location, !active, townHolds(data.town) ? location.town.name : null)} threads={data.location?.threads ?? []} live={active && isLive(data.location)} />
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
        <WeekList locationId={location.id} week={week} on={data.on} />
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
          <HiddenList locationId={location.id} hidden={data.hidden} readOnly={readOnly} line={line} onChanged={onHiddenChanged} setNotice={setNotice} />
        </Section>
      )}

      <CompetitionCard location={location} org={org} tick={tick} />

      {admin && !viewAs && (!openAsAdmin || data.on) ? (
        <Section>
          <ResearchSwitch town={location.town.name} research={data} onSwitched={(on) => {
            setState({ status: 'ready', data: { ...data, on } });
            refresh().catch(() => undefined);
            // What research found is read only while the switch is on: the week and the Competition card read again.
            setTick((value) => value + 1);
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
  // Within 6 hours of the last run: disabled, saying when it opens, and enabled again at that time.
  const { pressAt } = props.research;
  const opensAt = pressAt === null ? Number.NaN : Date.parse(pressAt);
  const [now, setNow] = useState(() => Date.now());
  const waiting = opensAt > now;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => { setNow(Date.now()); }, Math.min(opensAt - Date.now() + 1_000, 2_147_483_647));
    return () => { clearTimeout(timer); };
  }, [waiting, opensAt, now]);
  const usable = props.research.on && props.research.available && !props.running && !waiting;
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
      <Text style={styles.help}>
        {props.running
          ? RESEARCH_NOW_RUNNING
          // While research is off or not running here the button stays disabled past `pressAt`, so no time is promised.
          : props.research.on && props.research.available && waiting && pressAt !== null ? pressOpensLine(pressAt, new Date(now)) : RESEARCH_NOW_HELP}
      </Text>
      <View style={styles.actions}>
        <Button variant="outline" label={RESEARCH_NOW} disabled={pressing || !usable} onPress={press} />
      </View>
      {error === null ? null : <ErrorNotice message={error} />}
    </View>
  );
}

function WeekList(props: { locationId: string; week: Load<ResearchedEvent[] | null>; on: boolean }): React.JSX.Element {
  const { week } = props;
  // Nothing researched is read while the switch is off: say so, not that research found nothing.
  if (!props.on) return <Text style={styles.body}>{WEEK_OFF}</Text>;
  if (week.status === 'loading') return <LoadingLine text="Loading this week" minHeight={48} />;
  if (week.status === 'failed' || week.data === null) return <Text style={styles.body}>{WEEK_FAILED}</Text>;
  // Each event on its first day this week (a season that began earlier, or a weekly market, is not listed by its start),
  // by day, then start time (an event with none first), then title.
  const from = localToday();
  const to = addDays(from, 6);
  const order = (a: { day: string; event: ResearchedEvent }, b: { day: string; event: ResearchedEvent }): number =>
    a.day.localeCompare(b.day) || (a.event.startTime ?? '').localeCompare(b.event.startTime ?? '') || a.event.title.localeCompare(b.event.title);
  const events = week.data
    .flatMap((event) => {
      const day = firstDay(event, from, to);
      return day === null ? [] : [{ event, day }];
    })
    .sort(order);
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
        // Restore returns research's own values (design decision 11), so an edited event's notice says its edits went.
        const saved = event.edited ? RESTORE_NOTICES.restoredEdited : RESTORE_NOTICES.restored;
        setNotice(result.status === 'saved' ? saved : RESTORE_NOTICES.changedSince, result.status !== 'saved');
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
