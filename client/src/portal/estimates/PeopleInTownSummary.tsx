import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { ErrorNotice, StatusTag } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { fetchPeopleInTown, monthRange, type PeopleInTown } from './api';
import { headcountLines, historyLine, noNumberLine, sourceHosts, termLines } from './format';
import { Provenance } from './Provenance';

// People in town for one month (spec 13.2), for Home's "This month in {Town}" card in place of its Planned line: the
// term periods in words, each with its headcount range where public counts support one (otherwise the honest "can't
// put a number on it" line with a Planned tag), the location's own Saturdays (or busiest weekday) in term and between
// terms, and where it all came from. No heading: the card it sits in has one.

export const PLANNED_HEADCOUNT = 'A headcount from public counts is planned.';

function Lines(props: { window: PeopleInTown }): React.JSX.Element {
  const { window } = props;
  const { town } = window;
  if (!window.available) return <Small>{`Townwise hasn’t researched ${town.name}, ${town.state} yet.`}</Small>;
  const counted = headcountLines(window);
  const history = historyLine(window.yourHistory);
  const historyDays = window.yourHistory.cells.reduce((sum, cell) => sum + cell.days, 0);
  const { first, last } = window.yourHistory;
  return (
    <Stack gap={theme.space[2]}>
      {(counted.length === 0 ? termLines(window) : counted).map((line) => <Small key={line}>{line}</Small>)}
      {counted.length === 0 ? (
        <View style={styles.planned}>
          <Small>{noNumberLine(town)}</Small>
          <View style={styles.tagRow}>
            <StatusTag kind="planned" label="Planned" />
            <Small>{PLANNED_HEADCOUNT}</Small>
          </View>
        </View>
      ) : null}
      {history === null ? null : <Small>{history}</Small>}
      <Provenance provenance={{ kind: 'people', hosts: sourceHosts(window.sources), jobsYear: window.season[0]?.baseYear ?? null }} />
      {history === null || first === null || last === null ? null : (
        <Provenance provenance={{ kind: 'history', first, last, days: historyDays }} />
      )}
    </Stack>
  );
}

export function PeopleInTownSummary(props: { locationId: string; month: string }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, month } = props;
  const { state, reload } = useLoad(useCallback(() => fetchPeopleInTown(api, locationId, monthRange(month)), [api, locationId, month]));
  if (state.status === 'loading') return <Small>Loading who’s in town…</Small>;
  if (state.status === 'failed') return <ErrorNotice error={state.error} onRetry={reload} />;
  return <Lines window={state.data} />;
}

const styles = StyleSheet.create({
  planned: { gap: theme.space[2] },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[2], rowGap: theme.space[1] },
});
