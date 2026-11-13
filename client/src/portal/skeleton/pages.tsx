import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Actions } from '../ui/Button';
import { Columns, Pair, Panel, Section, Stack } from '../ui/layout';
import {
  Skeleton, SkeletonBlock, SkeletonButton, SkeletonChart, SkeletonDefinitions, SkeletonField, SkeletonHeading, SkeletonPanel,
  SkeletonTable, SkeletonText, type SkeletonColumn,
} from './kit';

// The loading state of each client app, gate and account page (spec 16.2, 16.3): the page's own sections, columns
// and tables in skeleton shapes, inside the frame and header the page already draws, with the page's loading words
// as the one status line. Each page passes its words (`label`), so they stay where they were.

const c = theme.color;

interface LabelProps { label: string }

/** A table on its own (Team's members, Your data's items): the table's columns, a few rows. */
export function TableSkeleton(props: LabelProps & { name: string; columns: readonly SkeletonColumn[]; rows?: number; rowHeight?: number }): React.JSX.Element {
  return (
    <Skeleton name={props.name} label={props.label}>
      <SkeletonTable
        columns={props.columns}
        {...(props.rows === undefined ? {} : { rows: props.rows })}
        {...(props.rowHeight === undefined ? {} : { rowHeight: props.rowHeight })}
      />
    </Skeleton>
  );
}

/** P9 Locations: Where each location stands (the table), then Your towns (a panel per town) and the caveats. */
export function LocationsSkeleton(props: LabelProps): React.JSX.Element {
  const { desktop } = useBreakpoint();
  return (
    <Skeleton name="locations" label={props.label}>
      <Section first>
        <SkeletonHeading kicker />
        <SkeletonTable
          columns={[{ flex: 1.2 }, {}, { flex: 1.2 }, {}, { flex: 0.8 }, { flex: 1.2 }]}
          rows={3}
          // The name's 44px link and the cell's padding.
          rowHeight={56}
        />
      </Section>
      <Section>
        <SkeletonHeading kicker width={200} />
        <View style={[styles.towns, desktop ? styles.townsRow : null]}>
          {[0, 1].map((town) => (
            <View key={town} style={desktop ? styles.town : null}>
              <Panel>
                <SkeletonHeading width={180} />
                <SkeletonText lines={2} />
                <SkeletonText width="70%" />
                <SkeletonText />
                <SkeletonText type="mono" width="80%" />
                <SkeletonButton link width={180} />
              </Panel>
            </View>
          ))}
        </View>
        <Stack gap={4}><SkeletonText type="mono" lines={3} /></Stack>
      </Section>
    </Skeleton>
  );
}

/**
 * P18 Settings for an org admin, which waits for the staff activity: Your account and Two-step sign-in, the
 * organization's name beside Add location, Townwise staff activity, Leave and Sign out.
 */
export function SettingsSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="settings" label={props.label}>
      <Section first>
        <Columns
          main={(
            <Section first>
              <SkeletonHeading kicker width={200} />
              <SkeletonDefinitions rows={3} />
              <SkeletonField helper />
              <Actions><SkeletonButton width={150} /></Actions>
            </Section>
          )}
          side={(
            <Section first>
              <SkeletonHeading kicker width={220} />
              <SkeletonText width={200} />
              <SkeletonButton link width={210} />
            </Section>
          )}
        />
      </Section>
      <Section>
        <Columns
          main={(
            <Section first>
              <SkeletonHeading kicker width={240} />
              <SkeletonField helper />
              <Actions><SkeletonButton width={130} /></Actions>
            </Section>
          )}
          side={(
            <Stack>
              <SkeletonText lines={3} />
              <Actions><SkeletonButton width={140} /></Actions>
            </Stack>
          )}
        />
      </Section>
      <Section>
        <SkeletonHeading kicker width={300} />
        <View style={styles.measure}><SkeletonText lines={5} /></View>
        <SkeletonTable columns={[{}, { flex: 1.4 }, { flex: 1.6 }, { flex: 1.2 }, { flex: 0.7 }]} rows={3} />
      </Section>
      <Section>
        <SkeletonHeading kicker width={220} />
        <SkeletonText width="80%" />
        <Actions><SkeletonButton width={140} /></Actions>
      </Section>
      <Section>
        <SkeletonHeading kicker width={120} />
        <SkeletonText lines={2} />
        <Actions><SkeletonButton width={110} /><SkeletonButton width={210} /></Actions>
      </Section>
    </Skeleton>
  );
}

/** P14 Notes, under the intro: Add a note, then Coming up and its table. */
export function NotesSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="notes" label={props.label}>
      <Stack gap={32}>
        <Actions><SkeletonButton width={120} /></Actions>
        <Section first>
          <SkeletonHeading kicker width={160} />
          <SkeletonTable
            columns={[{ flex: 1.5 }, { flex: 1.3 }, { flex: 1 }, { flex: 1.8 }, { flex: 1.3 }]}
            rows={3}
            // Two lines in a cell: the kind and its detail.
            rowHeight={58}
          />
        </Section>
      </Stack>
    </Skeleton>
  );
}

/**
 * P12 Sales data: the coverage lead and Upload, the daily chart (its text line on native, D21) with its summary and
 * “Show the numbers”, By month, and Uploads and files.
 */
export function SalesSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="sales" label={props.label}>
      <Columns
        main={(
          <Stack>
            <SkeletonText type="sub" lines={2} />
            <Actions><SkeletonButton width={200} /></Actions>
          </Stack>
        )}
      />
      <Section>
        <SkeletonHeading kicker width={220} />
        <Columns
          main={(
            <Stack gap={12}>
              {Platform.OS === 'web' ? <SalesChartSkeleton /> : <SkeletonText width="60%" />}
              <SkeletonText lines={2} />
              <SkeletonButton link width={150} />
            </Stack>
          )}
        />
      </Section>
      <Section>
        <SkeletonHeading kicker width={140} />
        <Columns
          main={(
            <Stack>
              <SkeletonTable columns={[{ flex: 1.4 }, { numeric: true }, { numeric: true }, { numeric: true }]} rows={6} stack={false} />
              <SkeletonText width="80%" />
            </Stack>
          )}
        />
      </Section>
      <Section>
        <SkeletonHeading width={200} />
        <Stack>
          <SkeletonText lines={2} />
          <Actions><SkeletonButton link width={120} /></Actions>
        </Stack>
      </Section>
    </Skeleton>
  );
}

/** The daily chart on web (SalesChart.web): its legend, the 196px frame beside the scale, the months and the scale line. */
function SalesChartSkeleton(): React.JSX.Element {
  return (
    <View style={styles.chart}>
      <SkeletonText type="mono" width={120} />
      <View style={styles.chartFrame}><SkeletonChart height={196} /></View>
      <View style={styles.chartFrame}><SkeletonText type="mono" /></View>
      <SkeletonText type="mono" width={200} />
    </View>
  );
}

/** P13 while the file is read: the Match columns step it opens on. */
export function UploadReadingSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="upload-reading" label={props.label}>
      <Stack gap={theme.space[6]} style={styles.read}>
        <Stack gap={theme.space[2]}>
          <SkeletonHeading width={200} />
          <SkeletonText lines={2} />
        </Stack>
        <Stack gap={theme.space[2]}>
          <SkeletonText type="ui" width={260} />
          <SkeletonBlock outline height={44} width={240} />
          <SkeletonBlock outline height={44} width={240} />
        </Stack>
        <SkeletonField helper />
        <Pair>
          <SkeletonField />
          <SkeletonField />
        </Pair>
        <Actions><SkeletonButton width={150} /><SkeletonButton link width={60} /><SkeletonButton link width={70} /></Actions>
      </Stack>
    </Skeleton>
  );
}

/** P13 while the days are sent: the result it opens on, its message lines and the Calibration panel. */
export function UploadSendingSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="upload-sending" label={props.label}>
      <Stack gap={theme.space[6]}>
        <View style={styles.messages}>
          {[0, 1].map((item) => (
            <View key={item} style={styles.message}><SkeletonText type="sub" width="70%" /></View>
          ))}
        </View>
        <SkeletonPanel>
          <SkeletonHeading kicker width={220} />
          <SkeletonText type="body" lines={2} />
          <SkeletonDefinitions rows={7} />
        </SkeletonPanel>
        <Actions><SkeletonButton width={160} /><SkeletonButton link width={100} /></Actions>
      </Stack>
    </Skeleton>
  );
}

/**
 * P3 Request access while it asks whether the Google Places search is on: Step 1, the search with its helper and
 * “Can’t find it?”, then Step 2's fields and Send request.
 */
export function RequestAccessSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="request-access" label={props.label}>
      <Stack gap={20}>
        <SkeletonHeading kicker width={240} />
        <SkeletonField helper />
        <Actions><SkeletonButton link width={260} /></Actions>
        <SkeletonHeading kicker width={160} />
        <SkeletonField helper />
        <Pair>
          <SkeletonField />
          <SkeletonField helper />
        </Pair>
        <Pair>
          <SkeletonField />
        </Pair>
        <SkeletonField helper height={132} />
        <Actions><SkeletonButton width={150} /></Actions>
      </Stack>
    </Skeleton>
  );
}

/** P7 Two-step sign-in while it reads whether two-step is on: the Before you start panel. */
export function SecuritySkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="security" label={props.label}>
      <SkeletonPanel>
        <SkeletonHeading width={200} />
        <SkeletonText lines={2} />
        <Actions><SkeletonButton width={220} /></Actions>
      </SkeletonPanel>
    </Skeleton>
  );
}

const styles = StyleSheet.create({
  towns: { gap: theme.space[5] },
  townsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  town: { flexGrow: 1, flexBasis: 320 },
  measure: { maxWidth: 680 },
  chart: { gap: 8 },
  // The chart's scale labels sit in the 72px to its left.
  chartFrame: { marginLeft: 72 },
  read: { maxWidth: 760 },
  messages: { borderTopWidth: 1, borderTopColor: c.border, maxWidth: 640 },
  message: { paddingVertical: 14, paddingLeft: 36, borderBottomWidth: 1, borderBottomColor: c.border },
});
