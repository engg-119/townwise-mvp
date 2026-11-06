import { Fragment } from 'react';
import { Link, type Href } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { theme } from '../../theme';
import { formatDate, plural } from '../format';
import { inlineTarget } from '../ui/text';

// One mono text3 line under any card that shows an estimate (spec 13.2): where its figures came from. People in town
// names each source's host as a link and says the county jobs year; history names the owner's own sales and days.
// Forecast runs add their own kind.

export type Provenance =
  | { kind: 'people'; hosts: readonly { host: string; url: string }[]; jobsYear: number | null }
  | { kind: 'history'; first: string; last: string; days: number };

function listed(count: number, index: number): string {
  if (index === count - 1) return '';
  return index === count - 2 ? ' and ' : ', ';
}

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
    <Text style={styles.line}>
      From{' '}
      {hosts.map((source, index) => (
        <Fragment key={source.url}>
          <Link href={source.url as Href} style={styles.link}>{source.host}</Link>
          {listed(hosts.length, index)}
        </Fragment>
      ))}
      .{jobs}
    </Text>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  line: { ...theme.type.mono, color: c.text3 },
  link: { ...inlineTarget, color: c.text2, textDecorationLine: 'underline', textDecorationColor: c.line },
});
