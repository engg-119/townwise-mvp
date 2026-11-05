import { useCallback, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { approveRequest, fetchRequests, rejectRequest } from '../../../../../src/portal/console/api';
import { Dialog } from '../../../../../src/portal/console/Dialog';
import { orgHref, requestHref } from '../../../../../src/portal/console/links';
import { CellLink, FilterTabs, RowName, Split } from '../../../../../src/portal/console/parts';
import { problemOf } from '../../../../../src/portal/console/problems';
import { REQUEST_STATUSES, type AdminRequest, type RequestStatus } from '../../../../../src/portal/console/schemas';
import { ViewAsDialog, type ViewAsTarget } from '../../../../../src/portal/console/ViewAsDialog';
import { hasCode } from '../../../../../src/portal/errors';
import { formatCount, formatDate, townLabel } from '../../../../../src/portal/format';
import { useAction, useLoad } from '../../../../../src/portal/hooks';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import {
  Actions, Button, DataTable, DefinitionList, EmptyState, ErrorNotice, Eyebrow, FormField, Heading, LinkButton,
  LoadingLine, Messages, Panel, Small, Stack, type Column,
} from '../../../../../src/portal/ui';

// P19. Requests (/admin, staff): docs/portal/spec.md 16.4, F3, F4; the AdminOverview board. Tabs filter by
// status (?status=), the pending queue oldest first and the others newest first, as the server sorts them. A row
// opens its detail (?request=): every field, the note as plain text, “Requested as” when the email changed and
// the warning when the requester already has an organization. Approve (C3) creates the organization, its first
// location and the requester's admin seat; Reject (C4) sends an optional message; View as (C1) shows what the
// requester sees.

const EMPTY: Readonly<Record<RequestStatus, string>> = {
  pending: 'No requests are waiting.',
  approved: 'No approved requests.',
  rejected: 'No rejected requests.',
  withdrawn: 'No withdrawn requests.',
};

const TAB_LABEL: Readonly<Record<RequestStatus, string>> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn',
};

const ALREADY_DECIDED = 'Someone already decided this request.';
const HAS_ORG = 'This person already belongs to an organization.';
const ORG_NAME_COPY = 'Enter the organization’s name, 2 to 120 characters.';
const LOCATION_NAME_COPY = 'Enter the first location’s name, up to 80 characters.';

function statusOf(value: string | string[] | undefined): RequestStatus {
  return REQUEST_STATUSES.find((status) => status === value) ?? 'pending';
}

function listHref(status: RequestStatus): string {
  return status === 'pending' ? '/admin' : `/admin?status=${status}`;
}

type Open = { kind: 'approve' | 'reject'; request: AdminRequest } | { kind: 'view'; target: ViewAsTarget } | null;

function messageOf(text: string | null): readonly string[] {
  return text === null ? [] : [text];
}

/** C3. The town is the request's; the server takes it from there. */
function ApproveDialog(props: { request: AdminRequest; onApproved: () => void; onStale: () => void; onClose: () => void }): React.JSX.Element {
  const { request, onApproved, onStale } = props;
  const { api, showNotice } = usePortal();
  const [orgName, setOrgName] = useState(request.orgName);
  const [locationName, setLocationName] = useState(request.orgName);
  const [messages, setMessages] = useState<{ orgName: string | null; locationName: string | null }>({ orgName: null, locationName: null });
  const email = request.requester.email;
  const approve = useAction(useCallback(async (input: { orgName: string; locationName: string }) => {
    try {
      const { org } = await approveRequest(api, request.id, input);
      showNotice(
        { text: `Approved. ${org.name} is set up, and ${email} is its admin.`, link: { label: `Open ${org.name}`, href: orgHref(org.id) } },
        /^\/admin$/,
      );
      onApproved();
    } catch (error) {
      if (hasCode(error, 409, 'request_not_pending')) {
        onStale();
        return;
      }
      throw error;
    }
  }, [api, showNotice, request.id, email, onApproved, onStale]));

  function submit(): void {
    const input = { orgName: orgName.trim(), locationName: locationName.trim() };
    const next = {
      orgName: input.orgName.length < 2 || input.orgName.length > 120 ? ORG_NAME_COPY : null,
      locationName: input.locationName.length < 1 || input.locationName.length > 80 ? LOCATION_NAME_COPY : null,
    };
    setMessages(next);
    if (next.orgName === null && next.locationName === null) approve.run(input);
  }

  const town = townLabel(request.town);
  return (
    <Dialog
      title={`Approve ${request.orgName}`}
      confirmLabel="Approve"
      pendingLabel="Approving…"
      pending={approve.pending}
      problem={problemOf(approve.error, (error) => (hasCode(error, 409, 'requester_has_org') ? HAS_ORG : null))}
      onConfirm={submit}
      onCancel={props.onClose}
    >
      <FormField label="Organization name" value={orgName} onChangeText={setOrgName} autoCapitalize="words" maxLength={120} messages={messageOf(messages.orgName)} />
      <FormField
        label="First location name"
        value={locationName}
        onChangeText={setLocationName}
        onSubmitEditing={submit}
        autoCapitalize="words"
        maxLength={80}
        messages={messageOf(messages.locationName)}
      />
      <DefinitionList items={[{ term: 'Town', value: town }]} />
      <Small>
        {`This creates the organization and its first location in ${town}, and makes ${email} its admin. They get access the next time they open Townwise. We don’t send email yet.`}
      </Small>
    </Dialog>
  );
}

/** C4. The message is shown to the requester; the audit log records only that there was one. */
function RejectDialog(props: { request: AdminRequest; onRejected: () => void; onStale: () => void; onClose: () => void }): React.JSX.Element {
  const { request, onRejected, onStale } = props;
  const { api, showNotice } = usePortal();
  const [message, setMessage] = useState('');
  const reject = useAction(useCallback(async (text: string) => {
    try {
      await rejectRequest(api, request.id, text);
      showNotice({ text: `Rejected the request for ${request.orgName}.`, link: { label: 'See rejected requests', href: '/admin?status=rejected' } }, /^\/admin$/);
      onRejected();
    } catch (error) {
      if (hasCode(error, 409, 'request_not_pending')) {
        onStale();
        return;
      }
      throw error;
    }
  }, [api, showNotice, request.id, request.orgName, onRejected, onStale]));

  return (
    <Dialog
      title={`Reject ${request.orgName}?`}
      confirmLabel="Reject"
      pendingLabel="Rejecting…"
      pending={reject.pending}
      problem={problemOf(reject.error)}
      onConfirm={() => { reject.run(message.trim()); }}
      onCancel={props.onClose}
    >
      <FormField
        label={`Message to ${request.contactName} (optional)`}
        helper="Shown on their No access page. Up to 500 characters."
        value={message}
        onChangeText={setMessage}
        multiline
        autoCapitalize="sentences"
        maxLength={500}
      />
    </Dialog>
  );
}

function RequestDetail(props: { request: AdminRequest; onOpen: (open: Open) => void }): React.JSX.Element {
  const { request, onOpen } = props;
  const pending = request.status === 'pending';
  const decided = request.status === 'approved' || request.status === 'rejected';
  const email = request.requester.email;
  const items: { term: string; value: React.ReactNode }[] = [
    { term: 'Contact', value: `${request.contactName}, ${request.contactRole}` },
    {
      term: 'Email',
      value: request.emailAtRequest === email ? email : (
        <View><Small white>{email}</Small><Small>{`Requested as ${request.emailAtRequest}`}</Small></View>
      ),
    },
    { term: 'Town', value: townLabel(request.town) },
    { term: 'Locations', value: formatCount(request.locationCount) },
    { term: 'Sent', value: formatDate(request.createdAt) },
  ];
  if (decided && request.decidedAt !== null) items.push({ term: 'Decided', value: formatDate(request.decidedAt) });
  if (decided && request.decidedBy !== null) items.push({ term: 'By', value: request.decidedBy.email });
  if (request.status === 'rejected' && request.decisionMessage !== null) items.push({ term: 'Message', value: request.decisionMessage });
  items.push({ term: 'Note', value: request.note ?? 'None' });
  if (request.status === 'approved' && request.orgId !== null) {
    items.push({ term: 'Organization', value: <CellLink label="Open the organization" href={orgHref(request.orgId)} /> });
  }
  const target: ViewAsTarget = { email, userId: request.requester.userId, orgName: request.requesterHasOrg ? 'their organization' : null };
  return (
    <Panel label={`Request: ${request.orgName}`}>
      <View style={styles.head}>
        <Eyebrow>Request</Eyebrow>
        <Heading>{request.orgName}</Heading>
      </View>
      {pending && request.requesterHasOrg ? <Messages items={[HAS_ORG]} /> : null}
      <DefinitionList items={items} />
      {pending ? <Small>Validate the requester outside Townwise before you approve, for example with a phone call to the restaurant.</Small> : null}
      <Actions>
        {pending ? <Button label="Approve" onPress={() => { onOpen({ kind: 'approve', request }); }} /> : null}
        {pending ? <Button variant="outline" label="Reject" onPress={() => { onOpen({ kind: 'reject', request }); }} /> : null}
        <Button variant="link" label="View as" accessibilityLabel={`View as ${email}`} onPress={() => { onOpen({ kind: 'view', target }); }} />
      </Actions>
    </Panel>
  );
}

function RequestTable(props: { status: RequestStatus; requests: readonly AdminRequest[]; selected: AdminRequest }): React.JSX.Element {
  const { status } = props;
  const decided = status === 'approved' || status === 'rejected';
  const columns: Column[] = [
    { key: 'org', label: 'Organization', flex: 1.4 },
    { key: 'contact', label: 'Contact', flex: 1.2 },
    { key: 'email', label: 'Email', flex: 1.4 },
    { key: 'town', label: 'Town' },
    { key: 'locations', label: 'Locations', numeric: true, flex: 0.8 },
    ...(decided ? [{ key: 'decided', label: 'Decided' }, { key: 'by', label: 'By', flex: 1.2 }] : [{ key: 'sent', label: 'Sent' }]),
  ];
  return (
    <DataTable
      label={`${TAB_LABEL[status]} requests`}
      columns={columns}
      rows={props.requests.map((request) => {
        const selected = request.id === props.selected.id;
        return {
          key: request.id,
          selected,
          cells: {
            org: <RowName label={request.orgName} href={requestHref(status, request.id)} selected={selected} />,
            contact: `${request.contactName}, ${request.contactRole}`,
            email: request.requester.email,
            town: townLabel(request.town),
            locations: formatCount(request.locationCount),
            sent: formatDate(request.createdAt),
            decided: request.decidedAt === null ? '' : formatDate(request.decidedAt),
            by: request.decidedBy?.email ?? '',
          },
        };
      })}
    />
  );
}

export default function RequestsPage(): React.JSX.Element {
  const { api } = usePortal();
  const params = useLocalSearchParams<{ status?: string; request?: string }>();
  const status = statusOf(params.status);
  const { state, reload } = useLoad(useCallback(() => fetchRequests(api, status), [api, status]));
  const [open, setOpen] = useState<Open>(null);
  const [stale, setStale] = useState(false);
  const close = useCallback(() => { setOpen(null); }, []);
  const done = useCallback(() => { setOpen(null); setStale(false); reload(); }, [reload]);
  const onStale = useCallback(() => { setOpen(null); setStale(true); reload(); }, [reload]);

  const pendingCount = state.status === 'ready' ? state.data.pendingCount : null;
  const tabs = REQUEST_STATUSES.map((value) => ({
    label: value === 'pending' && pendingCount !== null ? `Pending ${formatCount(pendingCount)}` : TAB_LABEL[value],
    href: listHref(value),
    current: value === status,
  }));

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = <LoadingLine text="Loading requests" minHeight={320} />;
  } else if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={reload} />;
  } else {
    const { requests } = state.data;
    const selected = requests.find((request) => request.id === params.request) ?? requests[0];
    body = selected === undefined ? (
      <EmptyState text={EMPTY[status]}>
        {status === 'pending' ? <LinkButton href={listHref('approved')} label="See approved requests" /> : null}
      </EmptyState>
    ) : (
      <Split
        table={<RequestTable status={status} requests={requests} selected={selected} />}
        detail={<RequestDetail request={selected} onOpen={setOpen} />}
      />
    );
  }

  return (
    <Page title="Requests">
      <Stack gap={24}>
        <FilterTabs label="Requests by status" tabs={tabs} />
        {stale ? <ErrorNotice message={ALREADY_DECIDED} /> : null}
        {body}
      </Stack>
      {open?.kind === 'approve' ? <ApproveDialog request={open.request} onApproved={done} onStale={onStale} onClose={close} /> : null}
      {open?.kind === 'reject' ? <RejectDialog request={open.request} onRejected={done} onStale={onStale} onClose={close} /> : null}
      {open?.kind === 'view' ? <ViewAsDialog target={open.target} onClose={close} /> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { gap: 8 },
});
