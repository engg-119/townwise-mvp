import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatDate } from '../format';
import { useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { DefinitionList } from '../ui/DataTable';
import { ErrorNotice, LoadingLine, StatusTag } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { fetchEstimatesAbout, type EstimatesAbout, type ForecastRun, type LiveAccuracy } from './api';
import { dayText } from './format';

// "How Townwise estimates" (spec 13.2), the model card: what Townwise's estimates read, what they can't see, their
// known limits, how they are checked and who can see the model, from GET .../estimates/about so the card and
// TownwiseAI say the same thing. Then this location's state, said plainly: no forecast yet (In progress) or (U13B) the
// forecast staff published, which model made it, from which sales and when, its backtest and how it has done so far,
// misses included; how far its town's calendar is researched; and whether any headcount input is (Planned until one
// is). Mounted on Analytics and opened from the Agent page's "How TownwiseAI works".

export const MODEL_CARD_TITLE = 'How Townwise estimates';

/** Every value in the same type, so a phone shows one size throughout the list. */
function Lines(props: { lines: readonly string[] }): React.JSX.Element {
  return <Stack gap={theme.space[1]}>{props.lines.map((line) => <Small key={line}>{line}</Small>)}</Stack>;
}

export function noForecastLine(about: Pick<EstimatesAbout, 'location'>): string {
  return `Townwise has no forecast for ${about.location.name} yet. Home and TownwiseAI use your history and ${about.location.town.name}’s calendar until it does.`;
}

/** U13B: a percentage with at most one decimal, "4.8%". */
function pct(value: number): string {
  return `${String(Math.round(value * 10) / 10)}%`;
}

const TRAINED_ON: Readonly<Record<ForecastRun['trainingSource'], string>> = {
  files_from_owner: 'sales exports you sent Townwise',
};

/** U13B: "Forecast: Townwise demand model v3, trained on sales exports you sent Townwise from ... made Nov 1, 2026." */
export function runLines(run: ForecastRun): string[] {
  const lines = [
    `Forecast: ${run.model.label}, trained on ${TRAINED_ON[run.trainingSource]} from ${formatDate(run.trainedFrom)} to ${formatDate(run.dataThrough)}, made ${formatDate(run.madeAt)}. It saw no sales after ${formatDate(run.dataThrough)}.`,
    'Each day and week is a range that about 8 in 10 days should land inside.',
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
  return `So far: ${String(live.inRange)} of ${String(live.days)} days inside the range${miss}, from ${formatDate(live.from)} to ${formatDate(live.to)}.`;
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

function Card(props: { about: EstimatesAbout }): React.JSX.Element {
  const { about } = props;
  const { card, today } = about;
  const noHeadcount = about.people.headcountInputs.length === 0;
  const { run } = about.forecast;
  return (
    <Stack>
      {run === null ? (
        <View style={styles.state}>
          <StatusTag kind="progress" label="In progress" />
          <Small white>{noForecastLine(about)}</Small>
        </View>
      ) : (
        // U13B: the published run, then how it has done.
        <Stack gap={theme.space[2]}>
          {runLines(run).map((line, index) => (index === 0 ? <Small key={line} white>{line}</Small> : <Small key={line}>{line}</Small>))}
          <Small white>{liveLine(about.forecast.live)}</Small>
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
  const { state, reload } = useLoad(useCallback(() => fetchEstimatesAbout(api, locationId), [api, locationId]));
  return (
    <Panel label={MODEL_CARD_TITLE}>
      <Stack>
        <Heading>{MODEL_CARD_TITLE}</Heading>
        {state.status === 'loading' ? <LoadingLine text="Loading how Townwise estimates…" /> : null}
        {state.status === 'failed' ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' ? <Card about={state.data} /> : null}
      </Stack>
    </Panel>
  );
}

const styles = StyleSheet.create({
  state: { gap: theme.space[2] },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[2], rowGap: theme.space[1] },
});
