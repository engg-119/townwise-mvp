import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { ActivityChart } from '../../../../../src/portal/console/ActivityChart';
import { fetchOverview } from '../../../../../src/portal/console/api';
import { AttentionList } from '../../../../../src/portal/console/AttentionList';
import {
  activitySummary, attentionLines, dayActions, GROUP_LABEL, overviewDaysOf, overviewHref, recordingLine, tilesOf, windowLine,
} from '../../../../../src/portal/console/overview';
import { OverviewOrgs } from '../../../../../src/portal/console/OverviewOrgs';
import { FilterTabs } from '../../../../../src/portal/console/parts';
import { ACTION_GROUPS, OVERVIEW_DAYS, type Overview } from '../../../../../src/portal/console/schemas';
import { StatTiles } from '../../../../../src/portal/console/StatTiles';
import { theme } from '../../../../../src/theme';
import { formatCount, formatDate } from '../../../../../src/portal/format';
import { useBreakpoint, useLoad } from '../../../../../src/portal/hooks';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { OverviewSkeleton } from '../../../../../src/portal/skeleton';
import { Button, DataTable, EmptyState, ErrorNotice, Section, Small, Stack, useFocusMessage } from '../../../../../src/portal/ui';
import { useMessageTarget } from '../../../../../src/portal/ui/messageFocus';

// P32. Overview (/admin/overview, staff): openspec change staff-overview, design decision 7; where staff land. How many
// organizations and people used Townwise in the window and what they did, against the window before; what needs a staff
// member's attention; activity by day; and each organization's usage and forecast health. Counts, dates and live
// accuracy only (D7). The window is ?days= (7, 28 or 90; 28 with none). A change of window keeps the last answer on the
// page until the next one arrives, so nothing flashes and the tabs stay put, but dimmed, aria-busy and inert, under a
// line that says what is loading and which window the figures still shown are for. That line sits in a slot whose
// height is kept in every state, so nothing moves when it changes. The skeleton shows only before the first answer; a
// failed read shows the error with Try again in place of the figures, so no figures stay under a tab they are not for,
// and Try again moves focus to the line (useFocusMessage), since the button goes with the error.

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

/**
 * The window line's slot: two lines of small text on phones and one from 641px, kept in every state so the figures
 * never move when it changes. It takes focus after Try again.
 */
function WindowLine(props: { text: string }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const target = useMessageTarget(props.text);
  return (
    <View testID="overview-window" {...target} style={phone ? styles.slotPhone : styles.slot}>
      <Text role="status" aria-live="polite" style={[phone ? theme.type.sub : theme.type.small, styles.line]}>{props.text}</Text>
    </View>
  );
}

/** The figures on the page; while the next window loads, dimmed, aria-busy and inert (no focus, no press). */
function Figures(props: { busy: boolean; children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (Platform.OS === 'web') (ref.current as unknown as HTMLElement | null)?.toggleAttribute('inert', props.busy);
  }, [props.busy]);
  return <View ref={ref} testID="overview-figures" aria-busy={props.busy} style={props.busy ? styles.busy : null}>{props.children}</View>;
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
  const focusMessage = useFocusMessage();
  const retry = useCallback(() => { focusMessage(); reload(); }, [focusMessage, reload]);

  let body: React.ReactNode;
  if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={retry} />;
  } else {
    body = (
      <>
        <WindowLine text={windowLine(days, shown?.window ?? null, state.status === 'loading')} />
        {shown === null
          ? <OverviewSkeleton label="Loading the overview" />
          : <Figures busy={state.status === 'loading'}><OverviewBody overview={shown} /></Figures>}
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
  slot: { minHeight: 20, marginBottom: 20 },
  slotPhone: { minHeight: 48, marginBottom: 20 },
  line: { color: theme.color.white },
  busy: { opacity: 0.6 },
});
