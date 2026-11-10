import { Link, Redirect, type Href } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { AddLocationForm } from '../../../../src/portal/AddLocationForm';
import { formatCount, formatDate, plural, townLabel } from '../../../../src/portal/format';
import { useBreakpoint } from '../../../../src/portal/hooks';
import { useOrg, usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { locationHref } from '../../../../src/portal/routing';
import type { LocationSummary } from '../../../../src/portal/schemas';
import { Page } from '../../../../src/portal/shell/Page';
import { PatternLine } from '../../../../src/portal/town/TownProfile';
import { CAVEATS, DATA_YEAR, KIND_LABEL, townProfile, townResearchLine, type TownProfileData } from '../../../../src/portal/towns';
import { Button, LinkButton } from '../../../../src/portal/ui/Button';
import { DataTable } from '../../../../src/portal/ui/DataTable';
import { EmptyState, ErrorNotice, LoadingLine, ReadOnlyLine, StatusTag } from '../../../../src/portal/ui/feedback';
import { Columns, Panel, Section, Stack } from '../../../../src/portal/ui/layout';
import { Heading, Small } from '../../../../src/portal/ui/text';
import { theme } from '../../../../src/theme';

// P9. Locations (spec 16.3; the Dashboard board). One location: its Home, keeping any one-time notice.
// Several: one row per location with its town, sales history, calibration in words, notes and the next step,
// then the public profile of each of their towns. None: org admins get the Add location form inline; members
// get a line saying their admin hasn't added one. After a join, the notice names who added them (F1). When a press
// of the inline form adds some places and leaves rows (P10), the form stays, through the organization's reload,
// until a press adds the rest or one is added by hand.

const READ_ONLY_ID = 'locations-ro';

function NextStep(props: { location: LocationSummary; readOnly: boolean }): React.JSX.Element {
  const { location, readOnly } = props;
  const ro = readOnly ? { disabled: true, describedBy: READ_ONLY_ID } : {};
  if (location.coverage.dayCount === 0) {
    // Upload is web only (D20).
    if (Platform.OS !== 'web') return <Text style={styles.cell}>Upload from a computer at townwise.tech</Text>;
    return <LinkButton href={locationHref(location.id, 'sales') + '/upload'} label="Upload sales history" {...ro} />;
  }
  if (location.notesCount === 0) return <LinkButton href={locationHref(location.id, 'notes')} label="Add a note" {...ro} />;
  return (
    <View>
      <Text style={styles.cell}>None for now</Text>
    </View>
  );
}

function SalesHistory(props: { location: LocationSummary }): React.JSX.Element {
  const { coverage } = props.location;
  if (coverage.dayCount === 0 || coverage.firstDate === null || coverage.lastDate === null) {
    return <Text style={styles.cell}>No sales history yet</Text>;
  }
  return (
    <View>
      <Text style={styles.cell}>{plural(coverage.dayCount, 'day', 'days')}</Text>
      <Text style={styles.note}>{`${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}`}</Text>
    </View>
  );
}

function YourTowns(props: { locations: readonly LocationSummary[] }): React.JSX.Element | null {
  const { desktop } = useBreakpoint();
  const seen = new Map<string, { profile: TownProfileData; locationId: string }>();
  for (const location of props.locations) {
    const profile = townProfile(location.town.townId);
    if (profile !== null && !seen.has(profile.id)) seen.set(profile.id, { profile, locationId: location.id });
  }
  if (seen.size === 0) return null;
  return (
    <Section kicker={`Historical public data, ${String(DATA_YEAR)}`} title="Your towns">
      <View style={[styles.towns, desktop ? styles.townsRow : null]}>
        {[...seen.values()].map(({ profile, locationId }) => (
          <Panel key={profile.id} style={desktop ? styles.town : null}>
            <View style={styles.townTitle}>
              <Heading level={3}>{profile.label}</Heading>
              <StatusTag label={KIND_LABEL[profile.kind]} />
            </View>
            <Small>{profile.note}</Small>
            <Small>{`Measured across ${profile.county}, ${String(DATA_YEAR)}.`}</Small>
            <PatternLine profile={profile} />
            <Text style={styles.research}>{townResearchLine(profile.id)}</Text>
            <LinkButton href={locationHref(locationId, 'town')} label={`${profile.name}’s town profile`} />
          </Panel>
        ))}
      </View>
      <Stack gap={4}>{CAVEATS.map((caveat) => <Text key={caveat} style={styles.caveat}>{caveat}</Text>)}</Stack>
    </Section>
  );
}

export default function LocationsPage(): React.JSX.Element {
  const { me } = usePortal();
  const { state, reload } = useOrg();
  const { readOnly, line } = useReadOnly();
  const access = me.access.state === 'member' ? me.access : null;
  const orgName = access?.org.name ?? '';
  const admin = access?.role === 'org_admin';
  const [rowsLeft, setRowsLeft] = useState(false);

  const first = (
    <Page
      eyebrow={orgName}
      title="Add your first location"
      lead="Pick its town. For the twelve towns Townwise profiles, you’ll see public data on what moves demand there."
      gate
    >
      <Columns main={<AddLocationForm onRowsLeft={setRowsLeft} />} />
    </Page>
  );
  if (rowsLeft) return first;

  if (state.status === 'loading') {
    // Not the notice yet: with one location this page opens its Home, which shows it.
    return <Page eyebrow={orgName} title="Locations" notice={false}><LoadingLine text="Loading your locations" minHeight={400} /></Page>;
  }
  if (state.status === 'failed') {
    return <Page eyebrow={orgName} title="Locations"><ErrorNotice error={state.error} onRetry={reload} /></Page>;
  }
  const { locations, requestedLocationCount } = state.data;
  const only = locations.length === 1 ? locations[0] : undefined;
  if (only !== undefined) return <Redirect href={locationHref(only.id)} />;

  if (locations.length === 0) {
    if (!admin) {
      return <Page eyebrow={orgName} title="Locations"><EmptyState text="Your admin hasn’t added a location yet." /></Page>;
    }
    return first;
  }

  const add = admin ? (
    readOnly
      ? <Button variant="outline" label="Add location" disabled describedBy={READ_ONLY_ID} />
      : <LinkButton variant="outline" href="/locations/new" label="Add location" />
  ) : undefined;
  const mentioned = admin && requestedLocationCount !== null && requestedLocationCount > locations.length;

  return (
    <Page eyebrow={orgName} title="Locations" {...(add === undefined ? {} : { side: add })}>
      <Section first kicker="Overview" title="Where each location stands">
        <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} />
        <DataTable
          label="Locations"
          columns={[
            { key: 'location', label: 'Location', flex: 1.2 },
            { key: 'town', label: 'Town' },
            { key: 'sales', label: 'Sales history', flex: 1.2 },
            { key: 'calibration', label: 'Calibration' },
            { key: 'notes', label: 'Notes', flex: 0.8 },
            { key: 'next', label: 'Next step', flex: 1.2 },
          ]}
          rows={locations.map((location) => ({
            key: location.id,
            cells: {
              location: <Link href={locationHref(location.id) as Href} style={styles.name}>{location.name}</Link>,
              town: townLabel(location.town),
              sales: <SalesHistory location={location} />,
              calibration: 'Not calibrated yet',
              notes: location.notesCount === 0 ? 'No notes yet' : plural(location.notesCount, 'note', 'notes'),
              next: <NextStep location={location} readOnly={readOnly} />,
            },
          }))}
        />
        {mentioned ? (
          <Small>{`Your request mentioned ${formatCount(requestedLocationCount)} locations. Add the others when you’re ready.`}</Small>
        ) : null}
      </Section>
      <YourTowns locations={locations} />
    </Page>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  // A 44px tap target from padding, not line height, so a long name wraps at the type's own line height.
  name: {
    ...theme.type.mono, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line,
    minHeight: 44, paddingVertical: (44 - theme.type.mono.lineHeight) / 2,
  },
  cell: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  note: { ...theme.type.small, color: c.text2 },
  towns: { gap: theme.space[5] },
  townsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  town: { flexGrow: 1, flexBasis: 320 },
  townTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  research: { ...theme.type.mono, color: c.text2 },
  caveat: { ...theme.type.mono, color: c.text3 },
});
