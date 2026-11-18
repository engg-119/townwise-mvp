import { useCallback, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { ActivityChart } from '../../../../../src/portal/console/ActivityChart';
import { fetchOverview } from '../../../../../src/portal/console/api';
import { AttentionList } from '../../../../../src/portal/console/AttentionList';
import {
  activitySummary, attentionLines, dayActions, GROUP_LABEL, overviewDaysOf, overviewHref, recordingLine, tilesOf,
} from '../../../../../src/portal/console/overview';
import { OverviewOrgs } from '../../../../../src/portal/console/OverviewOrgs';
import { FilterTabs } from '../../../../../src/portal/console/parts';
import { ACTION_GROUPS, OVERVIEW_DAYS, type Overview } from '../../../../../src/portal/console/schemas';
import { StatTiles } from '../../../../../src/portal/console/StatTiles';
import { formatCount, formatDate } from '../../../../../src/portal/format';
import { useLoad } from '../../../../../src/portal/hooks';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { OverviewSkeleton } from '../../../../../src/portal/skeleton';
import { Button, DataTable, EmptyState, ErrorNotice, Section, Small, Stack } from '../../../../../src/portal/ui';

// P32. Overview (/admin/overview, staff): openspec change staff-overview, design decision 7; where staff land. How many
// organizations and people used Townwise in the window and what they did, against the window before; what needs a staff
// member's attention; activity by day; and each organization's usage and forecast health. Counts, dates and live
// accuracy only (D7). The window is ?days= (7, 28 or 90; 28 with none). A change of window keeps the last answer on the
// page until the next one arrives, so nothing flashes and the tabs stay put: the skeleton shows only before the first
// answer, and a failed read shows the error with Try again.

/** The day-by-day numbers the chart draws, for screen readers and on native: hidden until asked for. */
function EachDay(props: { overview: Overview }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { series } = props.overview;
  return (
    <Stack gap={12}>
      <Button
        variant="link"
        label={open ? 'Hide each day' : 'Show each day'}
        expanded={open}
        {...(open ? { controls: 'overview-each-day' } : {})}
        onPress={() => { setOpen((value) => !value); }}
      />
      {open ? (
        <View nativeID="overview-each-day">
          <DataTable
            label="Activity by day"
            columns={[
              { key: 'day', label: 'Day (UTC)', flex: 1.2 },
              { key: 'people', label: 'People active', numeric: true },
              { key: 'actions', label: 'Actions', numeric: true },
              ...ACTION_GROUPS.map((group) => ({ key: group, label: GROUP_LABEL[group], numeric: true })),
            ]}
            rows={[...series].reverse().map((day) => ({
              key: day.day,
              cells: {
                day: formatDate(day.day),
                people: formatCount(day.activePeople),
                actions: formatCount(dayActions(day)),
                ...Object.fromEntries(ACTION_GROUPS.map((group) => [group, formatCount(day.actions[group])])),
              },
            }))}
          />
        </View>
      ) : null}
    </Stack>
  );
}

function OverviewBody(props: { overview: Overview }): React.JSX.Element {
  const { overview } = props;
  return (
    <>
      <Stack gap={20}>
        <Small>{recordingLine(overview.recordingSince)}</Small>
        <StatTiles tiles={tilesOf(overview)} />
      </Stack>
      <Section title="Needs attention">
        <AttentionList lines={attentionLines(overview)} />
      </Section>
      <Section title="Activity by day">
        <ActivityChart series={overview.series} />
        <Small>{activitySummary(overview.series, overview.window.days)}</Small>
        <Small>An action is a recorded event, not a click: some single steps record two, as a dropped sales file does once it is read.</Small>
        <EachDay overview={overview} />
      </Section>
      <Section title="Organizations">
        {overview.orgs.length === 0
          ? <EmptyState text="No organizations yet. Approve a request or create one." />
          : <OverviewOrgs orgs={overview.orgs} />}
      </Section>
    </>
  );
}

export default function OverviewPage(): React.JSX.Element {
  const { api } = usePortal();
  const params = useLocalSearchParams<{ days?: string }>();
  const days = overviewDaysOf(params.days);
  const { state, reload } = useLoad(useCallback(() => fetchOverview(api, days), [api, days]));
  // The last answer, held while another window's loads, so the page keeps its figures until the next arrive.
  const [held, setHeld] = useState<Overview | null>(null);
  if (state.status === 'ready' && state.data !== held) setHeld(state.data);
  const shown = state.status === 'ready' ? state.data : held;

  let body: React.ReactNode;
  if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={reload} />;
  } else if (shown === null) {
    body = <OverviewSkeleton label="Loading the overview" />;
  } else {
    body = (
      <>
        {state.status === 'loading' ? <Text role="status" style={styles.unseen}>{`Loading ${String(days)} days`}</Text> : null}
        <OverviewBody overview={shown} />
      </>
    );
  }

  const tabs = OVERVIEW_DAYS.map((value) => ({ label: `${String(value)} days`, href: overviewHref(value), current: value === days }));
  return (
    <Page title="Overview">
      <Stack gap={24}>
        <FilterTabs label="Window" tabs={tabs} />
        <Stack gap={0}>{body}</Stack>
      </Stack>
    </Page>
  );
}

const styles = StyleSheet.create({
  unseen: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
