import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { Text, StyleSheet } from 'react-native';

import { deleteOrg, fetchOrg, openAsAdmin, updateOrg } from '../../../../../../src/portal/console/api';
import { AuditTable } from '../../../../../../src/portal/console/AuditTable';
import { Dialog } from '../../../../../../src/portal/console/Dialog';
import { ForecastRuns } from '../../../../../../src/portal/console/ForecastRuns';
import { auditHref, requestHref } from '../../../../../../src/portal/console/links';
import { OrgTeam } from '../../../../../../src/portal/console/OrgTeam';
import { CellLink, Facts } from '../../../../../../src/portal/console/parts';
import { problemOf } from '../../../../../../src/portal/console/problems';
import type { OrgDetail, OrgLocation, StaffOrg } from '../../../../../../src/portal/console/schemas';
import { SetupPanel } from '../../../../../../src/portal/console/SetupPanel';
import { useRefreshable } from '../../../../../../src/portal/console/useRefreshable';
import { REASON_COPY, ViewAsDialog, type ViewAsTarget } from '../../../../../../src/portal/console/ViewAsDialog';
import { hasCode } from '../../../../../../src/portal/errors';
import { formatCount, formatDate, plural, townLabel } from '../../../../../../src/portal/format';
import { useAction } from '../../../../../../src/portal/hooks';
import { usePortal } from '../../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../../src/portal/shell/Page';
import { OrgSkeleton } from '../../../../../../src/portal/skeleton';
import {
  Button, DataTable, EmptyState, ErrorNotice, FormField, LinkButton, Section, Small, Stack, useFocusMessage,
} from '../../../../../../src/portal/ui';
import { theme } from '../../../../../../src/theme';

// P21. Organization detail (/admin/orgs/[orgId], staff): docs/portal/spec.md 16.4, F5, F6, F8, F13; the
// AdminOrgs board. The header line (status, created, the request it came from), Rename and Suspend or Reactivate,
// the team with View as on each active member, the locations as metadata only (D7: day counts and dates, never a
// figure or a note), the newest 20 audit events, and deletion last: only once suspended, with the typed name.
// Every change here is a staff action its admins see (D9); after one the page reads the organization again in
// place. A change that answers 404, or a read after one that does, means another staff member deleted the
// organization meanwhile: the page shows its 404 state, as on load, with no “Saved.”, and focus moves to that line.
// While the organization is active the header also offers Open as admin (D25): the portal as its admin, under a
// banner, before or after anyone joins it (owner call, 2026-11-15), until End, a suspension or the staff sign-in ends.
// Once someone has joined (not `inSetup`) it first asks a reason, as View as does (OpenAsAdminDialog).
// While nobody has joined the organization (`org.inSetup`, D23) the setup panel follows Locations (SetupPanel). When
// any read finds setup closed that the page showed open (someone joined, or it was suspended), the notice says which.
// A setup write that answers 409 org_not_in_setup hides the panel at once, until a newer read lets `inSetup` decide.

const NAME_COPY = 'Enter the organization’s name, 2 to 120 characters.';
const SALES_NOTES_LINE = 'Sales figures and notes are visible only through Open as admin or View as.';
const NO_LOCATIONS = 'No locations yet. The first admin adds one after joining.';
const NO_LOCATIONS_IN_SETUP = 'No locations yet. Add the first one below.';
/** A change went through, but reading the organization again didn't: what the page shows may be old. */
const REFRESH_COPY = 'This page couldn’t load the latest, so it may be out of date.';

/** Why staff setup closed (D23): the organization was suspended, or else someone joined it. */
function setupClosedCopy(name: string, suspended: boolean): string {
  return suspended
    ? `${name} was suspended, so setup is closed.`
    : `Someone joined ${name}, so setup is closed. Use Open as admin to keep working in it, or View as to see their page.`;
}

/** Open as admin's 409 org_suspended: another staff member suspended the organization meanwhile. */
function suspendedCopy(name: string): string {
  return `${name} is suspended, so it can’t be opened as its admin.`;
}

type Open = 'rename' | 'suspend' | 'delete' | 'open' | null;

function missing(error: unknown): boolean {
  // A malformed id is 400 before the lookup; either way there is no such organization.
  return hasCode(error, 404, 'not_found') || hasCode(error, 400, 'invalid_request');
}

/** A write's 404: the organization is gone. (A write's 400 is about its body, so it isn't `missing`.) */
function gone(error: unknown): boolean {
  return hasCode(error, 404, 'not_found');
}

function RenameDialog(props: { org: StaffOrg; onSaved: () => Promise<void>; onGone: () => void; onClose: () => void }): React.JSX.Element {
  const { org, onSaved, onGone } = props;
  const { api } = usePortal();
  const [name, setName] = useState(org.name);
  const [invalid, setInvalid] = useState(false);
  const save = useAction(useCallback(async (next: string) => {
    try {
      await updateOrg(api, org.id, { name: next });
    } catch (error) {
      if (gone(error)) {
        onGone();
        return;
      }
      throw error;
    }
    await onSaved();
  }, [api, org.id, onSaved, onGone]));
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

function SuspendDialog(props: { org: StaffOrg; onSaved: () => Promise<void>; onGone: () => void; onClose: () => void }): React.JSX.Element {
  const { org, onSaved, onGone } = props;
  const { api } = usePortal();
  const suspend = useAction(useCallback(async () => {
    try {
      await updateOrg(api, org.id, { status: 'suspended' });
    } catch (error) {
      if (gone(error)) {
        onGone();
        return;
      }
      throw error;
    }
    await onSaved();
  }, [api, org.id, onSaved, onGone]));
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

/**
 * Open as admin once someone has joined (D25, owner call 2026-11-15): a reason of 5 to 200 characters, as View as asks,
 * which the organization's admins read in their staff activity. The page runs the start (`onStart`) and its refusals.
 */
function OpenAsAdminDialog(props: {
  org: StaffOrg; pending: boolean; error: unknown; onStart: (reason: string) => void; onClose: () => void;
}): React.JSX.Element {
  const { org } = props;
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  function submit(): void {
    const text = reason.trim();
    const bad = text.length < 5 || text.length > 200;
    setInvalid(bad);
    if (!bad) props.onStart(text);
  }
  return (
    <Dialog
      title={`Open ${org.name} as its admin`}
      body={`Someone has joined ${org.name}, so give a reason. You’ll see and change what its admins can, except its team, until you end it or your staff sign-in ends. ${org.name}’s admins see your reason and every change you make in their Townwise staff activity.`}
      confirmLabel="Open its portal"
      pendingLabel="Opening…"
      pending={props.pending}
      problem={problemOf(props.error)}
      onConfirm={submit}
      onCancel={props.onClose}
    >
      <FormField
        label="Reason"
        helper="For example, what you’re helping with."
        value={reason}
        onChangeText={setReason}
        onSubmitEditing={submit}
        autoCapitalize="sentences"
        maxLength={200}
        messages={invalid ? [REASON_COPY] : []}
      />
    </Dialog>
  );
}

/** C7 for an organization: only a suspended one, with its name typed. The notice uses that name. */
/** `onStale` reads the organization again; false when that read found it deleted, and the 404 state shows. */
function DeleteDialog(props: { detail: OrgDetail; onStale: () => Promise<boolean>; onGone: () => void; onClose: () => void }): React.JSX.Element {
  const { org, locations } = props.detail;
  const { onStale, onGone } = props;
  const { api, showNotice } = usePortal();
  const router = useRouter();
  const remove = useAction(useCallback(async () => {
    try {
      await deleteOrg(api, org.id);
    } catch (error) {
      if (gone(error)) {
        onGone();
        return;
      }
      if (hasCode(error, 409, 'org_not_suspended') && !await onStale()) return;
      throw error;
    }
    showNotice({ text: `Deleted ${org.name}.` }, '/admin/orgs');
    router.replace('/admin/orgs');
  }, [api, org.id, org.name, onStale, onGone, showNotice, router]));
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
  const { api, applyMe, showNotice } = usePortal();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ orgId: string }>();
  const orgId = typeof params.orgId === 'string' ? params.orgId : '';
  // A write's outcome is its own: `refresh` never rejects, and a failed one shows REFRESH_COPY with its own Try again.
  const { state, reload, refresh, refreshError } = useRefreshable(useCallback(() => fetchOrg(api, orgId), [api, orgId]));
  const [open, setOpen] = useState<Open>(null);
  const [viewing, setViewing] = useState<ViewAsTarget | null>(null);
  /** The organization a write found deleted; by id, so another organization's page starts fresh. */
  const [goneId, setGoneId] = useState<string | null>(null);
  /** The read on screen when a setup write answered 409 org_not_in_setup: the panel stays hidden until a newer one. */
  const [closedOn, setClosedOn] = useState<OrgDetail | null>(null);
  const focusMessage = useFocusMessage();

  const saved = useCallback(() => { showNotice({ text: 'Saved.' }, pathname); }, [showNotice, pathname]);
  // The page's 404 state replaces the control that was pressed, so focus moves to its line.
  const onGone = useCallback(() => {
    focusMessage();
    setOpen(null);
    setGoneId(orgId);
  }, [focusMessage, orgId]);
  /** Reads the organization again after a change; false when that read found it deleted, and the 404 state shows. */
  const refreshed = useCallback(async () => {
    const failure = await refresh();
    if (failure === null || !missing(failure.error)) return true;
    onGone();
    return false;
  }, [refresh, onGone]);
  // A setup write found setup closed: the panel goes at once and the page reads again. A read that lands says why
  // (below); one that fails can't, so the notice gives the likelier reason, someone joined.
  const setupClosed = useCallback(async (read: OrgDetail) => {
    setClosedOn(read);
    const failure = await refresh();
    if (failure === null) return;
    if (missing(failure.error)) {
      onGone();
      return;
    }
    focusMessage();
    showNotice({ text: setupClosedCopy(read.org.name, false) }, pathname);
  }, [refresh, onGone, focusMessage, showNotice, pathname]);
  // Any read that finds setup closed that the page showed open (after a setup write, Suspend, a join meanwhile) says
  // why, from that read, where focus moves: the panel and what it was saying are gone.
  const shown = state.status === 'ready' ? state.data : null;
  const shownBefore = useRef<OrgDetail | null>(null);
  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = shown;
    if (shown === null || before?.org.id !== shown.org.id) return;
    if (before.org.inSetup !== true || shown.org.inSetup === true) return;
    focusMessage();
    showNotice({ text: setupClosedCopy(shown.org.name, shown.org.status === 'suspended') }, pathname);
  }, [shown, focusMessage, showNotice, pathname]);
  // Open as admin (D25): the answer is the organization's admin access under the banner, and the portal routes to
  // its dashboard. 409 org_suspended (suspended meanwhile) closes the reason dialog and reads the page again, which
  // hides the button, and says so. 400 reason_required (someone joined since the page read) reads the page again and
  // asks the reason.
  const opening = useAction(useCallback(async (reason?: string) => {
    try {
      applyMe(await openAsAdmin(api, orgId, reason));
    } catch (error) {
      if (gone(error)) {
        onGone();
        return;
      }
      if (hasCode(error, 400, 'reason_required')) {
        if (await refreshed()) setOpen('open');
        return;
      }
      if (hasCode(error, 409, 'org_suspended')) {
        setOpen(null);
        await refreshed();
      }
      throw error;
    }
  }, [api, applyMe, orgId, onGone, refreshed]));
  const savedAndClosed = useCallback(async () => {
    if (!await refreshed()) return;
    setOpen(null);
    saved();
  }, [refreshed, saved]);
  const reactivate = useAction(useCallback(async () => {
    try {
      await updateOrg(api, orgId, { status: 'active' });
    } catch (error) {
      if (gone(error)) {
        onGone();
        return;
      }
      throw error;
    }
    if (await refreshed()) saved();
  }, [api, orgId, refreshed, saved, onGone]));

  const isMissing = goneId === orgId
    || (state.status === 'failed' && missing(state.error))
    || (refreshError !== null && missing(refreshError));
  if (isMissing) {
    return (
      <Page eyebrow="Organization" title="Organization">
        <Stack>
          <ErrorNotice message="This organization doesn’t exist." />
          <LinkButton href="/admin/orgs" label="Back to organizations" />
        </Stack>
      </Page>
    );
  }
  if (state.status === 'loading') {
    return <Page eyebrow="Organization" title="Organization"><OrgSkeleton label="Loading the organization" /></Page>;
  }
  if (state.status === 'failed') {
    return <Page eyebrow="Organization" title="Organization"><ErrorNotice error={state.error} onRetry={reload} /></Page>;
  }

  const detail = state.data;
  const { org, members, locations, recent } = detail;
  const suspended = org.status === 'suspended';
  const noAdmin = !members.some((member) => member.status === 'active' && member.role === 'org_admin');
  const inSetup = org.inSetup === true && closedOn !== detail;
  const side = (
    <>
      {suspended ? null : (
        <Button
          variant="outline"
          label={opening.pending && open !== 'open' ? 'Opening…' : 'Open as admin'}
          disabled={opening.pending}
          onPress={() => { if (inSetup) opening.run(); else setOpen('open'); }}
        />
      )}
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
          {org.fromRequestId === null ? null : (
            // A request deleted since (with its requester) has no date: the plain link.
            <CellLink
              label={org.fromRequestSentAt === null ? 'From request' : `From request ${formatDate(org.fromRequestSentAt)}`}
              href={requestHref('approved', org.fromRequestId)}
            />
          )}
        </Facts>
        <Small>{`What you change here is listed in ${org.name}’s Townwise staff activity, which its admins see.`}</Small>
        {suspended ? <Small>{`Members of ${org.name} see that access is paused. Data is kept.`}</Small> : null}
        {noAdmin ? <Small white>No admin yet. Add an admin email.</Small> : null}
        {opening.error === null || open === 'open' ? null
          : <ErrorNotice {...(hasCode(opening.error, 409, 'org_suspended') ? { message: suspendedCopy(org.name) } : { error: opening.error })} />}
        {reactivate.error === null ? null : <ErrorNotice error={reactivate.error} />}
        {refreshError === null ? null : <ErrorNotice message={REFRESH_COPY} onRetry={() => { void refresh(); }} />}
      </Stack>

      <Section title="Team">
        <OrgTeam org={org} members={members} onChanged={refreshed} onSaved={saved} onViewAs={setViewing} onGone={onGone} />
      </Section>

      <Section kicker="Locations, metadata only" title="Locations">
        {locations.length === 0
          ? <EmptyState text={inSetup ? NO_LOCATIONS_IN_SETUP : NO_LOCATIONS} />
          : <LocationTable locations={locations} />}
        <Small>{SALES_NOTES_LINE}</Small>
      </Section>

      {inSetup ? <SetupPanel org={org} locations={locations} onChanged={refreshed} onClosed={() => { void setupClosed(detail); }} /> : null}

      {/* U13B: forecast runs (spec 16.4 P21 Forecasts, 14.4). */}
      <ForecastRuns org={org} locations={locations} />

      <Section kicker="Newest 20 events" title="Recent activity">
        {recent.length === 0 ? <EmptyState text="Nothing recorded yet." /> : <AuditTable label="Recent activity" events={recent} />}
        <LinkButton href={auditHref(org.id)} label={`See ${org.name} in the audit log`} />
      </Section>

      <Section kicker="Last step" title="Delete organization">
        {suspended
          ? <Button variant="outline" label="Delete organization" onPress={() => { setOpen('delete'); }} />
          : <Small>{`Suspend ${org.name} before deleting it.`}</Small>}
      </Section>

      {open === 'rename' ? <RenameDialog org={org} onSaved={savedAndClosed} onGone={onGone} onClose={() => { setOpen(null); }} /> : null}
      {open === 'suspend' ? <SuspendDialog org={org} onSaved={savedAndClosed} onGone={onGone} onClose={() => { setOpen(null); }} /> : null}
      {open === 'open' ? (
        <OpenAsAdminDialog
          org={org}
          pending={opening.pending}
          error={opening.error}
          onStart={opening.run}
          onClose={() => { setOpen(null); }}
        />
      ) : null}
      {open === 'delete' ? <DeleteDialog detail={detail} onStale={refreshed} onGone={onGone} onClose={() => { setOpen(null); }} /> : null}
      {viewing === null ? null : <ViewAsDialog target={viewing} onClose={() => { setViewing(null); }} />}
    </Page>
  );
}

const styles = StyleSheet.create({
  fact: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: theme.color.text2 },
});
