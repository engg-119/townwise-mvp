import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { shortDate } from '../analytics/words';
import { INSIDE_RANGE } from '../calendar/model';
import { formatDate } from '../format';
import { useWhenDone } from '../hooks';
import { useRefreshable } from '../console/useRefreshable';
import { shownLocationName } from '../locations/naming';
import { usePortal } from '../PortalProvider';
import { activityHref } from '../routing';
import { updatingOf, type Calibration } from '../schemas';
import { useShownOrg } from '../shell/LocationShell';
import { LinkButton } from '../ui/Button';
import { DefinitionList } from '../ui/DataTable';
import { ErrorNotice, LoadingLine, StatusTag } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { updatingLine } from '../upload/copy';
import { fetchEstimatesAbout, trainedOnWords, type EstimatesAbout, type ForecastRun, type LiveAccuracy } from './api';
import { dayText } from './format';

// "How Townwise estimates" (spec 13.2), the model card: what Townwise's estimates read, what they can't see, their
// known limits, how they are checked and who can see the model, from GET .../estimates/about so the card and
// TownwiseAI say the same thing. Then this location's state, said plainly: no forecast yet (In progress) or (U13B) the
// forecast staff published, which model made it, from which sales and when, its backtest and how it has done so far,
// misses included; how far its town's calendar is researched; and whether any headcount input is (Planned until one
// is). A baseline run (D42) is named as Townwise's baseline, built from the sales rather than trained, and says what it
// is; inside a location's pages, a `stale` calibration says when Townwise refits it and with how many days, and (D65) a
// forecast being updated says so, a running one linked to its runs in TownwiseAI's activity; when that run ends the card reads its
// estimates again in place. Mounted on Analytics and opened from the Agent page's "How TownwiseAI works".

export const MODEL_CARD_TITLE = 'How Townwise estimates';

/** Every value in the same type, so a phone shows one size throughout the list. */
function Lines(props: { lines: readonly string[] }): React.JSX.Element {
  return <Stack gap={theme.space[1]}>{props.lines.map((line) => <Small key={line}>{line}</Small>)}</Stack>;
}

/** `name` is the location as the page shows it: the organization's name with one location (D29). */
export function noForecastLine(about: Pick<EstimatesAbout, 'location'>, name: string): string {
  return `Townwise has no forecast for ${name} yet. Home and TownwiseAI use your history and ${about.location.town.name}’s calendar until it does.`;
}

/** U13B: a percentage with at most one decimal, "4.8%". */
function pct(value: number): string {
  return `${String(Math.round(value * 10) / 10)}%`;
}

/** D42: a run of the baseline engine; `engine` is missing from an API before engines, so the family says it too. */
function isBaseline(run: ForecastRun): boolean {
  return run.engine === 'baseline' || run.model.family === 'seasonal_baseline';
}

/**
 * U13B: "Forecast: Townwise demand model v3, trained on sales exports you sent Townwise from ... made Nov 1, 2026." A
 * baseline run (D42) is "built from" its sales, not trained on them, and says it is not the trained demand model.
 */
export function runLines(run: ForecastRun): string[] {
  const baseline = isBaseline(run);
  const from = `${baseline ? 'built from' : 'trained on'} ${trainedOnWords(run.trainingSource)} from ${formatDate(run.trainedFrom)} to ${formatDate(run.dataThrough)}`;
  const lines = [
    `Forecast: ${run.model.label}, ${from}, made ${formatDate(run.madeAt)}. It saw no sales after ${formatDate(run.dataThrough)}.`,
    ...(baseline ? ['A baseline, not Townwise’s trained demand model: each day is its weekday’s recent level, times last year’s seasonal shape and the town calendar’s effects.'] : []),
    'Each day and week of the first 3 months is a range that about 8 in 10 days should land inside; the outlook’s ranges are wider on purpose.',
  ];
  if (run.interval.widened) lines.push('Its ranges were widened after they ran narrow in backtests.');
  const { backtest } = run;
  if (backtest !== null) {
    lines.push(`In backtests from ${formatDate(backtest.from)} to ${formatDate(backtest.to)}, a typical week was off by ${pct(backtest.weeklyTypicalErrorPct)}, and ${String(backtest.weeksOver20Pct)} of ${String(backtest.weeks)} weeks missed by more than 20%.`);
  }
  return lines;
}

/** U13B: how this run's own days compared with what happened (never an older run's), misses included; none under 5 days. */
export function liveLine(live: LiveAccuracy | null): string {
  if (live === null) return 'Not scored yet: Townwise scores it once 5 of its days have sales.';
  const miss = live.typicalErrorPct === null ? '' : `; typical miss ${pct(live.typicalErrorPct)}`;
  return `So far: ${String(live.inRange)} of ${String(live.days)} days ${INSIDE_RANGE}${miss}, from ${formatDate(live.from)} to ${formatDate(live.to)}.`;
}

/**
 * D42: the words for a `stale` calibration, as the API's calibrationWords gives them: "Forecast made from your sales
 * through Sun, Nov 15. Townwise refits on Mon, Nov 23 with the 6 days since.", or with the weekly refresh off "… The 6
 * days since aren’t in it yet."; null in every other state (a `calibrated` run's own line already says what it saw).
 * D65: while a refit runs, the second form too, so the card never says the refit is both next Monday and happening now.
 */
export function staleLine(calibration: Calibration): string | null {
  if (calibration.state !== 'stale') return null;
  const day = (date: string): string => shortDate(date).replace(/, \d{4}$/, '');
  const made = `Forecast made from your sales through ${day(calibration.dataThrough)}.`;
  const since = calibration.newerDays === 1 ? '1 day since' : `${String(calibration.newerDays)} days since`;
  if (calibration.nextRefresh === null || updatingOf(calibration)?.stage === 'running') return `${made} The ${since} ${calibration.newerDays === 1 ? 'isn’t' : 'aren’t'} in it yet.`;
  return `${made} Townwise refits on ${day(calibration.nextRefresh)} with the ${since}.`;
}

export function calendarLine(about: Pick<EstimatesAbout, 'location' | 'calendar'>): string {
  const { town } = about.location;
  const { covers } = about.calendar;
  if (covers === null) return `Townwise hasn’t researched ${town.name}’s calendar yet, so it shows US federal holidays only.`;
  return `${town.name}’s calendar is researched from ${formatDate(covers.from)} to ${formatDate(covers.to)}, each date with its source.`;
}

export function peopleInputsLine(about: Pick<EstimatesAbout, 'location' | 'people'>): string {
  const { town } = about.location;
  const count = about.people.headcountInputs.length;
  if (count === 0) return `No public count of how many people are in ${town.name} is researched yet, so Townwise shows no headcount.`;
  return `${String(count)} of the public counts behind a headcount are researched for ${town.name}, from ${String(about.people.sources.length)} ${about.people.sources.length === 1 ? 'source' : 'sources'}.`;
}

function Card(props: { about: EstimatesAbout; locationId: string }): React.JSX.Element {
  const { about } = props;
  // Inside a location's pages, the shown name (D29); rendered on its own, the API's.
  const org = useShownOrg();
  const name = org === null ? about.location.name : shownLocationName(about.location, org);
  // Inside a location's pages, its calibration state (D42) from the organization's read; rendered on its own, none.
  const calibration = org?.locations.find((location) => location.id === props.locationId)?.calibration;
  const stale = calibration === undefined ? null : staleLine(calibration);
  const updating = calibration === undefined ? null : updatingLine(calibration);
  // A running sentence links to its run in TownwiseAI's activity; the waiting one is plain words, since the activity has
  // no run of it yet (design decision 4: never point at an empty activity).
  const running = calibration !== undefined && updatingOf(calibration)?.stage === 'running';
  const updatingSentence = updating === null ? null
    : running ? <LinkButton variant="link" href={activityHref(props.locationId)} label={updating} />
    : <Small white>{updating}</Small>;
  const { card, today } = about;
  const noHeadcount = about.people.headcountInputs.length === 0;
  const { run } = about.forecast;
  return (
    <Stack>
      {run === null ? (
        <View style={styles.state}>
          <StatusTag kind="progress" label="In progress" />
          <Small white>{noForecastLine(about, name)}</Small>
          {updatingSentence}
        </View>
      ) : (
        // U13B: the published run, then how it has done.
        <Stack gap={theme.space[2]}>
          {runLines(run).map((line, index) => (index === 0 ? <Small key={line} white>{line}</Small> : <Small key={line}>{line}</Small>))}
          <Small white>{liveLine(about.forecast.live)}</Small>
          {stale === null ? null : <Small white>{stale}</Small>}
          {updatingSentence}
        </Stack>
      )}
      <DefinitionList items={[
        { term: 'What it estimates', value: <Lines lines={[card.estimates]} /> },
        { term: 'What it reads', value: <Lines lines={card.inputs} /> },
        { term: 'What it can’t see', value: <Lines lines={card.cannotSee} /> },
        { term: 'Known limits', value: <Lines lines={card.limits} /> },
        { term: 'How it’s checked', value: <Lines lines={[card.checked]} /> },
        { term: 'Who can see the model', value: <Lines lines={[card.whoCanSee]} /> },
        {
          term: `${about.location.town.name} today`,
          value: <Lines lines={[
            `${dayText(today.date, today.weekday)}, ${today.date.slice(0, 4)}, in ${today.timeZone}${today.approximate ? ' (the state’s main time zone; yours may differ)' : ''}.`,
            calendarLine(about),
          ]} />,
        },
        {
          term: 'People in town',
          value: (
            <Stack gap={theme.space[2]}>
              <Small>{peopleInputsLine(about)}</Small>
              {noHeadcount ? (
                <View style={styles.tagRow}>
                  <StatusTag kind="planned" label="Planned" />
                  <Small>A headcount from public counts is planned.</Small>
                </View>
              ) : null}
            </Stack>
          ),
        },
      ]} />
    </Stack>
  );
}

export function ModelCard(props: { locationId: string }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId } = props;
  const { state, reload, refresh } = useRefreshable(useCallback(() => fetchEstimatesAbout(api, locationId), [api, locationId]));
  // D65: when the location's forecast this card saw updating stops, its estimates are read again in place (the run may
  // have published), with no loading line. Rendered on its own there is no calibration, so nothing to follow.
  const calibration = useShownOrg()?.locations.find((location) => location.id === locationId)?.calibration;
  useWhenDone(calibration !== undefined && updatingOf(calibration) !== null, () => { void refresh(); });
  return (
    <Panel label={MODEL_CARD_TITLE}>
      <Stack>
        <Heading>{MODEL_CARD_TITLE}</Heading>
        {state.status === 'loading' ? <LoadingLine text="Loading how Townwise estimates…" /> : null}
        {state.status === 'failed' ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' ? <Card about={state.data} locationId={locationId} /> : null}
      </Stack>
    </Panel>
  );
}

const styles = StyleSheet.create({
  state: { gap: theme.space[2] },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[2], rowGap: theme.space[1] },
});
