import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { cellSizes } from '../calendar/model';
import { BlockRow, GUTTER } from '../home/Block';
import { Actions } from '../ui/Button';
import { Columns, Pair, Panel, Section, Stack } from '../ui/layout';
import {
  Skeleton, SkeletonBlock, SkeletonButton, SkeletonChart, SkeletonDefinitions, SkeletonField, SkeletonFigure, SkeletonHeading, SkeletonPanel,
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

const WEEKS = 6;
const DAYS = 7;

/** A month as a grid of `WEEKS` rows of seven cells under a weekday head, always 42 cells, so the grid never changes height. */
function SkeletonMonth(props: { cellTestID: string; cellHeight: number }): React.JSX.Element {
  return (
    <View style={styles.month}>
      <View style={styles.monthRow}>
        {Array.from({ length: DAYS }, (_, day) => (
          <View key={day} style={styles.monthHead}><SkeletonText type="mono" width="60%" /></View>
        ))}
      </View>
      {Array.from({ length: WEEKS }, (_, week) => (
        <View key={week} style={styles.monthRow}>
          {Array.from({ length: DAYS }, (_, day) => (
            <View key={day} testID={props.cellTestID} style={[styles.monthCell, { minHeight: props.cellHeight }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * P11 Home: the lead line with Ask TownwiseAI, At a glance's three tiles, This week, This month's grid beside its
 * day and Last week, then On the calendar and Who's in town (the blocks of Home.tsx, in its 12-column rows).
 */
export function HomeSkeleton(props: LabelProps): React.JSX.Element {
  const { desktop } = useBreakpoint();
  return (
    <Skeleton name="home" label={props.label}>
      <View style={styles.page}>
        <View style={[styles.lead, desktop ? styles.leadWide : null]}>
          <View style={styles.leadText}><SkeletonText type="mono" width="70%" /></View>
          <Actions><SkeletonButton width={170} /></Actions>
        </View>
        <BlockRow
          tablet
          items={['week', 'last', 'next'].map((key) => ({
            key, span: 4,
            node: (
              <SkeletonPanel>
                <SkeletonHeading kicker width={180} />
                <SkeletonFigure width={120} />
                <SkeletonText lines={2} />
              </SkeletonPanel>
            ),
          }))}
        />
        <SkeletonPanel>
          <SkeletonHeading kicker width={240} />
          {desktop ? (
            <View style={styles.strip}>
              {Array.from({ length: DAYS }, (_, day) => (
                <View key={day} style={styles.stripDay}><SkeletonText type="ui" lines={3} /><SkeletonBlock height={40} /></View>
              ))}
            </View>
          ) : (
            <SkeletonTable columns={[{}, { flex: 1.5 }, { flex: 1.5 }, { flex: 1.5 }]} rows={DAYS} />
          )}
        </SkeletonPanel>
        <BlockRow
          items={[
            {
              key: 'month', span: 8,
              node: (
                <SkeletonPanel>
                  <SkeletonHeading kicker width={160} />
                  <SkeletonHeading width={260} />
                  <SkeletonText width="70%" />
                  <View style={styles.split}>
                    <View style={styles.gridSide}><SkeletonMonth cellTestID="skeleton-home-month-cell" cellHeight={52} /></View>
                    <View style={styles.detailSide}><SkeletonText lines={4} /></View>
                  </View>
                  <SkeletonButton link width={160} />
                </SkeletonPanel>
              ),
            },
            {
              key: 'last', span: 4,
              node: (
                <SkeletonPanel>
                  <SkeletonHeading kicker width={120} />
                  <SkeletonFigure width={120} />
                  <SkeletonText lines={3} />
                </SkeletonPanel>
              ),
            },
          ]}
        />
        <BlockRow
          items={[
            {
              key: 'list', span: 6,
              node: (
                <SkeletonPanel>
                  <SkeletonHeading kicker width={140} />
                  <SkeletonHeading width={240} />
                  <SkeletonText lines={3} />
                </SkeletonPanel>
              ),
            },
            {
              key: 'people', span: 6,
              node: (
                <SkeletonPanel>
                  <SkeletonHeading kicker width={160} />
                  <SkeletonHeading width={160} />
                  <SkeletonText width="80%" />
                  <SkeletonText type="ui" lines={3} />
                  <SkeletonText type="ui" lines={2} />
                </SkeletonPanel>
              ),
            },
          ]}
        />
      </View>
    </Skeleton>
  );
}

/**
 * P27 Calendar: the toolbar (month switcher, filter chips, the calendar file's control), then the month's grid, always
 * six weeks of seven days, with the day panel beside it from 1024px and under it below.
 */
export function CalendarSkeleton(props: LabelProps): React.JSX.Element {
  const { desktop, width } = useBreakpoint();
  return (
    <Skeleton name="calendar" label={props.label}>
      <View style={styles.calendar}>
        <View style={[styles.bar, desktop ? styles.barWide : null]}>
          <View style={styles.switcher}>
            <SkeletonButton width={44} />
            <SkeletonBlock height={theme.type.ui.fontSize} width={128} />
            <SkeletonButton width={44} />
            <SkeletonButton link width={48} />
          </View>
          <View style={styles.chips}>
            {[88, 96, 80, 104].map((chip) => <SkeletonButton key={chip} width={chip} />)}
          </View>
          <SkeletonButton width={170} />
        </View>
        <View style={desktop ? styles.split : styles.stacked}>
          <View style={desktop ? styles.wide : null}>
            <SkeletonMonth cellTestID="skeleton-calendar-cell" cellHeight={cellSizes(width).minHeight} />
          </View>
          <View testID="skeleton-calendar-panel" style={desktop ? styles.narrow : null}>
            <Stack gap={theme.space[5]}>
              <SkeletonHeading width={200} />
              <SkeletonText type="sub" lines={2} />
              <SkeletonDefinitions rows={3} />
              <SkeletonText lines={3} />
              <Actions><SkeletonButton width={140} /></Actions>
            </Stack>
          </View>
        </View>
      </View>
    </Skeleton>
  );
}

/** P28 Business rules: the add form (New rule, Change the forecast, Add rule) and a few rule rows under their head. */
export function RulesSkeleton(props: LabelProps): React.JSX.Element {
  return (
    <Skeleton name="rules" label={props.label}>
      <Stack gap={32}>
        <Columns
          main={(
            <Stack>
              <SkeletonField />
              <SkeletonButton link width={170} />
              <Actions><SkeletonButton width={120} /></Actions>
            </Stack>
          )}
        />
        <Section first>
          <SkeletonHeading kicker width={80} />
          <SkeletonHeading width={120} />
          <View style={styles.rules}>
            {[0, 1, 2].map((row) => (
              <View key={row} testID="skeleton-rules-row" style={styles.rule}>
                <SkeletonText type="sub" width="50%" />
                <SkeletonText type="ui" width="70%" />
                <SkeletonText type="ui" width="60%" />
                <Actions><SkeletonButton link width={40} /><SkeletonButton link width={56} /></Actions>
              </View>
            ))}
          </View>
        </Section>
      </Stack>
    </Skeleton>
  );
}

const styles = StyleSheet.create({
  page: { gap: GUTTER },
  lead: { gap: theme.space[4], marginBottom: theme.space[4] },
  leadWide: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: theme.space.gutter },
  leadText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  strip: { flexDirection: 'row', columnGap: theme.space[3] },
  stripDay: { flex: 1, minWidth: 0, gap: theme.space[2] },
  split: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[6], rowGap: theme.space[5], alignItems: 'flex-start' },
  gridSide: { flexGrow: 1, flexShrink: 1, flexBasis: 280, maxWidth: 420, minWidth: 0 },
  detailSide: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0 },
  month: { gap: 3, width: '100%' },
  monthRow: { flexDirection: 'row', gap: 3 },
  monthHead: { flex: 1, alignItems: 'center' },
  monthCell: { flex: 1, minWidth: 0, backgroundColor: c.raised },
  calendar: { gap: theme.space[6] },
  bar: { gap: theme.space[4] },
  barWide: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: theme.space[8], rowGap: theme.space[4] },
  switcher: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[3] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[2], rowGap: theme.space[2] },
  stacked: { gap: theme.space[8] },
  wide: { flex: 8, minWidth: 0 },
  narrow: { flex: 4, minWidth: 0 },
  rules: { borderTopWidth: 1, borderTopColor: c.border, maxWidth: 720 },
  rule: { gap: theme.space[1], paddingVertical: theme.space[4], borderBottomWidth: 1, borderBottomColor: c.border },
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
