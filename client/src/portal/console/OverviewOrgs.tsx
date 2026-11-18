import { StyleSheet, View } from 'react-native';

import { formatCount, formatDate } from '../format';
import { DataTable, RowLink, type Column } from '../ui/DataTable';
import { Mono } from '../ui/text';
import { orgHref } from './links';
import { forecastDetail, forecastFigure, spendWords } from './overview';
import type { OverviewLocation, OverviewOrg } from './schemas';
import { OUTCOME_WORDS } from './WeeklyRefresh';

// The Overview's organizations (P32, design decision 7): one row per organization, as the server sorts them (actions in
// the window, most first, then name), each opening its page (P21). Counts, dates, live accuracy and TownwiseAI spend only
// (D7). Each head says its span: the window, all time, the latest week or this month. A location's forecast leads with
// its share of scored days in range, the newest run used on the window's passed days and its typical error under it.
// Ten columns do not fit below 1024px, so there the rows stack as on phones rather than scroll sideways. Status keeps the
// console's words (“Active” is not suspended); the usage columns say “used the app”, never a bare “active”.

function columnsOf(days: number): readonly Column[] {
  const window = `${String(days)} days`;
  return [
    { key: 'name', label: 'Organization', flex: 1.6 },
    { key: 'status', label: 'Status' },
    { key: 'active', label: 'Last day used' },
    { key: 'people', label: `People who used the app (${window})`, numeric: true },
    { key: 'actions', label: `Actions (${window})`, numeric: true },
    { key: 'days', label: 'Days of sales (all time)', numeric: true },
    { key: 'upload', label: 'Last upload' },
    { key: 'forecast', label: `Forecast (${window})`, flex: 2.6 },
    { key: 'refresh', label: 'Weekly refresh (latest week)', flex: 1.6 },
    { key: 'chat', label: 'TownwiseAI (this month, UTC)', flex: 1.2 },
  ];
}

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
  return (
    <View style={styles.lines}>
      {org.locations.map((location) => {
        const detail = forecastDetail(location);
        return (
          <View key={location.id}>
            <Mono tone="white" style={styles.line}>{named(org, location, forecastFigure(location))}</Mono>
            {detail === null ? null : <Mono tone="text3" style={styles.line}>{detail}</Mono>}
          </View>
        );
      })}
    </View>
  );
}

function refreshCell(org: OverviewOrg): React.ReactNode {
  if (org.locations.length === 0) return '';
  return <Lines lines={org.locations.map((location) => named(org, location, refreshWords(location)))} />;
}

function statusWords(org: OverviewOrg): string {
  const status = org.status === 'active' ? 'Active' : 'Suspended';
  return org.inSetup ? `${status}, in setup` : status;
}

export function OverviewOrgs(props: { orgs: readonly OverviewOrg[]; days: number }): React.JSX.Element {
  return (
    <DataTable
      label="Organizations"
      stack="belowDesktop"
      columns={columnsOf(props.days)}
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
