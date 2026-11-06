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
import { fetchEstimatesAbout, type EstimatesAbout } from './api';
import { dayText } from './format';

// "How Townwise estimates" (spec 13.2), the model card: what Townwise's estimates read, what they can't see, their
// known limits, how they are checked and who can see the model, from GET .../estimates/about so the card and
// TownwiseAI say the same thing. Then this location's state, said plainly: no forecast yet (In progress), how far
// its town's calendar is researched, and whether any headcount input is (Planned until one is). Mounted on Analytics
// and opened from the Agent page's "How TownwiseAI works"; forecast runs add the run state.

export const MODEL_CARD_TITLE = 'How Townwise estimates';

/** Every value in the same type, so a phone shows one size throughout the list. */
function Lines(props: { lines: readonly string[] }): React.JSX.Element {
  return <Stack gap={theme.space[1]}>{props.lines.map((line) => <Small key={line}>{line}</Small>)}</Stack>;
}

export function noForecastLine(about: Pick<EstimatesAbout, 'location'>): string {
  return `Townwise has no forecast for ${about.location.name} yet. Home and TownwiseAI use your history and ${about.location.town.name}’s calendar until it does.`;
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
  return (
    <Stack>
      <View style={styles.state}>
        <StatusTag kind="progress" label="In progress" />
        <Small white>{noForecastLine(about)}</Small>
      </View>
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
