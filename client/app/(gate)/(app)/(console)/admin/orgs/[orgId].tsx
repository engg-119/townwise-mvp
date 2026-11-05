import { useCallback, useState } from 'react';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { Text, StyleSheet } from 'react-native';

import { deleteOrg, fetchOrg, updateOrg } from '../../../../../../src/portal/console/api';
import { AuditTable } from '../../../../../../src/portal/console/AuditTable';
import { Dialog } from '../../../../../../src/portal/console/Dialog';
import { auditHref, onlyAt, requestHref } from '../../../../../../src/portal/console/links';
import { OrgTeam } from '../../../../../../src/portal/console/OrgTeam';
import { CellLink, Facts } from '../../../../../../src/portal/console/parts';
import { problemOf } from '../../../../../../src/portal/console/problems';
import type { OrgDetail, OrgLocation, StaffOrg } from '../../../../../../src/portal/console/schemas';
import { useRefreshable } from '../../../../../../src/portal/console/useRefreshable';
import { ViewAsDialog, type ViewAsTarget } from '../../../../../../src/portal/console/ViewAsDialog';
import { hasCode } from '../../../../../../src/portal/errors';
import { formatCount, formatDate, plural, townLabel } from '../../../../../../src/portal/format';
import { useAction } from '../../../../../../src/portal/hooks';
import { usePortal } from '../../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../../src/portal/shell/Page';
import {
  Button, DataTable, EmptyState, ErrorNotice, FormField, LinkButton, LoadingLine, Section, Small, Stack,
} from '../../../../../../src/portal/ui';
import { theme } from '../../../../../../src/theme';

// P21. Organization detail (/admin/orgs/[orgId], staff): docs/portal/spec.md 16.4, F5, F6, F8, F13; the
// AdminOrgs board. The header line (status, created, the request it came from), Rename and Suspend or Reactivate,
// the team with View as on each active member, the locations as metadata only (D7: day counts and dates, never a
// figure or a note), the newest 20 audit events, and deletion last: only once suspended, with the typed name.
// Every change here is a staff action its admins see (D9); after one the page reads the organization again in
// place.

const NAME_COPY = 'Enter the organization’s name, 2 to 120 characters.';

type Open = 'rename' | 'suspend' | 'delete' | null;

function missing(error: unknown): boolean {
  // A malformed id is 400 before the lookup; either way there is no such organization.
  return hasCode(error, 404, 'not_found') || hasCode(error, 400, 'invalid_request');
}

function RenameDialog(props: { org: StaffOrg; onSaved: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { org, onSaved } = props;
  const { api } = usePortal();
  const [name, setName] = useState(org.name);
  const [invalid, setInvalid] = useState(false);
  const save = useAction(useCallback(async (next: string) => {
    await updateOrg(api, org.id, { name: next });
    await onSaved();
  }, [api, org.id, onSaved]));
  function submit(): void {
    const next = name.trim();
    const bad = next.length < 2 || next.length > 120;
    setInvalid(bad);
    if (!bad) save.run(next);
  }
  return (
    <Dialog
      title={`Rename ${org.name}`}
      body="Its admins see the new name, and the change, in their Townwise staff activity."
      confirmLabel="Save name"
      pendingLabel="Saving…"
      pending={save.pending}
      problem={problemOf(save.error)}
      onConfirm={submit}
      onCancel={props.onClose}
    >
      <FormField
        label="Organization name"
        value={name}
        onChangeText={setName}
        onSubmitEditing={submit}
        autoCapitalize="words"
        maxLength={120}
        messages={invalid ? [NAME_COPY] : []}
      />
    </Dialog>
  );
}

function SuspendDialog(props: { org: StaffOrg; onSaved: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { org, onSaved } = props;
  const { api } = usePortal();
  const suspend = useAction(useCallback(async () => {
    await updateOrg(api, org.id, { status: 'suspended' });
    await onSaved();
  }, [api, org.id, onSaved]));
  return (
    <Dialog
      title={`Suspend ${org.name}?`}
      body={`Members of ${org.name} lose access until you reactivate it. Data is kept.`}
      confirmLabel="Suspend"
      pendingLabel="Suspending…"
      pending={suspend.pending}
      problem={problemOf(suspend.error)}
      onConfirm={suspend.run}
      onCancel={props.onClose}
    />
  );
}

/** C7 for an organization: only a suspended one, with its name typed. The notice uses that name. */
function DeleteDialog(props: { detail: OrgDetail; onStale: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { org, locations } = props.detail;
  const { onStale } = props;
  const { api, showNotice } = usePortal();
  const router = useRouter();
  const remove = useAction(useCallback(async () => {
    try {
      await deleteOrg(api, org.id);
    } catch (error) {
      if (hasCode(error, 409, 'org_not_suspended')) await onStale().catch(() => undefined);
      throw error;
    }
    showNotice({ text: `Deleted ${org.name}.` }, onlyAt('/admin/orgs'));
    router.replace('/admin/orgs');
  }, [api, org.id, org.name, onStale, showNotice, router]));
  const request = org.fromRequestId === null ? '' : ' and its request';
  return (
    <Dialog
      title={`Delete ${org.name}`}
      body={`This deletes ${org.name}: its ${plural(locations.length, 'location', 'locations')}, their sales data and notes, its team${request}. The audit log keeps the events, with the organization’s and locations’ names removed. This can’t be undone.`}
      typedName={org.name}
      confirmLabel="Delete organization"
      pendingLabel="Deleting…"
      pending={remove.pending}
      problem={problemOf(remove.error, (error) => (hasCode(error, 409, 'org_not_suspended') ? `Suspend ${org.name} before deleting it.` : null))}
      onConfirm={remove.run}
      onCancel={props.onClose}
    />
  );
}

function LocationTable(props: { locations: readonly OrgLocation[] }): React.JSX.Element {
  return (
    <DataTable
      label="Locations"
      columns={[
        { key: 'name', label: 'Name', flex: 1.4 },
        { key: 'town', label: 'Town', flex: 1.2 },
        { key: 'days', label: 'Days', numeric: true, flex: 0.7 },
        { key: 'first', label: 'First day' },
        { key: 'last', label: 'Last day' },
        { key: 'notes', label: 'Notes', numeric: true, flex: 0.7 },
        { key: 'upload', label: 'Last upload' },
      ]}
      rows={props.locations.map((location) => ({
        key: location.id,
        cells: {
          name: location.name,
          town: townLabel(location.town),
          days: formatCount(location.coverage.dayCount),
          first: location.coverage.firstDate === null ? 'None' : formatDate(location.coverage.firstDate),
          last: location.coverage.lastDate === null ? 'None' : formatDate(location.coverage.lastDate),
          notes: formatCount(location.notesCount),
          upload: location.lastUploadAt === null ? 'None yet' : formatDate(location.lastUploadAt),
        },
      }))}
    />
  );
}

export default function OrganizationPage(): React.JSX.Element {
  const { api, showNotice } = usePortal();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ orgId: string }>();
  const orgId = typeof params.orgId === 'string' ? params.orgId : '';
  const { state, reload, refresh } = useRefreshable(useCallback(() => fetchOrg(api, orgId), [api, orgId]));
  const [open, setOpen] = useState<Open>(null);
  const [viewing, setViewing] = useState<ViewAsTarget | null>(null);

  const saved = useCallback(() => { showNotice({ text: 'Saved.' }, onlyAt(pathname)); }, [showNotice, pathname]);
  const savedAndClosed = useCallback(async () => {
    await refresh();
    setOpen(null);
    saved();
  }, [refresh, saved]);
  const reactivate = useAction(useCallback(async () => {
    await updateOrg(api, orgId, { status: 'active' });
    await refresh();
    saved();
  }, [api, orgId, refresh, saved]));

  if (state.status === 'loading') {
    return <Page eyebrow="Organization" title="Organization"><LoadingLine text="Loading the organization" minHeight={480} /></Page>;
  }
  if (state.status === 'failed') {
    return (
      <Page eyebrow="Organization" title="Organization">
        {missing(state.error) ? (
          <Stack>
            <ErrorNotice message="This organization doesn’t exist." />
            <LinkButton href="/admin/orgs" label="Back to organizations" />
          </Stack>
        ) : <ErrorNotice error={state.error} onRetry={reload} />}
      </Page>
    );
  }

  const detail = state.data;
  const { org, members, locations, recent } = detail;
  const suspended = org.status === 'suspended';
  const noAdmin = !members.some((member) => member.status === 'active' && member.role === 'org_admin');
  const side = (
    <>
      <Button variant="outline" label="Rename" onPress={() => { setOpen('rename'); }} />
      {suspended
        ? <Button variant="outline" label={reactivate.pending ? 'Reactivating…' : 'Reactivate'} disabled={reactivate.pending} onPress={reactivate.run} />
        : <Button variant="outline" label="Suspend" onPress={() => { setOpen('suspend'); }} />}
    </>
  );

  return (
    <Page eyebrow="Organization" title={org.name} side={side}>
      <Stack gap={12}>
        <Facts>
          <Text style={styles.fact}>{suspended ? 'Suspended' : 'Active'}</Text>
          <Text style={styles.fact}>{`Created ${formatDate(org.createdAt)}${org.fromRequestId === null ? ' by Townwise staff' : ''}`}</Text>
          {org.fromRequestId === null ? null : <CellLink label="From request" href={requestHref('approved', org.fromRequestId)} />}
        </Facts>
        <Small>{`What you change here is listed in ${org.name}’s Townwise staff activity, which its admins see.`}</Small>
        {suspended ? <Small>{`Members of ${org.name} see that access is paused. Data is kept.`}</Small> : null}
        {noAdmin ? <Small white>No admin yet. Add an admin email.</Small> : null}
        {reactivate.error === null ? null : <ErrorNotice error={reactivate.error} />}
      </Stack>

      <Section title="Team">
        <OrgTeam org={org} members={members} onChanged={refresh} onSaved={saved} onViewAs={setViewing} />
      </Section>

      <Section kicker="Locations, metadata only" title="Locations">
        {locations.length === 0
          ? <EmptyState text="No locations yet. The first admin adds one after joining." />
          : <LocationTable locations={locations} />}
        <Small>Sales figures and notes are visible only through View as.</Small>
      </Section>

      <Section kicker="Newest 20 events" title="Recent activity">
        {recent.length === 0 ? <EmptyState text="Nothing recorded yet." /> : <AuditTable label="Recent activity" events={recent} />}
        <LinkButton href={auditHref(org.id)} label={`See ${org.name} in the audit log`} />
      </Section>

      <Section kicker="Last step" title="Delete organization">
        {suspended
          ? <Button variant="outline" label="Delete organization" onPress={() => { setOpen('delete'); }} />
          : <Small>{`Suspend ${org.name} before deleting it.`}</Small>}
      </Section>

      {open === 'rename' ? <RenameDialog org={org} onSaved={savedAndClosed} onClose={() => { setOpen(null); }} /> : null}
      {open === 'suspend' ? <SuspendDialog org={org} onSaved={savedAndClosed} onClose={() => { setOpen(null); }} /> : null}
      {open === 'delete' ? <DeleteDialog detail={detail} onStale={refresh} onClose={() => { setOpen(null); }} /> : null}
      {viewing === null ? null : <ViewAsDialog target={viewing} onClose={() => { setViewing(null); }} />}
    </Page>
  );
}

const styles = StyleSheet.create({
  fact: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: theme.color.text2 },
});
