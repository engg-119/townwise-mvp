import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatDate, plural } from '../format';
import { SourceChips } from '../ui/SourceChip';

// One mono text3 line under any card that shows an estimate (spec 13.2): where its figures came from. People in town
// says "From" then each source as a chip (ui/SourceChip.tsx), then the county jobs year; history names the owner's own
// sales and days. Forecast runs add their own kind.

export type Provenance =
  | { kind: 'people'; hosts: readonly { host: string; url: string }[]; jobsYear: number | null }
  | { kind: 'history'; first: string; last: string; days: number };

export function Provenance(props: { provenance: Provenance }): React.JSX.Element {
  const { provenance } = props;
  if (provenance.kind === 'history') {
    return (
      <Text style={styles.line}>
        {`From your sales, ${formatDate(provenance.first)} to ${formatDate(provenance.last)}, ${plural(provenance.days, 'day', 'days')}.`}
      </Text>
    );
  }
  const { hosts, jobsYear } = provenance;
  const jobs = jobsYear === null ? '' : ` County jobs are ${String(jobsYear)}.`;
  if (hosts.length === 0) return <Text style={styles.line}>{`No public source for these days yet.${jobs}`}</Text>;
  return (
    <View style={styles.people}>
      <View style={styles.from}>
        <Text style={[styles.line, styles.lead]}>From</Text>
        <View style={styles.chips}><SourceChips sources={hosts} /></View>
      </View>
      {jobsYear === null ? null : <Text style={styles.line}>{`County jobs are ${String(jobsYear)}.`}</Text>}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  line: { ...theme.type.mono, color: c.text3 },
  people: { minWidth: 0 },
  from: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space[2], minWidth: 0 },
  // "From" sits beside the first row of chips: its 16px line centered in their 44px targets.
  lead: { paddingVertical: 14 },
  chips: { flex: 1, minWidth: 0 },
});
