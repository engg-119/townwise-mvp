import { Link } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fmt1, side } from '../../marketing/format';
import { theme } from '../../theme';
import { dayMonth, dayMonthRange } from '../analytics/week';
import { MONTH_NAMES } from '../analytics/words';
import { fetchPeopleInTown, monthRange, type PeopleInTown, type PeoplePeriod, type TermState, type Weekday } from '../estimates/api';
import { dayText, historyLine, noNumberLine, rangeText } from '../estimates/format';
import { Provenance } from '../estimates/Provenance';
import { useBreakpoint, useLoad } from '../hooks';
import { addDays } from '../locations/dates';
import { usePortal } from '../PortalProvider';
import { DATA_YEAR, SOURCES, townProfile } from '../towns';
import { ErrorNotice, LoadingLine, StatusTag } from '../ui/feedback';
import { Heading, Mono, Small } from '../ui/text';

// The inside of Home's Who's in town block (spec P11, 13.2), written for an owner glancing at it. With no headcount
// for the month, the honest no-number line with its Planned tag comes first. Then the term by time, each group under
// an h3: This week leads with today's term in plain words (or its headcount as one large figure with its unit), then
// what starts by Sunday; Later in {month} is one row per run of days, its dates (mono) beside words. Past days are left
// out. While the read is out, its loading line keeps about the groups' height.
// The term's sources follow once, by name. Then the location's own days by term, and the county's food-service jobs
// for the month (bundled BLS data, one of the twelve towns only), said as more or fewer than its average month.

const WEB_LINK = /^https:\/\//i;
const BLS = SOURCES.find((source) => source.url.startsWith('https://www.bls.gov/'));
const BETWEEN_TERMS_NOTE = 'Between terms is worked out from the term dates.';
/** About the height of the term groups, which the loading line keeps, so the jobs under it don't move when they arrive. */
const LOADING_HEIGHT = 240;

const monthNameOf = (date: string): string => MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? '';

/** A run of days with the same term and the same headcount, events folded away. */
export interface TownRun {
  from: string;
  to: string;
  toWeekday: Weekday;
  state: TermState;
  label: string | null;
  headcount: { low: number; high: number } | null;
  /** The term's sources, then the headcount's, each once. */
  sourceIds: string[];
}

export interface InTownReading {
  /** The run with today in it. */
  now: TownRun | null;
  /** Runs that start after today and within This week's seven days from today. */
  thisWeek: TownRun[];
  /** Runs that start after those seven days. */
  later: TownRun[];
  /** False for a town with no term dates at all (not a college town): there is no term to read. */
  termed: boolean;
  /** Whether any day of the read has a headcount. */
  counted: boolean;
  /** The sources of the runs shown, in first-use order. */
  sources: { label: string; url: string }[];
}

function runsOf(periods: readonly PeoplePeriod[]): TownRun[] {
  const runs: TownRun[] = [];
  for (const period of periods) {
    const headcount = period.headcount === null ? null : { low: period.headcount.low, high: period.headcount.high };
    const ids = [...period.termSourceIds, ...(period.headcount?.sourceIds ?? [])];
    const last = runs.at(-1);
    if (
      last?.state === period.termState && last.label === period.termLabel
      && last.headcount?.low === headcount?.low && last.headcount?.high === headcount?.high
    ) {
      last.to = period.to;
      last.toWeekday = period.toWeekday;
      last.sourceIds = [...new Set([...last.sourceIds, ...ids])];
    } else {
      runs.push({
        from: period.from, to: period.to, toWeekday: period.toWeekday, state: period.termState, label: period.termLabel, headcount,
        sourceIds: [...new Set(ids)],
      });
    }
  }
  return runs;
}

/** The month's people in town from today on, grouped by time. */
export function inTownReading(window: PeopleInTown, today: string): InTownReading {
  const runs = runsOf(window.periods);
  const last = addDays(today, 6);
  const now = runs.find((run) => run.from <= today && today <= run.to) ?? null;
  const ahead = runs.filter((run) => run.from > today);
  const ids = [...new Set([...(now?.sourceIds ?? []), ...ahead.flatMap((run) => run.sourceIds)])];
  return {
    now,
    thisWeek: ahead.filter((run) => run.from <= last),
    later: ahead.filter((run) => run.from > last),
    termed: window.town.kind === 'college' || runs.some((run) => run.state !== 'unknown'),
    counted: window.periods.some((period) => period.headcount !== null),
    sources: ids.flatMap((id) => {
      const source = window.sources.find((each) => each.id === id);
      return source === undefined || !WEB_LINK.test(source.url) ? [] : [{ label: source.label, url: source.url }];
    }),
  };
}

/** "Fall term finals", "Between terms", "Townwise has no term dates". */
export function runWords(run: Pick<TownRun, 'state' | 'label'>): string {
  if (run.state === 'unknown') return 'Townwise has no term dates';
  if (run.state === 'between_terms') return 'Between terms';
  return run.label ?? 'Term';
}

/** Today's term in a sentence: "Fall term classes until Tue, Nov 17.", or "… for the rest of November." */
export function nowLine(run: TownRun, window: Pick<PeopleInTown, 'to'>): string {
  const when = run.to === window.to ? `for the rest of ${monthNameOf(window.to)}` : `until ${dayText(run.to, run.toWeekday)}`;
  return `${runWords(run)} ${when}.`;
}

/** A row's dates: "Nov 20 to 25", or "From Nov 26" for a run that reaches the end of the read. */
export function runWhen(run: TownRun, window: Pick<PeopleInTown, 'to'>): string {
  return run.to === window.to && run.from !== run.to ? `From ${dayMonth(run.from)}` : dayMonthRange(run.from, run.to);
}

/**
 * The county's jobs for the month against its average month of the data year, in words, as the figure and the rest of
 * the sentence: ["4.5% fewer", " jobs in November 2025 than in an average month that year."]. The index is each
 * month's jobs over the year's monthly average, times 100, so 95.5 is 4.5% fewer.
 */
export function jobsWords(index: number, monthName: string): [string, string] {
  const gap = index - 100;
  const when = `${monthName} ${String(DATA_YEAR)}`;
  const way = side(gap);
  if (way === 'level with') return ['About as many', ` jobs in ${when} as in an average month that year.`];
  return [`${fmt1(Math.abs(gap))}% ${way === 'above' ? 'more' : 'fewer'}`, ` jobs in ${when} than in an average month that year.`];
}

function Group(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.group}>
      <Heading level={3} style={styles.groupHead}>{props.title}</Heading>
      {props.children}
    </View>
  );
}

function SourceLink(props: { label: string; url: string }): React.JSX.Element {
  return <Link href={props.url} style={styles.source}>{`Source: ${props.label}`}</Link>;
}

/** Today's run: its headcount as one figure with its unit when there is one, and the term in a sentence. */
function Now(props: { run: TownRun; window: PeopleInTown; counted: boolean }): React.JSX.Element {
  const { run, window, counted } = props;
  const { phone } = useBreakpoint();
  return (
    <View style={styles.now}>
      {run.headcount === null ? null : (
        <Text style={styles.big}>
          {rangeText(run.headcount.low, run.headcount.high, '')}
          <Text style={styles.bigUnit}> people in town</Text>
        </Text>
      )}
      {run.headcount === null
        ? <Text style={[phone ? theme.type.h3Phone : theme.type.h3, styles.white]}>{nowLine(run, window)}</Text>
        : <Small white>{nowLine(run, window)}</Small>}
      {counted && run.headcount === null ? <Small>No headcount for these days.</Small> : null}
    </View>
  );
}

/** One row per run: the dates beside the words (over them on a phone), and the headcount when the month has any. */
function Rows(props: { runs: readonly TownRun[]; window: PeopleInTown; counted: boolean }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View role="list" style={styles.rows}>
      {props.runs.map((run) => (
        <View key={run.from} role="listitem" style={phone ? styles.rowPhone : styles.row}>
          <Text style={[styles.when, phone ? null : styles.whenWide]}>{runWhen(run, props.window)}</Text>
          <Small white style={styles.words}>{runWords(run)}</Small>
          {props.counted ? (
            <Text style={run.headcount === null ? styles.none : styles.figure}>
              {run.headcount === null ? 'No headcount' : rangeText(run.headcount.low, run.headcount.high, 'people')}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function People(props: { window: PeopleInTown; today: string }): React.JSX.Element {
  const { window, today } = props;
  const { town } = window;
  if (!window.available) return <Small white>{`Townwise hasn’t researched ${town.name}, ${town.state} yet.`}</Small>;
  const reading = inTownReading(window, today);
  const { now, thisWeek, later } = reading;
  const between = [...(now === null ? [] : [now]), ...thisWeek, ...later].some((run) => run.state === 'between_terms');
  const history = historyLine(window.yourHistory);
  const { first, last } = window.yourHistory;
  const historyDays = window.yourHistory.cells.reduce((sum, cell) => sum + cell.days, 0);
  return (
    <>
      {reading.counted ? null : (
        <View style={styles.tagRow}>
          <StatusTag kind="planned" label="Planned" />
          <Small white style={styles.shrink}>{noNumberLine(town)}</Small>
        </View>
      )}
      {!reading.termed || (now === null && thisWeek.length === 0) ? null : (
        <Group title="This week">
          {now === null ? null : <Now run={now} window={window} counted={reading.counted} />}
          {thisWeek.length === 0 ? null : <Rows runs={thisWeek} window={window} counted={reading.counted} />}
        </Group>
      )}
      {!reading.termed || later.length === 0 ? null : (
        <Group title={`Later in ${monthNameOf(today)}`}>
          <Rows runs={later} window={window} counted={reading.counted} />
        </Group>
      )}
      {!reading.termed || (!between && reading.sources.length === 0) ? null : (
        <View style={styles.foot}>
          {between ? <Mono tone="text3">{BETWEEN_TERMS_NOTE}</Mono> : null}
          {reading.sources.map((source) => <SourceLink key={source.url} label={source.label} url={source.url} />)}
        </View>
      )}
      {history === null ? null : (
        <Group title="Your sales by term">
          <Small white>{history}</Small>
          {first === null || last === null ? null : <Provenance provenance={{ kind: 'history', first, last, days: historyDays }} />}
        </Group>
      )}
    </>
  );
}

/**
 * The county's food-service jobs this month, for one of the twelve towns; nothing for another town. A county BLS did
 * not publish for the whole data year has no index, so it says why instead, with no figure.
 */
function Jobs(props: { townId: string | null; today: string }): React.JSX.Element | null {
  const profile = townProfile(props.townId);
  if (profile === null) return null;
  if (profile.series === null) {
    return (
      <Group title={`Food-service jobs in ${profile.county}`}>
        <Small white>{profile.seriesUnavailable}</Small>
        {BLS === undefined ? null : <SourceLink label="U.S. Bureau of Labor Statistics, QCEW" url={BLS.url} />}
      </Group>
    );
  }
  const index = profile.series.index[Number(props.today.slice(5, 7)) - 1];
  if (index === undefined) return null;
  const [figure, rest] = jobsWords(index, monthNameOf(props.today));
  return (
    <Group title={`Food-service jobs in ${profile.county}`}>
      <Small white style={styles.figureLine}><Text style={styles.figure}>{figure}</Text>{rest}</Small>
      <Mono tone="text3">County, not town. Employment is a stand-in for demand.</Mono>
      {BLS === undefined ? null : <SourceLink label="U.S. Bureau of Labor Statistics, QCEW" url={BLS.url} />}
    </Group>
  );
}

/** Who's in town this month (GET .../people-in-town, read on its own), then the county's jobs. */
export function InTown(props: { today: string; townId: string | null; locationId: string }): React.JSX.Element {
  const { today, locationId } = props;
  const { api } = usePortal();
  const month = today.slice(0, 7);
  const { state, reload } = useLoad(useCallback(() => fetchPeopleInTown(api, locationId, monthRange(month)), [api, locationId, month]));
  return (
    <View style={styles.root}>
      {state.status === 'loading' ? <LoadingLine text="Loading who’s in town…" minHeight={LOADING_HEIGHT} /> : null}
      {state.status === 'failed' ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <People window={state.data} today={today} /> : null}
      <Jobs townId={props.townId} today={today} />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[5], minWidth: 0 },
  white: { color: c.white },
  shrink: { flexShrink: 1, minWidth: 0 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[3], rowGap: theme.space[2] },
  group: { gap: theme.space[3], paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border, minWidth: 0 },
  groupHead: { ...theme.type.label, color: c.text2 },
  now: { gap: theme.space[2], minWidth: 0 },
  big: { ...theme.type.valuePhone, color: c.white, fontVariant: ['tabular-nums'] },
  bigUnit: { ...theme.type.monoUi, letterSpacing: 0, color: c.text2 },
  rows: { gap: theme.space[3], minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: theme.space[4], rowGap: 2, minWidth: 0 },
  rowPhone: { flexDirection: 'column', gap: 2, minWidth: 0 },
  when: { ...theme.type.mono, color: c.text2, fontVariant: ['tabular-nums'] },
  whenWide: { width: 112 },
  words: { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 0 },
  figure: { ...theme.type.monoValue, fontSize: 18, lineHeight: 24, color: c.white, fontVariant: ['tabular-nums'] },
  figureLine: { lineHeight: 24 },
  none: { ...theme.type.mono, color: c.text3 },
  foot: { gap: 0, alignItems: 'flex-start' },
  source: { ...theme.type.mono, color: c.text2, minHeight: 44, lineHeight: 44, textDecorationLine: 'underline', textDecorationColor: c.line },
});
