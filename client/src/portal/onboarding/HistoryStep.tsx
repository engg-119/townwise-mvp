import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { fetchSalesHistory } from '../analytics/api';
import { heatmapSummary } from '../analytics/cells';
import { EMPTY_CONTEXT } from '../analytics/days';
import { metricsWithData } from '../analytics/filters';
import { Heatmap } from '../analytics/Heatmap';
import { decodeHistory, type DayRecord } from '../analytics/history';
import { hasCode } from '../errors';
import { removeFile, startImport, type FileView, type ImportView } from '../files/api';
import {
  acceptHint, actionError, fileLine, fileName, formatSize, overallLine, queueLine, readingLine, timeLeft,
} from '../files/copy';
import { ZipEntries } from '../files/ZipEntries';
import { ImportQuestion } from '../files/ImportQuestion';
import { useImport } from '../files/useImport';
import { useUploadQueue, type QueuedUpload } from '../files/uploadQueue';
import { townLabel } from '../format';
import { useAction, useBreakpoint } from '../hooks';
import { localToday } from '../locations/dates';
import { UploadAction } from '../locations/parts';
import { useMoment } from '../moments';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import type { LocationSummary } from '../schemas';
import { useLocation } from '../shell/LocationShell';
import { KIND_LABEL as TOWN_KIND, townProfile } from '../towns';
import { ids } from '../ui/aria';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ErrorNotice, LoadingLine, Messages, ReadOnlyLine, StatusTag } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Body, Eyebrow, Heading, Mono, Small } from '../ui/text';
import {
  calendarYears, cardMoves, doneLine, filesReadLine, foundLines, importToStart, mergeRows, nextEntrance, overLine, pendingRange,
  phaseOf, rowProgress, sendingCount, statusLine, STEP, storedCount, SUGGESTIONS, type Entrance, type Phase, type Row,
} from './history';
import { arriveAtHome, boxOf } from './historyMotion';
import { CAN_DROP, DropArea, FilePicker } from './HistoryStepDrop';

// Onboarding step 3 on Home (spec P11, 11A; storage2 2.1, 2.2 and 15.3; the Home2-Drop and Home2-Reading boards).
// While the organization has no history, Home mounts this in place of the cards that need days. The location card
// sits in the right rail (on a wide screen it moves there once, unless motion is reduced) beside a drop zone that
// asks for everything the restaurant has. Each file is its own upload through the files queue, three at a time,
// with its own progress, speed and time left and the whole queue's time left; "Read my history" starts reading.
// Reading shows each file's status and time left from the server ("Estimating" with no basis), the question when
// the reader needs an answer, every file kept and not used with its reason, and the calendar filling in as days
// arrive. When reading is done the step hands over to Home, and on web the calendar moves into Home's history card.
//
// The browser upload (P13) is the other way in: it replaces the drop zone while stored files are off (503
// files_unavailable), it is offered after a refusal, and it is always linked as the choice to send only daily
// totals (spec 10.11, storage2 13). Under view-as there is no drop and no upload: the queue is never created, the
// controls are disabled with the read-only line, and only the status reads run. Native has no upload (D20): it
// says where to drop files and shows the reading status in words. Nothing is kept in browser storage.

const RO_ID = 'history-step-ro';
const READ_HELP_ID = 'history-step-read-help';
const CALENDAR_ID = 'history-step-calendar';
const AUTO_HOME_MS = 2500;
const MARKS = { townEvents: false, holidays: false, notes: false, closures: true } as const;
const EVERY_DAY = (): boolean => true;
const [E1, E2, E3, E4] = theme.motion.easeInOut;

/** Locations whose card already moved into the rail since the app loaded (memory only, never stored). */
const PLAYED = new Set<string>();

/**
 * The card's one move into the rail: it starts over the reading column and slides right while the drop zone
 * fades in under it. `wait` hides the card until the first status read says whether to move; if the rail has
 * not been measured shortly after, the card just shows.
 */
function useEntrance(mode: Entrance, locationId: string): {
  x: Animated.Value;
  cardOpacity: Animated.Value;
  mainOpacity: Animated.Value;
  onSideLayout: (event: LayoutChangeEvent) => void;
} {
  const [x] = useState(() => new Animated.Value(0));
  const [cardOpacity] = useState(() => new Animated.Value(mode === 'still' ? 1 : 0));
  const [mainOpacity] = useState(() => new Animated.Value(1));
  const sideX = useRef<number | null>(null);
  const started = useRef(false);

  const start = useCallback(() => {
    if (started.current || sideX.current === null) return;
    started.current = true;
    PLAYED.add(locationId);
    x.setValue(-sideX.current);
    mainOpacity.setValue(0);
    cardOpacity.setValue(1);
    Animated.parallel([
      Animated.timing(x, { toValue: 0, duration: theme.motion.zoom, easing: Easing.bezier(E1, E2, E3, E4), useNativeDriver: false }),
      Animated.timing(mainOpacity, { toValue: 1, duration: theme.motion.fade, delay: 160, useNativeDriver: false }),
    ]).start();
  }, [cardOpacity, locationId, mainOpacity, x]);

  useEffect(() => {
    if (mode === 'still') {
      started.current = true;
      cardOpacity.setValue(1);
      mainOpacity.setValue(1);
      x.setValue(0);
      return undefined;
    }
    if (mode === 'wait') return undefined;
    start();
    const fallback = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      cardOpacity.setValue(1);
    }, 150);
    return () => { clearTimeout(fallback); };
  }, [mode, start, cardOpacity, mainOpacity, x]);

  const onSideLayout = useCallback((event: LayoutChangeEvent) => {
    sideX.current = event.nativeEvent.layout.x;
    if (mode === 'play') start();
  }, [mode, start]);

  return { x, cardOpacity, mainOpacity, onSideLayout };
}

/** A status that screen readers hear once when it changes: a polite live line, and an announcement on iOS. */
function Announce(props: { text: string }): React.JSX.Element {
  const { text } = props;
  useEffect(() => {
    if (text !== '' && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
  return <Text role="status" aria-live="polite" style={styles.srOnly}>{text}</Text>;
}

function Bar(props: { value: number; label: string }): React.JSX.Element {
  const percent = Math.round(props.value * 100);
  return (
    <View role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={styles.track}>
      <View style={[styles.fill, { width: `${String(percent)}%` }]} />
    </View>
  );
}

function LocationCard(props: { location: LocationSummary }): React.JSX.Element {
  const { location } = props;
  const profile = townProfile(location.town.townId);
  return (
    <Panel label={STEP.cardEyebrow}>
      <Stack gap={theme.space[2]}>
        <Eyebrow>{STEP.cardEyebrow}</Eyebrow>
        <Heading level={3}>{location.name}</Heading>
      </Stack>
      <View style={styles.town}>
        <Small>{townLabel(location.town)}</Small>
        {profile === null ? null : <StatusTag label={TOWN_KIND[profile.kind]} />}
      </View>
    </Panel>
  );
}

function Keeps(props: { locationId: string }): React.JSX.Element {
  return (
    <Stack gap={theme.space[3]}>
      <Eyebrow>{STEP.keepsTitle}</Eyebrow>
      {STEP.keeps.map((line) => <Small key={line}>{line}</Small>)}
      <Small>{STEP.keepsFiles}</Small>
      <Actions><LinkButton variant="link" href={locationHref(props.locationId, 'sales')} label={STEP.salesData} /></Actions>
    </Stack>
  );
}

function Suggestions(): React.JSX.Element {
  return (
    <Stack gap={theme.space[3]}>
      <Eyebrow>{STEP.suggestionsTitle}</Eyebrow>
      <View role="list" aria-label={STEP.suggestionsTitle} style={styles.list}>
        {SUGGESTIONS.map((item) => (
          <View key={item.title} role="listitem" style={styles.row}>
            <Text style={styles.name}>{item.title}</Text>
            <Small>{item.body}</Small>
          </View>
        ))}
      </View>
    </Stack>
  );
}

/**
 * "Prefer to send only daily totals?" and the link to P13 (storage2 13). Web only: native has no upload. Under
 * view-as it is disabled in place, described by the read-only line, as UploadAction is.
 */
function DailyTotals(props: { locationId: string; lead?: string; readOnlyId: string | null }): React.JSX.Element | null {
  if (Platform.OS !== 'web') return null;
  return (
    <View style={styles.daily}>
      <Small>{props.lead ?? STEP.dailyTotalsAsk}</Small>
      {props.readOnlyId === null
        ? <LinkButton variant="link" href={`${locationHref(props.locationId, 'sales')}/upload`} label={STEP.dailyTotalsLink} />
        : <Button variant="link" label={STEP.dailyTotalsLink} disabled describedBy={props.readOnlyId} />}
    </View>
  );
}

/**
 * Remove on a stored file, from this visit or an earlier one: the row leaves only once the server deleted it, and a
 * refusal is said on the row (storage2 15.3 step 2). The queue's cancel is not used here: its delete is not
 * awaited, so a refused delete would hide a file the server still reads.
 */
function RemoveFile(props: { locationId: string; file: FileView; onRemoved: () => void }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, file, onRemoved } = props;
  const remove = useAction(useCallback(async () => {
    await removeFile(api, locationId, file.id);
    onRemoved();
  }, [api, locationId, file.id, onRemoved]));
  return (
    <>
      <Button
        variant="link"
        label={remove.pending ? STEP.removing : STEP.remove}
        accessibilityLabel={`${STEP.remove} ${fileName(file)}`}
        disabled={remove.pending}
        onPress={remove.run}
      />
      {remove.error === null ? null : <Messages live="alert" items={[actionError(remove.error)]} />}
    </>
  );
}

const CANCELLABLE: ReadonlySet<QueuedUpload['state']> = new Set(['waiting', 'creating', 'sending', 'retrying', 'completing']);
const REMOVABLE: ReadonlySet<FileView['status']> = new Set(['stored', 'uploading']);

function RowView(props: {
  row: Row;
  locationId: string;
  readOnly: boolean;
  /** This screen's upload of the file, when it has one: it leaves the queue once the file is deleted. */
  queued: QueuedUpload | undefined;
  cancel: (key: string) => void;
  forget: (key: string) => void;
  onRemoved: () => void;
}): React.JSX.Element {
  const { row, readOnly } = props;
  const progress = rowProgress(row);
  if (row.kind === 'upload') {
    const { item } = row;
    const cancelling = CANCELLABLE.has(item.state);
    return (
      <View role="listitem" style={styles.row}>
        <Text style={styles.name}>{item.name}</Text>
        <Mono>{formatSize(item.sizeBytes)}</Mono>
        {progress === null ? null : <Bar value={progress} label={`${item.name}, sent`} />}
        <Small white>{queueLine(item)}</Small>
        {readOnly ? null : (
          <Actions>
            <Button
              variant="link"
              label={cancelling ? STEP.cancel : STEP.remove}
              accessibilityLabel={`${cancelling ? STEP.cancel : STEP.remove} ${item.name}`}
              onPress={() => { props.cancel(item.key); }}
            />
          </Actions>
        )}
      </View>
    );
  }
  const { file } = row;
  const eta = file.status === 'queued' || file.status === 'reading' ? ` · ${timeLeft(file.etaSeconds, 'read')}` : '';
  const removable = !readOnly && file.canDelete && REMOVABLE.has(file.status);
  return (
    <View role="listitem" style={styles.row}>
      <Text style={styles.name}>{fileName(file)}</Text>
      <Mono>{formatSize(file.sizeBytes)}</Mono>
      {progress === null ? null : <Bar value={progress} label={`${fileName(file)}, read`} />}
      <Small white>{`${fileLine(file)}${eta}`}</Small>
      {file.entries === null ? null : <ZipEntries locationId={props.locationId} file={file} entries={file.entries} />}
      {removable ? (
        <Actions>
          <RemoveFile
            locationId={props.locationId}
            file={file}
            onRemoved={() => {
              if (props.queued !== undefined) props.forget(props.queued.key);
              props.onRemoved();
            }}
          />
        </Actions>
      ) : null}
    </View>
  );
}

/** The days read so far, re-read each time the import applies more (`appliedVersion`); the last answer stays shown. */
function useReadDays(locationId: string, version: number | null): { days: DayRecord[] | null; failed: boolean } {
  const { api } = usePortal();
  const [state, setState] = useState<{ days: DayRecord[] | null; failed: boolean }>({ days: null, failed: false });
  useEffect(() => {
    if (version === null) return undefined;
    let live = true;
    fetchSalesHistory(api, locationId).then(
      (body) => { if (live) setState({ days: decodeHistory(body), failed: false }); },
      () => { if (live) setState((previous) => ({ ...previous, failed: true })); },
    );
    return () => { live = false; };
  }, [api, locationId, version]);
  return state;
}

/** The calendar of days read so far, filling in as they arrive; each new batch fades in unless motion is reduced. */
function ReadCalendar(props: { locationId: string; view: ImportView; reading: boolean; reduced: boolean | null }): React.JSX.Element {
  const { view, reading, reduced } = props;
  const { days, failed } = useReadDays(props.locationId, view.appliedVersion);
  const [today] = useState(localToday);
  const [fade] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduced !== false || days === null) return;
    fade.setValue(0.55);
    Animated.timing(fade, { toValue: 1, duration: theme.motion.fade, useNativeDriver: false }).start();
  }, [days, reduced, fade]);
  const shown = useMemo(() => days ?? [], [days]);
  const years = useMemo(() => calendarYears(shown.map((day) => day.date), today), [shown, today]);
  const metric = metricsWithData(shown).guests ? 'guests' : 'netSales';
  const pending = useMemo(() => pendingRange(years, today, reading), [years, today, reading]);
  const summary = heatmapSummary({ days: shown, metric, context: EMPTY_CONTEXT, included: EVERY_DAY, years }, null);
  const label = `${STEP.calendarLabel}. ${summary ?? STEP.calendarEmpty}`;
  return (
    <View nativeID={CALENDAR_ID} style={styles.calendar}>
      {failed ? <Small>{STEP.calendarFailed}</Small> : null}
      <Animated.View style={{ opacity: fade }}>
        <Heatmap
          days={shown}
          metric={metric}
          marks={MARKS}
          context={EMPTY_CONTEXT}
          included={EVERY_DAY}
          years={years}
          interactive={false}
          {...(pending === undefined ? {} : { pending })}
          label={label}
          today={today}
        />
      </Animated.View>
    </View>
  );
}

export function HistoryStep(props: { onDone?: () => void }): React.JSX.Element {
  const { onDone } = props;
  const { location } = useLocation();
  const { api, reloadOrg } = usePortal();
  const { readOnly, line } = useReadOnly();
  const reduced = useReducedMotion();
  const moment = useMoment();
  const { desktop } = useBreakpoint();
  const queue = useUploadQueue(location.id);
  const poll = useImport(location.id, 'current');
  const { refresh } = poll;
  const [over, setOver] = useState<number | null>(null);

  // An import an action answered with is shown until the next poll answers.
  const [pushed, setPushed] = useState<{ view: ImportView; after: ImportView | null } | null>(null);
  const view = pushed !== null && pushed.after === poll.import ? pushed.view : poll.import;
  const push = useCallback((next: ImportView) => {
    setPushed({ view: next, after: poll.import });
    refresh();
  }, [poll.import, refresh]);

  // Whether this screen saw the import before it finished.
  const [watched, setWatched] = useState<string | null>(null);
  if (view !== null && view.status !== 'done' && watched !== view.id) setWatched(view.id);
  const phase: Phase = phaseOf(view, view !== null && watched === view.id);

  const filesOff = queue.filesUnavailable || hasCode(poll.error, 503, 'files_unavailable');
  const loaded = !poll.loading || poll.error !== null;
  const rowsView = phase === 'drop' && view?.status === 'done' ? null : view;
  const rows = useMemo(() => mergeRows(rowsView, queue.items), [rowsView, queue.items]);
  const stored = storedCount(rows);
  const sending = sendingCount(queue.items);
  const refused = queue.items.some((item) => item.state === 'refused' || item.state === 'failed');
  const byFile = useMemo(() => new Map(queue.items.filter((item) => item.fileId !== null).map((item) => [item.fileId, item])), [queue.items]);

  // The server's list follows this screen's uploads: once the first joins an import, and as each one finishes.
  const finished = queue.items.filter((item) => item.state === 'done').length;
  useEffect(() => {
    if (queue.importId !== null) refresh();
  }, [queue.importId, finished, refresh]);

  const start = useAction(useCallback(async () => {
    const importId = importToStart(view, queue.importId);
    if (importId === null) return;
    push(await startImport(api, location.id, importId));
  }, [api, location.id, view, queue.importId, push]));

  // Done: Home takes over. The calendar is measured first, so on web Home's history card can grow from it.
  const went = useRef(false);
  const goHome = useCallback(() => {
    if (went.current) return;
    went.current = true;
    const from = boxOf(CALENDAR_ID);
    reloadOrg();
    onDone?.();
    arriveAtHome(from, reduced === false);
  }, [reloadOrg, onDone, reduced]);
  useEffect(() => {
    if (phase !== 'done' || sending > 0) return undefined;
    const timer = setTimeout(goHome, AUTO_HOME_MS);
    return () => { clearTimeout(timer); };
  }, [phase, sending, goHome]);

  // The card moves into the rail once, decided at the first status read.
  const eligible = reduced === false && desktop && !PLAYED.has(location.id);
  const [entrance, setEntrance] = useState<Entrance>(eligible ? 'wait' : 'still');
  const decided = nextEntrance(entrance, {
    loaded,
    momentPlaying: moment.playing,
    moves: cardMoves({ reduced, desktop, played: PLAYED.has(location.id), phase, hasImport: view !== null }) && !filesOff,
  });
  if (decided !== entrance) setEntrance(decided);
  const motion = useEntrance(entrance, location.id);

  const dropping = !readOnly && !filesOff;
  const reading = phase === 'reading';

  const zone = CAN_DROP ? (
    <View role="region" aria-label={STEP.dropHeading} style={[styles.zone, over === null ? null : styles.zoneOver]}>
      <Heading level={3}>{over === null ? STEP.dropHeading : overLine(over)}</Heading>
      <Small>{STEP.dropBody}</Small>
      <Small>{acceptHint(queue.limits?.maxFileBytes ?? null)}</Small>
      {readOnly ? <ReadOnlyLine text={line} nativeID={RO_ID} /> : null}
      <Actions>
        <FilePicker
          enabled={dropping}
          label={rows.length === 0 ? STEP.choose : STEP.chooseMore}
          onFiles={queue.add}
          {...(readOnly ? { describedBy: RO_ID } : {})}
        />
      </Actions>
    </View>
  ) : <Small>{STEP.nativeDrop}</Small>;

  const list = rows.length === 0 ? null : (
    <Stack gap={theme.space[3]}>
      {queue.items.length === 0 || queue.overall.files === 0 ? null : <Mono tone="white">{overallLine(queue.overall)}</Mono>}
      <View role="list" aria-label="Your files" style={styles.list}>
        {rows.map((row) => (
          <RowView
            key={row.key}
            row={row}
            locationId={location.id}
            readOnly={readOnly}
            queued={row.kind === 'file' ? byFile.get(row.file.id) : undefined}
            cancel={queue.cancel}
            forget={queue.forget}
            onRemoved={refresh}
          />
        ))}
      </View>
    </Stack>
  );

  const readHelp = stored === 0 ? STEP.readHelpNone : sending > 0 ? STEP.readHelpSending : null;
  const readDescribedBy = ids(readOnly && RO_ID, readHelp !== null && READ_HELP_ID);
  const readButton = (
    <Stack gap={theme.space[2]}>
      <Actions>
        <Button
          variant="primary"
          label={start.pending ? STEP.starting : STEP.read}
          disabled={readOnly || stored === 0 || start.pending}
          {...(readDescribedBy === undefined ? {} : { describedBy: readDescribedBy })}
          onPress={start.run}
        />
      </Actions>
      {readHelp === null ? null : <Small nativeID={READ_HELP_ID}>{readHelp}</Small>}
      {start.error === null ? null : <Messages live="alert" items={[actionError(start.error)]} />}
    </Stack>
  );

  let main: React.ReactNode;
  if (!loaded) {
    main = <LoadingLine text={STEP.loading} />;
  } else if (filesOff) {
    main = (
      <Panel>
        <Heading level={3}>{STEP.offTitle}</Heading>
        <Small>{STEP.offBody}</Small>
        {readOnly && Platform.OS === 'web' ? <ReadOnlyLine text={line} nativeID={RO_ID} /> : null}
        <Actions><UploadAction locationId={location.id} variant="primary" readOnlyId={readOnly && Platform.OS === 'web' ? RO_ID : null} /></Actions>
      </Panel>
    );
  } else if (view !== null && (phase === 'reading' || phase === 'done')) {
    main = (
      <Stack gap={theme.space[6]}>
        <Stack gap={theme.space[2]}>
          {phase === 'done' ? (
            <>
              <Body>{doneLine(view.found)}</Body>
              <Small>{sending > 0 ? STEP.stayUploading : STEP.opening}</Small>
              <Actions><Button variant="outline" label={STEP.goHome} onPress={goHome} /></Actions>
            </>
          ) : (
            <Mono tone="white">{`${filesReadLine(view.progress)} · ${readingLine(view)}`}</Mono>
          )}
        </Stack>
        {view.question === null || phase !== 'reading' ? null : (
          <ImportQuestion
            key={view.question.id}
            locationId={location.id}
            importId={view.id}
            question={view.question}
            locationName={location.name}
            onAnswered={push}
          />
        )}
        {list}
        <Stack gap={theme.space[2]}>
          <Eyebrow>{STEP.foundTitle}</Eyebrow>
          {foundLines(view.found).map((text) => <Small key={text}>{text}</Small>)}
        </Stack>
        <ReadCalendar locationId={location.id} view={view} reading={reading} reduced={reduced} />
        {reading && CAN_DROP ? zone : null}
      </Stack>
    );
  } else {
    main = (
      <Stack gap={theme.space[6]}>
        {phase === 'nothing_used' && view !== null ? (
          <Stack gap={theme.space[2]}>
            <Body>{STEP.nothingUsed}</Body>
            <Small>{STEP.nothingUsedHelp}</Small>
          </Stack>
        ) : null}
        {poll.error === null ? null : <ErrorNotice error={poll.error} onRetry={refresh} />}
        {zone}
        {list}
        {CAN_DROP ? readButton : null}
        <DailyTotals
          locationId={location.id}
          readOnlyId={readOnly ? RO_ID : null}
          {...(refused || poll.error !== null ? { lead: STEP.refusedOffer } : {})}
        />
        <Suggestions />
      </Stack>
    );
  }

  const side = (
    <Stack gap={theme.space[8]}>
      <Animated.View style={{ opacity: motion.cardOpacity, transform: [{ translateX: motion.x }] }}><LocationCard location={location} /></Animated.View>
      {filesOff ? null : <Keeps locationId={location.id} />}
    </Stack>
  );

  const readingHead = loaded && !filesOff && view !== null && (phase === 'reading' || phase === 'done');
  const title = readingHead ? STEP.readingTitle : STEP.title;
  return (
    <View role="region" aria-label={title}>
      <Announce text={statusLine(phase, view)} />
      <DropArea enabled={dropping} onFiles={queue.add} onOver={setOver}>
        <Stack gap={theme.space[2]} style={styles.head}>
          <Mono>{STEP.step}</Mono>
          <Heading>{title}</Heading>
          <Body>{readingHead ? STEP.closeOk : STEP.lead}</Body>
        </Stack>
        {desktop ? (
          <View style={styles.columns}>
            <Animated.View style={[styles.main, { opacity: motion.mainOpacity }]}>{main}</Animated.View>
            <View style={styles.spacer} />
            <View style={styles.side} onLayout={motion.onSideLayout}>{side}</View>
          </View>
        ) : (
          <View style={styles.stacked}>{main}{side}</View>
        )}
      </DropArea>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
  head: { marginBottom: theme.space[8], maxWidth: 720 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  main: { flex: 7, minWidth: 0 },
  spacer: { flex: 1 },
  side: { flex: 4, minWidth: 0 },
  stacked: { gap: theme.space[8] },
  zone: {
    gap: theme.space[3], padding: theme.space[6], borderWidth: 1, borderStyle: 'dashed', borderColor: c.line, backgroundColor: c.panel,
    alignItems: 'flex-start',
  },
  zoneOver: { borderStyle: 'solid', borderColor: c.white, backgroundColor: c.raised },
  list: { borderTopWidth: 1, borderTopColor: c.border },
  row: { gap: theme.space[2], paddingVertical: theme.space[4], borderBottomWidth: 1, borderBottomColor: c.border, minWidth: 0 },
  name: { ...theme.type.ui, color: c.white, flexShrink: 1 },
  track: { height: 4, backgroundColor: c.state, maxWidth: 480, width: '100%' },
  fill: { height: 4, backgroundColor: c.mint },
  town: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  daily: { gap: theme.space[1], alignItems: 'flex-start' },
  calendar: { gap: theme.space[3] },
});
