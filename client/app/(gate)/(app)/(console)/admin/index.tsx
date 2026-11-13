import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { approveRequest, fetchRequests, rejectRequest, type ApproveInput } from '../../../../../src/portal/console/api';
import { Dialog } from '../../../../../src/portal/console/Dialog';
import { orgHref, requestHref } from '../../../../../src/portal/console/links';
import { CellLink, FilterTabs, RowName, Split } from '../../../../../src/portal/console/parts';
import { problemOf } from '../../../../../src/portal/console/problems';
import { REQUEST_STATUSES, type AdminRequest, type RequestStatus } from '../../../../../src/portal/console/schemas';
import { ViewAsDialog, type ViewAsTarget } from '../../../../../src/portal/console/ViewAsDialog';
import { hasCode } from '../../../../../src/portal/errors';
import { formatCount, formatDate, townLabel } from '../../../../../src/portal/format';
import { useAction, useLoad } from '../../../../../src/portal/hooks';
import { defaultLocationName } from '../../../../../src/portal/locations/naming';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { useReportPendingCount } from '../../../../../src/portal/shell/Frame';
import { Page } from '../../../../../src/portal/shell/Page';
import { RequestsSkeleton } from '../../../../../src/portal/skeleton';
import {
  Actions, Button, DataTable, DefinitionList, EmptyState, ErrorNotice, Eyebrow, FormField, Heading, LinkButton,
  Messages, Panel, Small, Stack, useFocusMessage, type Column,
} from '../../../../../src/portal/ui';

// P19. Requests (/admin, staff): docs/portal/spec.md 16.4, F3, F4; the AdminOverview board. Tabs filter by
// status (?status=), the pending queue oldest first and the others newest first, as the server sorts them. A row
// opens its detail (?request=): every field, the note as plain text, “Requested as” when the email changed and
// the warning when the requester already has an organization. Approve (C3) creates the organization, its first
// location and the requester's admin seat; Reject (C4) sends an optional message; View as (C1) shows what the
// requester sees. A decision, or a 409 or 404 for one, takes the request out of the list along with the button
// that opened its dialog, so focus moves to the notice or the line that says what happened (spec 15.7).

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
/** A request link (?request=) to one the list doesn't have, or a decision on one that is gone (404). */
const GONE = 'That request is no longer listed.';
const HAS_ORG = 'This person already belongs to an organization.';
const ORG_NAME_COPY = 'Enter the organization’s name, 2 to 120 characters.';
const LOCATION_NAME_COPY = 'Enter the first location’s name, up to 80 characters.';
const OWN_NAME_COPY = 'Each location needs its own name.';
/** Under the one location's name: with one location, member pages show the organization's name (D29). */
const ONE_LOCATION_HELPER = 'Shown to them only once they have more than one location.';

/** The API's `locationNameKey`: trimmed, lowercase, inner spaces collapsed. Two names with one key are one location. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

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

/** A decision that came too late: decided by someone else (409) or gone (404). The list and the count read again. */
function lateDecision(error: unknown): string | null {
  if (hasCode(error, 409, 'request_not_pending')) return ALREADY_DECIDED;
  if (hasCode(error, 404, 'not_found')) return GONE;
  return null;
}

/**
 * C3. Without places, the town is the request's; the server takes it from there, and First location name starts as
 * “{organization}, {Town}”. With places (a request from the Google search), each has a Location name, starting as
 * “{Google name}, {Town}”, or “{organization}, {Town}” for a street address or a place stored without a name
 * (locations/naming.ts defaultLocationName). With one location its name gets a helper: they see it only once they
 * have a second.
 */
function ApproveDialog(props: {
  request: AdminRequest;
  onApproved: () => void;
  onStale: (text: string) => void;
  /** Reads the list again and keeps the dialog open. */
  onRefresh: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { request, onApproved, onStale, onRefresh } = props;
  const { api, showNotice, refreshPending } = usePortal();
  const [orgName, setOrgName] = useState(request.orgName);
  const [locationName, setLocationName] = useState(() => defaultLocationName({ name: null, kind: 'business', town: request.town }, request.orgName));
  const places = request.places ?? [];
  const [placeNames, setPlaceNames] = useState<string[]>(() => places.map((place) => defaultLocationName(place, request.orgName)));
  const [badNames, setBadNames] = useState<boolean[]>([]);
  const [messages, setMessages] = useState<{ orgName: string | null; locationName: string | null }>({ orgName: null, locationName: null });
  const email = request.requester.email;
  const approve = useAction(useCallback(async (input: ApproveInput) => {
    try {
      const { org } = await approveRequest(api, request.id, input);
      showNotice(
        { text: `Approved. ${org.name} is set up, and ${email} is its admin.`, link: { label: `Open ${org.name}`, href: orgHref(org.id) } },
        /^\/admin$/,
      );
      refreshPending();
      onApproved();
    } catch (error) {
      const late = lateDecision(error);
      if (late !== null) {
        refreshPending();
        onStale(late);
        return;
      }
      // The requester joined an organization meanwhile: the dialog says so, and the list and count read again.
      if (hasCode(error, 409, 'requester_has_org')) {
        refreshPending();
        onRefresh();
      }
      throw error;
    }
  }, [api, showNotice, refreshPending, request.id, email, onApproved, onStale, onRefresh]));

  function submit(): void {
    const trimmedOrg = orgName.trim();
    const orgMessage = trimmedOrg.length < 2 || trimmedOrg.length > 120 ? ORG_NAME_COPY : null;
    if (places.length > 0) {
      const names = placeNames.map((name) => name.trim());
      const counts = new Map<string, number>();
      for (const name of names) counts.set(nameKey(name), (counts.get(nameKey(name)) ?? 0) + 1);
      const bad = names.map((name) => name.length < 1 || name.length > 80 || (counts.get(nameKey(name)) ?? 0) > 1);
      setMessages({ orgName: orgMessage, locationName: null });
      setBadNames(bad);
      if (orgMessage === null && !bad.includes(true)) approve.run({ orgName: trimmedOrg, locationNames: names });
      return;
    }
    const input = { orgName: trimmedOrg, locationName: locationName.trim() };
    const next = {
      orgName: orgMessage,
      locationName: input.locationName.length < 1 || input.locationName.length > 80 ? LOCATION_NAME_COPY : null,
    };
    setMessages(next);
    if (next.orgName === null && next.locationName === null) approve.run(input);
  }

  const town = townLabel(places[0]?.town ?? request.town);
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
      {places.length === 0 ? (
        <>
          <FormField
            label="First location name"
            helper={ONE_LOCATION_HELPER}
            value={locationName}
            onChangeText={setLocationName}
            onSubmitEditing={submit}
            autoCapitalize="words"
            maxLength={80}
            messages={messageOf(messages.locationName)}
          />
          <DefinitionList items={[{ term: 'Town', value: town }]} />
        </>
      ) : (
        places.map((place, index) => (
          <View key={place.placeId} role="group" aria-label={`Place ${index + 1} of ${places.length}`} style={styles.place}>
            <Small>{place.name === null ? townLabel(place.town) : `${place.name}${place.kind === 'address' ? ' (street address)' : ''}, ${townLabel(place.town)}`}</Small>
            <FormField
              label="Location name"
              {...(places.length === 1 ? { helper: ONE_LOCATION_HELPER } : {})}
              value={placeNames[index] ?? ''}
              onChangeText={(text) => { setPlaceNames((names) => names.map((name, at) => (at === index ? text : name))); }}
              onSubmitEditing={submit}
              autoCapitalize="words"
              maxLength={80}
              messages={badNames[index] === true ? [OWN_NAME_COPY] : []}
            />
          </View>
        ))
      )}
      <Small>
        {places.length > 1
          ? `This creates the organization and its ${places.length} locations, and makes ${email} its admin. We email them that they’re in, and they get access the next time they open Townwise.`
          : `This creates the organization and its first location in ${town}, and makes ${email} its admin. We email them that they’re in, and they get access the next time they open Townwise.`}
      </Small>
    </Dialog>
  );
}

/** C4. The message is shown to the requester; the audit log records only that there was one. */
function RejectDialog(props: { request: AdminRequest; onRejected: () => void; onStale: (text: string) => void; onClose: () => void }): React.JSX.Element {
  const { request, onRejected, onStale } = props;
  const { api, showNotice, refreshPending } = usePortal();
  const [message, setMessage] = useState('');
  const reject = useAction(useCallback(async (text: string) => {
    try {
      await rejectRequest(api, request.id, text);
      showNotice({ text: `Rejected the request for ${request.orgName}.`, link: { label: 'See rejected requests', href: '/admin?status=rejected' } }, /^\/admin$/);
      refreshPending();
      onRejected();
    } catch (error) {
      const late = lateDecision(error);
      if (late !== null) {
        refreshPending();
        onStale(late);
        return;
      }
      throw error;
    }
  }, [api, showNotice, refreshPending, request.id, request.orgName, onRejected, onStale]));

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

function RequestTable(props: { status: RequestStatus; requests: readonly AdminRequest[]; selected: AdminRequest | undefined }): React.JSX.Element {
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
        const selected = request.id === props.selected?.id;
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
  /** A late decision's line, for the tab it happened on; `id` makes each one a new line that takes focus. */
  const [stale, setStale] = useState<{ id: number; status: RequestStatus; text: string } | null>(null);
  // Another tab drops it, so coming back doesn't show it again.
  if (stale !== null && stale.status !== status) setStale(null);
  const focusMessage = useFocusMessage();
  const close = useCallback(() => { setOpen(null); }, []);
  const done = useCallback(() => { focusMessage(); setOpen(null); setStale(null); reload(); }, [focusMessage, reload]);
  const onStale = useCallback((text: string) => {
    focusMessage();
    setOpen(null);
    setStale((previous) => ({ id: (previous?.id ?? 0) + 1, status, text }));
    reload();
  }, [focusMessage, reload, status]);

  const pendingCount = state.status === 'ready' ? state.data.pendingCount : null;
  const reportPending = useReportPendingCount();
  useEffect(() => { if (pendingCount !== null) reportPending(pendingCount); }, [pendingCount, reportPending]);
  const tabs = REQUEST_STATUSES.map((value) => ({
    label: value === 'pending' && pendingCount !== null ? `Pending ${formatCount(pendingCount)}` : TAB_LABEL[value],
    href: listHref(value),
    current: value === status,
  }));

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = <RequestsSkeleton label="Loading requests" />;
  } else if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={reload} />;
  } else {
    const { requests } = state.data;
    // A link to a request this list doesn't have says so, rather than showing another request as if it were it.
    const selected = typeof params.request === 'string' ? requests.find((request) => request.id === params.request) : requests[0];
    body = requests.length === 0 ? (
      <EmptyState text={EMPTY[status]}>
        {status === 'pending' ? <LinkButton href={listHref('approved')} label="See approved requests" /> : null}
      </EmptyState>
    ) : (
      <Split
        table={<RequestTable status={status} requests={requests} selected={selected} />}
        detail={selected === undefined ? <EmptyState text={`${GONE} Choose one from the list.`} /> : <RequestDetail request={selected} onOpen={setOpen} />}
      />
    );
  }

  return (
    <Page title="Requests">
      <Stack gap={24}>
        <FilterTabs label="Requests by status" tabs={tabs} />
        {stale === null ? null : <ErrorNotice key={stale.id} message={stale.text} />}
        {body}
      </Stack>
      {open?.kind === 'approve' ? <ApproveDialog request={open.request} onApproved={done} onStale={onStale} onRefresh={reload} onClose={close} /> : null}
      {open?.kind === 'reject' ? <RejectDialog request={open.request} onRejected={done} onStale={onStale} onClose={close} /> : null}
      {open?.kind === 'view' ? <ViewAsDialog target={open.target} onClose={close} /> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { gap: 8 },
  place: { gap: 8 },
});
