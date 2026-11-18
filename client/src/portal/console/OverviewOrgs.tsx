import { StyleSheet, View } from 'react-native';

import { formatCount, formatDate } from '../format';
import { DataTable, RowLink, type Column } from '../ui/DataTable';
import { Mono } from '../ui/text';
import { orgHref } from './links';
import { forecastWords, spendWords } from './overview';
import type { OverviewLocation, OverviewOrg } from './schemas';
import { OUTCOME_WORDS } from './WeeklyRefresh';

// The Overview's organizations (P32, design decision 7): one row per organization, as the server sorts them (actions in
// the window, most first, then name), each opening its page (P21). Counts, dates, live accuracy and TownwiseAI spend only
// (D7). A location's forecast is the newest run used on the window's passed days and that window's live accuracy.

const COLUMNS: readonly Column[] = [
  { key: 'name', label: 'Organization', flex: 1.6 },
  { key: 'status', label: 'Status' },
  { key: 'active', label: 'Last active' },
  { key: 'people', label: 'People active', numeric: true },
  { key: 'actions', label: 'Actions', numeric: true },
  { key: 'days', label: 'Days of sales', numeric: true },
  { key: 'upload', label: 'Last upload' },
  { key: 'forecast', label: 'Forecast on these days', flex: 2.6 },
  { key: 'refresh', label: 'Weekly refresh', flex: 1.6 },
  { key: 'chat', label: 'TownwiseAI this month', flex: 1.2 },
];

/** Lines in the table's mono style, one per location, each named when the organization has more than one. */
function Lines(props: { lines: readonly string[] }): React.JSX.Element {
  return (
    <View style={styles.lines}>
      {props.lines.map((line, index) => <Mono key={index} style={styles.line}>{line}</Mono>)}
    </View>
  );
}

function named(org: OverviewOrg, location: OverviewLocation, words: string): string {
  return org.locations.length > 1 ? `${location.name}: ${words}` : words;
}

function refreshWords(location: OverviewLocation): string {
  const week = location.refresh === null ? 'No weekly refresh yet' : `Week of ${formatDate(location.refresh.week)}: ${OUTCOME_WORDS[location.refresh.outcome] ?? location.refresh.outcome}`;
  if (location.lastScheduled === 'failed') return `${week}; the last scheduled calibration failed`;
  if (location.lastScheduled === 'live') return `${week}; a scheduled calibration is running`;
  return week;
}

function forecastCell(org: OverviewOrg): React.ReactNode {
  if (!org.forecastsOn) return 'Forecasts off';
  if (org.locations.length === 0) return 'No locations';
  return <Lines lines={org.locations.map((location) => named(org, location, forecastWords(location)))} />;
}

function refreshCell(org: OverviewOrg): React.ReactNode {
  if (org.locations.length === 0) return '';
  return <Lines lines={org.locations.map((location) => named(org, location, refreshWords(location)))} />;
}

function statusWords(org: OverviewOrg): string {
  const status = org.status === 'active' ? 'Active' : 'Suspended';
  return org.inSetup ? `${status}, in setup` : status;
}

export function OverviewOrgs(props: { orgs: readonly OverviewOrg[] }): React.JSX.Element {
  return (
    <DataTable
      label="Organizations"
      columns={COLUMNS}
      rows={props.orgs.map((org) => ({
        key: org.id,
        href: orgHref(org.id),
        cells: {
          name: <RowLink href={orgHref(org.id)} label={org.name} />,
          status: statusWords(org),
          active: org.lastActiveDay === null ? 'None recorded' : formatDate(org.lastActiveDay),
          people: formatCount(org.activePeople),
          actions: formatCount(org.actions),
          days: formatCount(org.salesDayCount),
          upload: org.lastUploadAt === null ? 'None yet' : formatDate(org.lastUploadAt),
          forecast: forecastCell(org),
          refresh: refreshCell(org),
          chat: spendWords(org.chat),
        },
      }))}
    />
  );
}

const styles = StyleSheet.create({
  lines: { gap: 4, paddingVertical: 2 },
  line: { flexShrink: 1 },
});
