import { StyleSheet, View } from 'react-native';

import { Split } from '../console/parts';
import { useBreakpoint } from '../hooks';
import { Actions } from '../ui/Button';
import { Section, Stack } from '../ui/layout';
import {
  Skeleton, SkeletonButton, SkeletonDefinitions, SkeletonField, SkeletonHeading, SkeletonPanel, SkeletonTable, SkeletonText,
} from './kit';

// The loading state of each staff console page (spec 16.4): the page's tables with their columns, the Requests
// split and the Organization's sections, in skeleton shapes, with the page's loading words as the status line.
// Console rows hold a 44px link or buttons, so they are 56px tall.

interface LabelProps { label: string }

const ROW = 56;

/** P19 Requests: the table beside (from 1200px) or above the selected request's panel. */
export function RequestsSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="requests" label={props.label}>
      <Split
        table={(
          <SkeletonTable
            columns={[{ flex: 1.4 }, { flex: 1.2 }, { flex: 1.4 }, {}, { flex: 0.8, numeric: true }, {}]}
            rows={4}
            rowHeight={ROW}
          />
        )}
        detail={(
          <SkeletonPanel>
            <SkeletonHeading kicker width={220} />
            <SkeletonDefinitions rows={6} />
            <SkeletonText lines={2} />
            <Actions><SkeletonButton width={110} /><SkeletonButton width={90} /><SkeletonButton link width={70} /></Actions>
          </SkeletonPanel>
        )}
      />
    </Skeleton>
  );
}

/** P20 Organizations: the name and status filters, then the table. */
export function OrgsSkeleton(props: LabelProps): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <Skeleton name="orgs" label={props.label}>
      <Stack gap={20}>
        <View style={phone ? styles.filtersStacked : styles.filters}>
          <View style={styles.filter}><SkeletonField /></View>
          <View style={styles.filter}><SkeletonField /></View>
        </View>
        <SkeletonTable
          columns={[
            { flex: 1.6 }, {}, { numeric: true }, { numeric: true }, { numeric: true }, { numeric: true }, { numeric: true }, {}, {},
          ]}
          rows={5}
          rowHeight={ROW}
        />
      </Stack>
    </Skeleton>
  );
}

/** P21 Organization: its facts, then Team, Locations and Recent activity. */
export function OrgSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="org" label={props.label}>
      <Stack gap={12}>
        <SkeletonText type="mono" width={320} />
        <SkeletonText width="70%" />
      </Stack>
      <Section>
        <SkeletonHeading width={100} />
        <SkeletonTable columns={[{ flex: 3 }, { flex: 0.7 }, { flex: 0.7 }, {}, { flex: 2 }]} rows={3} rowHeight={ROW} />
      </Section>
      <Section>
        <SkeletonHeading kicker width={140} />
        <SkeletonTable
          columns={[{ flex: 1.4 }, { flex: 1.2 }, { flex: 0.7, numeric: true }, {}, {}, { flex: 0.7, numeric: true }, {}]}
          rows={2}
        />
        <SkeletonText width="80%" />
      </Section>
      <Section>
        <SkeletonHeading kicker width={200} />
        <SkeletonTable columns={[{}, { flex: 1.4 }, { flex: 1.8 }]} rows={4} rowHeight={ROW} />
        <SkeletonButton link width={260} />
      </Section>
    </Skeleton>
  );
}

/** P22 People, under the filters and the lookup: everyone's table and its line. */
export function PeopleSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="people" label={props.label}>
      <Stack gap={16}>
        <SkeletonTable columns={[{ flex: 3 }, {}, { flex: 1.3 }, {}, {}, { flex: 2 }]} rows={5} rowHeight={ROW} />
        <SkeletonText width="80%" />
      </Stack>
    </Skeleton>
  );
}

/** P23 Audit log, under the filters: the events table and its note. */
export function AuditSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="audit" label={props.label}>
      <Stack gap={16}>
        <SkeletonTable columns={[{}, { flex: 1.4 }, { flex: 1.8 }, { flex: 1.2 }, { flex: 1.6 }]} rows={6} rowHeight={ROW} />
        <SkeletonText lines={2} />
      </Stack>
    </Skeleton>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', columnGap: 20, alignItems: 'flex-start' },
  filtersStacked: { gap: 20 },
  filter: { flex: 1, minWidth: 0, maxWidth: 360 },
});
