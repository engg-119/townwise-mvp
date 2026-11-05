import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { createOrg, fetchOrgs, newOrgId } from '../../../../../../src/portal/console/api';
import { Dialog } from '../../../../../../src/portal/console/Dialog';
import { onlyAt, orgHref } from '../../../../../../src/portal/console/links';
import { CellLink } from '../../../../../../src/portal/console/parts';
import { problemOf } from '../../../../../../src/portal/console/problems';
import type { OrgRow } from '../../../../../../src/portal/console/schemas';
import { hasCode } from '../../../../../../src/portal/errors';
import { formatCount, formatDate } from '../../../../../../src/portal/format';
import { useAction, useBreakpoint, useLoad } from '../../../../../../src/portal/hooks';
import { usePortal } from '../../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../../src/portal/shell/Page';
import {
  Button, DataTable, EmptyState, ErrorNotice, FormField, LinkButton, LoadingLine, Select, Small, Stack,
} from '../../../../../../src/portal/ui';

// P20. Organizations (/admin/orgs, staff): docs/portal/spec.md 16.4, F10; the AdminOrgs board. Every
// organization with its counts (D7: no figures), filtered in the browser by name and status. New organization
// (C5) creates one with an org admin invitation for its first admin, then opens its page.

const NAME_COPY = 'Enter the organization’s name, 2 to 120 characters.';
const CONFLICT_COPY = 'Another change got there first. Check the organizations list, then try again.';
const EMAIL_COPY = 'Enter an email address.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** C5. The organization's admins see that staff created it, in their Townwise staff activity (D9). */
function NewOrgDialog(props: { onClose: () => void }): React.JSX.Element {
  const { api, showNotice } = usePortal();
  const router = useRouter();
  // One id per opened dialog: a double submit or a retry sends the same one, so the server makes one organization.
  const [orgId] = useState(newOrgId);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [messages, setMessages] = useState<{ name: string | null; email: string | null }>({ name: null, email: null });
  const create = useAction(useCallback(async (input: { name: string; adminEmail: string }) => {
    const { org, result } = await createOrg(api, { id: orgId, ...input });
    const href = orgHref(org.id);
    showNotice({ text: `Created ${org.name}. ${result.email} joins as its admin the next time they continue with Google.` }, onlyAt(href));
    router.push(href);
  }, [api, orgId, showNotice, router]));

  function submit(): void {
    const input = { name: name.trim(), adminEmail: email.trim() };
    const next = {
      name: input.name.length < 2 || input.name.length > 120 ? NAME_COPY : null,
      email: EMAIL.test(input.adminEmail) ? null : EMAIL_COPY,
    };
    setMessages(next);
    if (next.name === null && next.email === null) create.run(input);
  }

  const who = name.trim() === '' ? 'The organization' : name.trim();
  return (
    <Dialog
      title="New organization"
      confirmLabel="Create organization"
      pendingLabel="Creating…"
      pending={create.pending}
      problem={problemOf(create.error, (error) => (hasCode(error, 409, 'conflict') ? CONFLICT_COPY : null))}
      onConfirm={submit}
      onCancel={props.onClose}
    >
      <FormField label="Name" value={name} onChangeText={setName} autoCapitalize="words" maxLength={120} messages={messages.name === null ? [] : [messages.name]} />
      <FormField
        label="First admin email"
        value={email}
        onChangeText={setEmail}
        onSubmitEditing={submit}
        keyboardType="email-address"
        autoComplete="off"
        autoCorrect={false}
        maxLength={320}
        messages={messages.email === null ? [] : [messages.email]}
      />
      <Small>{`They join as admin the next time they continue with Google with this address. We don’t send email yet. ${who}’s admins will see that Townwise staff created it.`}</Small>
    </Dialog>
  );
}

function OrgTable(props: { orgs: readonly OrgRow[] }): React.JSX.Element {
  return (
    <DataTable
      label="Organizations"
      columns={[
        { key: 'name', label: 'Name', flex: 1.6 },
        { key: 'status', label: 'Status' },
        { key: 'admins', label: 'Admins', numeric: true },
        { key: 'members', label: 'Members', numeric: true },
        { key: 'invited', label: 'Invited', numeric: true },
        { key: 'locations', label: 'Locations', numeric: true },
        { key: 'days', label: 'Days of sales', numeric: true },
        { key: 'upload', label: 'Last upload' },
        { key: 'created', label: 'Created' },
      ]}
      rows={props.orgs.map((org) => ({
        key: org.id,
        cells: {
          name: <CellLink label={org.name} href={orgHref(org.id)} />,
          status: org.status === 'active' ? 'Active' : 'Suspended',
          admins: org.adminCount === 0 ? 'No admin yet' : formatCount(org.adminCount),
          members: formatCount(org.memberCount),
          invited: formatCount(org.inviteCount),
          locations: formatCount(org.locationCount),
          days: formatCount(org.salesDayCount),
          upload: org.lastUploadAt === null ? 'None yet' : formatDate(org.lastUploadAt),
          created: formatDate(org.createdAt),
        },
      }))}
    />
  );
}

export default function OrganizationsPage(): React.JSX.Element {
  const { api } = usePortal();
  const { phone } = useBreakpoint();
  const { state, reload } = useLoad(useCallback(() => fetchOrgs(api), [api]));
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = <LoadingLine text="Loading organizations" minHeight={320} />;
  } else if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={reload} />;
  } else if (state.data.length === 0) {
    body = (
      <EmptyState text="No organizations yet. Approve a request or create one.">
        <LinkButton href="/admin" label="Open requests" />
      </EmptyState>
    );
  } else {
    const needle = query.trim().toLowerCase();
    const shown = state.data.filter((org) => (status === '' || org.status === status) && org.name.toLowerCase().includes(needle));
    body = (
      <Stack gap={20}>
        <View style={phone ? styles.filtersStacked : styles.filters}>
          <View style={styles.filter}>
            <FormField label="Filter by name" value={query} onChangeText={setQuery} autoCorrect={false} />
          </View>
          <View style={styles.filter}>
            <Select
              label="Status"
              value={status}
              onChange={setStatus}
              items={[{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }]}
            />
          </View>
        </View>
        {shown.length === 0 ? <EmptyState text="No organizations match these filters." /> : <OrgTable orgs={shown} />}
      </Stack>
    );
  }

  return (
    <Page title="Organizations" side={<Button label="New organization" onPress={() => { setCreating(true); }} />}>
      {body}
      {creating ? <NewOrgDialog onClose={() => { setCreating(false); }} /> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', columnGap: 20, alignItems: 'flex-start' },
  filtersStacked: { gap: 20 },
  filter: { flex: 1, minWidth: 0, maxWidth: 360 },
});
