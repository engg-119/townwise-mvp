import { useCallback } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatCount, formatDate, plural, townLabel } from '../format';
import { useBreakpoint, useLoad } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { townResearchLine } from '../towns';
import { Actions, LinkButton } from '../ui/Button';
import { DefinitionList } from '../ui/DataTable';
import { ReadOnlyLine, StatusTag } from '../ui/feedback';
import { Columns, Panel, Section, Stack } from '../ui/layout';
import { Eyebrow, Heading, Small } from '../ui/text';
import { fetchSales, type Sales } from './api';
import { LoadFailure, Loading, Slot, UploadAction } from './parts';

// P11 Forecast (spec 16.3, 14): the calibration status with the data checks, Getting started 01 to 04, and the
// illustrative layout of what a forecast will show. Honest states only: no forecast numbers, ranges, reasons,
// progress or thresholds (14.2). The status reads GET .../sales, which also names who sent the last upload.

const READ_ONLY_ID = 'forecast-ro';

function Tagline(props: { kind: 'progress' | 'planned'; text: string }): React.JSX.Element {
  return (
    <View style={styles.tagline}>
      <StatusTag kind={props.kind} label={props.kind === 'progress' ? 'In progress' : 'Planned'} />
      <Small>{props.text}</Small>
    </View>
  );
}

function Step(props: {
  number: string;
  title: string;
  body: string;
  progress: string;
  selected?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const selected = props.selected === true;
  const progress = <Text style={[styles.progress, desktop ? styles.progressWide : null]}>{props.progress}</Text>;
  return (
    <View role="listitem" style={[styles.step, phone ? styles.stepPhone : null, selected ? styles.stepOn : null]}>
      <Text style={[styles.number, { width: phone ? 28 : 48 }]}>{props.number}</Text>
      <View style={styles.stepBody}>
        <View style={styles.stepTitle}>
          <View style={[styles.square, selected ? styles.squareOn : null]} />
          <Heading level={3} style={selected ? styles.titleOn : null}>{props.title}</Heading>
        </View>
        <Small>{props.body}</Small>
        {props.children}
        {desktop ? null : progress}
      </View>
      {desktop ? progress : null}
    </View>
  );
}

function Status(props: { sales: Sales; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { coverage, calibration, uploads } = props.sales;
  const last = uploads.find((upload) => upload.status === 'applied');
  return (
    <Panel label="Calibration">
      <Stack gap={8}>
        <Eyebrow>Calibration</Eyebrow>
        <Heading>Not calibrated yet</Heading>
      </Stack>
      {calibration.state === 'no_sales_data' ? (
        <>
          <Small>Upload your sales history to start. The upload sends Townwise only the date, guest count and net sales for each day.</Small>
          <Actions><UploadAction locationId={props.locationId} variant="primary" readOnlyId={props.readOnlyId} /></Actions>
        </>
      ) : (
        <>
          <Small>
            {`Your sales history is in: ${plural(calibration.dayCount, 'day', 'days')}, ${formatDate(calibration.firstDate)} to ${formatDate(calibration.lastDate)}. Calibration isn’t built yet, so there is no forecast.`}
          </Small>
          <DefinitionList
            mono
            items={[
              { term: 'Days with data', value: formatCount(coverage.dayCount) },
              { term: 'First day', value: coverage.firstDate === null ? 'None' : formatDate(coverage.firstDate) },
              { term: 'Last day', value: coverage.lastDate === null ? 'None' : formatDate(coverage.lastDate) },
              { term: 'Missing days in between', value: formatCount(coverage.missingDays) },
              { term: 'Days with guests', value: formatCount(coverage.guestsDayCount) },
              { term: 'Days with net sales', value: formatCount(coverage.netSalesDayCount) },
              {
                term: 'Last upload',
                value: last === undefined ? 'No finished upload' : `${formatDate(last.uploadedAt)} by ${last.uploadedByEmail}`,
              },
            ]}
          />
        </>
      )}
    </Panel>
  );
}

function WhatItWillShow(): React.JSX.Element {
  return (
    <Section kicker="Forecast" title="What a forecast will show">
      <Columns
        main={(
          <Stack>
            <View style={styles.ill}>
              <Text style={styles.illHead}>Illustrative layout, not real output</Text>
              <View style={styles.illRow}>
                <View style={styles.illPart}><Slot>{'{weekday}'}</Slot><Slot>{'{date}'}</Slot></View>
                <View style={styles.illPart}><Slot>{'{guests}'}</Slot><Text style={styles.illText}>guests</Text></View>
                <View style={styles.illPart}>
                  <Text style={styles.illText}>range</Text><Slot>{'{low}'}</Slot><Text style={styles.illText}>to</Text><Slot>{'{high}'}</Slot>
                </View>
                <View style={styles.illPart}><Slot>{'{sales}'}</Slot><Text style={styles.illText}>sales</Text></View>
                <View style={styles.illPart}><Slot>{'{reason}'}</Slot></View>
              </View>
            </View>
            <Eyebrow>In development. None of this is available to restaurants yet.</Eyebrow>
            <Stack gap={8}>
              <Tagline kind="progress" text="7-day forecast" />
              <Tagline kind="progress" text="28-day forecast" />
              <Tagline kind="planned" text="A reason for every swing" />
            </Stack>
          </Stack>
        )}
      />
    </Section>
  );
}

export function Forecast(): React.JSX.Element {
  const { location } = useLocation();
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const { state, reload } = useLoad(useCallback(() => fetchSales(api, location.id), [api, location.id]));
  if (state.status === 'loading') return <Loading text={`Loading ${location.name}`} minHeight={480} />;
  if (state.status === 'failed') return <LoadFailure error={state.error} onRetry={reload} />;
  const sales = state.data;
  const { coverage } = sales;
  const empty = sales.calibration.state === 'no_sales_data';
  // Native has no upload (D20), so nothing on this page writes there.
  const readOnlyId = readOnly && Platform.OS === 'web' ? READ_ONLY_ID : null;
  const history = coverage.firstDate === null || coverage.lastDate === null || coverage.dayCount === 0
    ? 'Not started'
    : `${plural(coverage.dayCount, 'day', 'days')}, ${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}`;
  return (
    <View>
      {readOnlyId === null ? null : <View style={styles.readOnly}><ReadOnlyLine text={line} nativeID={readOnlyId} /></View>}
      <Columns main={<Status sales={sales} locationId={location.id} readOnlyId={readOnlyId} />} />
      <Section kicker="Checklist" title="Getting started">
        <View role="list" style={styles.steps}>
          <Step
            number="01"
            title="Your town"
            body={`Public data on what moves demand in ${townLabel(location.town)}.`}
            progress={townResearchLine(location.town.townId)}
          >
            <LinkButton href={locationHref(location.id, 'town')} label="See your town" />
          </Step>
          <Step
            number="02"
            title="Upload your sales history"
            body="Export a daily summary from your point-of-sale system."
            progress={history}
            selected={empty}
          >
            <UploadAction locationId={location.id} variant="link" readOnlyId={readOnlyId} />
          </Step>
          <Step
            number="03"
            title="Calibration"
            body="Calibration is designed to tune the town model to your business: daily guests and sales, 7 and 28 days ahead, each day with a range and a reason. This isn’t built into the app yet."
            progress="Not calibrated yet"
          />
          <Step
            number="04"
            title="Tell Townwise what it can’t see"
            body="Closures, private events and openings, saved with this location. Nothing reads them yet."
            progress={plural(location.notesCount, 'note', 'notes')}
          >
            <LinkButton href={locationHref(location.id, 'notes')} label="Add a note" />
            <Tagline kind="planned" text="Talking to your model is planned." />
          </Step>
        </View>
      </Section>
      <WhatItWillShow />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  readOnly: { marginBottom: theme.space[4] },
  tagline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  steps: { borderTopWidth: 1, borderTopColor: c.border },
  step: {
    flexDirection: 'row', alignItems: 'flex-start', columnGap: 20, paddingVertical: 20, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: c.border, borderWidth: 1, borderColor: 'transparent',
  },
  stepPhone: { columnGap: 12, paddingVertical: 16, paddingHorizontal: 8 },
  stepOn: { backgroundColor: c.raised, borderColor: c.border },
  number: { ...theme.type.mono, lineHeight: 28, color: c.text3, fontVariant: ['tabular-nums'] },
  stepBody: { flex: 1, minWidth: 0, gap: theme.space[2], alignItems: 'flex-start' },
  stepTitle: { flexDirection: 'row', alignItems: 'center', columnGap: 8 },
  square: { width: 6, height: 6 },
  squareOn: { backgroundColor: c.mint },
  titleOn: { color: c.mint },
  progress: { ...theme.type.mono, lineHeight: 20, color: c.text2, fontVariant: ['tabular-nums'] },
  progressWide: { width: 260, lineHeight: 28, textAlign: 'right' },
  ill: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border },
  illHead: { ...theme.type.label, color: c.text3, paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  illRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 10, paddingVertical: 16, paddingHorizontal: 12 },
  illPart: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  illText: { ...theme.type.monoUi, color: c.text2 },
});
