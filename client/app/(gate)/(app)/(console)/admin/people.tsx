import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ApiClient } from '../../../../../src/api/client';
import { deletePerson, fetchPeople, lookupPerson, signOutEverywhere } from '../../../../../src/portal/console/api';
import { Dialog } from '../../../../../src/portal/console/Dialog';
import { EMAIL_COPY, isEmailAddress } from '../../../../../src/portal/console/email';
import { orgHref } from '../../../../../src/portal/console/links';
import { CellLines, CellLink, RowActions } from '../../../../../src/portal/console/parts';
import { problemOf } from '../../../../../src/portal/console/problems';
import { PERSON_KINDS, type Person, type PersonKind } from '../../../../../src/portal/console/schemas';
import { useRefreshable } from '../../../../../src/portal/console/useRefreshable';
import { ViewAsDialog, type ViewAsTarget } from '../../../../../src/portal/console/ViewAsDialog';
import { KIND_LABEL, twoStepLabel } from '../../../../../src/portal/console/words';
import { hasCode } from '../../../../../src/portal/errors';
import { formatDate } from '../../../../../src/portal/format';
import { useAction, useBreakpoint } from '../../../../../src/portal/hooks';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import {
  Actions, Button, DataTable, EmptyState, ErrorNotice, FormField, Heading, LoadingLine, Messages, Panel, Select, Small, Stack,
  useFocusMessage,
} from '../../../../../src/portal/ui';

// P22. People (/admin/people, staff): docs/portal/spec.md 16.4, F7, F13; the AdminUsers board. Everyone Townwise
// has a record for, filtered by kind on the server (?kind=) and searched in the browser; anyone else who signed
// in is found by exact email (the lookup). Non-staff rows with a kit user get View as (C1) and Sign out
// everywhere; every non-staff row gets Delete person (C7, the typed email), disabled while the person holds a seat.
// A delete or sign-out reloads the list, which takes the opener with it, so focus moves to the notice (spec 15.7).
// A refusal that shows the page is out of date (409 person_has_seat, 404) reads the list again in place, so the
// opener stays for Cancel to return to. Each of these reads the lookup's result again too.

const SEATED: readonly PersonKind[] = ['org_admin', 'member'];

type Open =
  | { kind: 'signOut'; email: string; userId: string }
  | { kind: 'delete'; person: Person }
  | { kind: 'view'; target: ViewAsTarget }
  | null;

function seatLine(email: string, org: Person['org']): string {
  return `Remove ${email} from ${org?.name ?? 'their organization'} first.`;
}

function rowId(person: Person): string {
  return `seat-${(person.userId ?? person.email).replace(/[^a-zA-Z0-9]/g, '-')}`;
}

function viewTarget(person: Person): ViewAsTarget {
  return { email: person.email, userId: person.userId, orgName: SEATED.includes(person.kind) ? (person.org?.name ?? null) : null };
}

function SignOutDialog(props: { email: string; userId: string; onDone: () => void; onStale: () => void; onClose: () => void }): React.JSX.Element {
  const { email, userId, onDone, onStale } = props;
  const { api, showNotice } = usePortal();
  const signOut = useAction(useCallback(async () => {
    try {
      await signOutEverywhere(api, userId);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) onStale();
      throw error;
    }
    showNotice({ text: `Signed ${email} out everywhere.` }, '/admin/people');
    onDone();
  }, [api, showNotice, email, userId, onDone, onStale]));
  return (
    <Dialog
      title={`Sign out ${email} everywhere?`}
      body={`This signs ${email} out on every device. They can sign in again.`}
      confirmLabel="Sign out everywhere"
      pendingLabel="Signing out…"
      pending={signOut.pending}
      problem={problemOf(signOut.error, (error) => {
        if (hasCode(error, 400, 'invalid_target')) return 'Staff accounts can’t be signed out from here.';
        if (hasCode(error, 404, 'not_found')) return 'This person no longer exists.';
        return null;
      })}
      onConfirm={signOut.run}
      onCancel={props.onClose}
    />
  );
}

/** C7 for a person: the typed email, then their Townwise records go; the kit user record is a runbook step. */
function DeleteDialog(props: { person: Person; onDone: () => void; onStale: () => void; onClose: () => void }): React.JSX.Element {
  const { person, onDone, onStale } = props;
  const { email } = person;
  const { api, showNotice } = usePortal();
  // A seat taken since the list was read: the lookup names the organization they are in now.
  const [seat, setSeat] = useState<Person['org']>(null);
  const remove = useAction(useCallback(async () => {
    let kitUserId: string | null;
    try {
      ({ kitUserId } = await deletePerson(api, email));
    } catch (error) {
      const seated = hasCode(error, 409, 'person_has_seat');
      if (seated) setSeat((await lookupPerson(api, email).catch(() => null))?.org ?? null);
      if (seated || hasCode(error, 404, 'not_found')) onStale();
      throw error;
    }
    const runbook = kitUserId === null ? '' : ' Delete their kit user record by hand (runbook).';
    showNotice({ text: `Deleted ${email}’s Townwise records.${runbook}` }, '/admin/people');
    onDone();
  }, [api, showNotice, email, onDone, onStale]));
  return (
    <Dialog
      title={`Delete ${email}`}
      body={`This deletes ${email}’s requests and invitations, signs them out everywhere, removes their authenticator, and replaces ${email} with “deleted person” in the audit log. Their notes and uploads stay with their organization. This can’t be undone.`}
      typedName={email}
      confirmLabel="Delete person"
      pendingLabel="Deleting…"
      pending={remove.pending}
      problem={problemOf(remove.error, (error) => {
        if (hasCode(error, 409, 'person_has_seat')) {
          const text = seatLine(email, seat);
          return seat === null ? text : { text, link: { label: `Open ${seat.name}’s team`, href: orgHref(seat.id) } };
        }
        if (hasCode(error, 400, 'invalid_target')) return 'Staff accounts can’t be deleted from here.';
        if (hasCode(error, 404, 'not_found')) return 'This person no longer exists.';
        return null;
      })}
      onConfirm={remove.run}
      onCancel={props.onClose}
    />
  );
}

function PeopleTable(props: { label: string; people: readonly Person[]; you: string; onOpen: (open: Open) => void }): React.JSX.Element {
  const { onOpen } = props;
  return (
    <DataTable
      label={props.label}
      columns={[
        { key: 'email', label: 'Email', flex: 1.6 },
        { key: 'kind', label: 'Kind' },
        { key: 'org', label: 'Organization', flex: 1.3 },
        { key: 'since', label: 'Since' },
        { key: 'twoStep', label: 'Two-step' },
        { key: 'actions', label: 'Actions', hiddenLabel: true, flex: 2 },
      ]}
      rows={props.people.map((person) => {
        const staff = person.kind === 'staff';
        const seated = SEATED.includes(person.kind);
        const helper = rowId(person);
        return {
          key: person.userId ?? `email:${person.email}`,
          cells: {
            email: <CellLines main={person.email} note={person.userId !== null && person.userId === props.you ? 'You' : null} white />,
            kind: KIND_LABEL[person.kind],
            org: person.org === null ? 'None' : <CellLink label={person.org.name} href={orgHref(person.org.id)} />,
            since: person.since === null ? 'None' : formatDate(person.since),
            twoStep: twoStepLabel(person.staffTwoStep),
            actions: staff ? null : (
              <View style={styles.actions}>
                <RowActions>
                  {person.userId === null ? null : (
                    <>
                      <Button
                        variant="link"
                        label="View as"
                        accessibilityLabel={`View as ${person.email}`}
                        onPress={() => { onOpen({ kind: 'view', target: viewTarget(person) }); }}
                      />
                      <Button
                        variant="link"
                        label="Sign out everywhere"
                        accessibilityLabel={`Sign out ${person.email} everywhere`}
                        onPress={() => { if (person.userId !== null) onOpen({ kind: 'signOut', email: person.email, userId: person.userId }); }}
                      />
                    </>
                  )}
                  <Button
                    variant="outline"
                    label="Delete person"
                    accessibilityLabel={`Delete ${person.email}`}
                    disabled={seated}
                    {...(seated ? { describedBy: helper } : {})}
                    onPress={() => { onOpen({ kind: 'delete', person }); }}
                  />
                </RowActions>
                {seated ? <Small nativeID={helper}>{seatLine(person.email, person.org)}</Small> : null}
              </View>
            ),
          },
        };
      })}
    />
  );
}

type LookupState =
  | { status: 'idle' }
  /** Not an email address, by the check here or the server's (400). */
  | { status: 'invalid' }
  | { status: 'pending'; address: string }
  | { status: 'found'; address: string; person: Person | null }
  | { status: 'failed'; address: string; error: unknown };

interface Lookup {
  look: LookupState;
  /** Looks up `address`, or says it isn't an email address (null). */
  run: (address: string | null) => void;
  /** Reads a person result again, after a write that changed or removed them. */
  refresh: () => void;
}

/** GET /api/admin/people/lookup?q=. Each run starts a new lookup, and only the newest one's answer shows. */
function useLookup(api: ApiClient): Lookup {
  const [look, setLook] = useState<LookupState>({ status: 'idle' });
  const latest = useRef(0);
  const run = useCallback((address: string | null) => {
    latest.current += 1;
    const ticket = latest.current;
    if (address === null) {
      setLook({ status: 'invalid' });
      return;
    }
    setLook({ status: 'pending', address });
    lookupPerson(api, address).then(
      (person) => { if (ticket === latest.current) setLook({ status: 'found', address, person }); },
      (error: unknown) => {
        if (ticket !== latest.current) return;
        // The server's own check of the address: the same line as the check here.
        setLook(hasCode(error, 400, 'invalid_request') ? { status: 'invalid' } : { status: 'failed', address, error });
      },
    );
  }, [api]);
  const refresh = useCallback(() => {
    if (look.status === 'found' && look.person !== null) run(look.address);
  }, [look, run]);
  return { look, run, refresh };
}

/** “Find a signed-in person by exact email”. The address is checked here first; Look up or Enter starts a lookup. */
function LookupPanel(props: { lookup: Lookup; you: string; onOpen: (open: Open) => void }): React.JSX.Element {
  const { look, run } = props.lookup;
  const [email, setEmail] = useState('');
  function submit(): void {
    const address = email.trim();
    run(isEmailAddress(address) ? address : null);
  }
  return (
    <Panel label="Lookup">
      <Heading level={2}>Find a signed-in person by exact email</Heading>
      <FormField
        label="Email"
        helper="Someone who signed in but was never added and never requested access shows up only here."
        value={email}
        onChangeText={setEmail}
        onSubmitEditing={submit}
        keyboardType="email-address"
        autoCorrect={false}
        maxLength={320}
        messages={look.status === 'invalid' ? [EMAIL_COPY] : []}
      />
      <Actions><Button variant="outline" label={look.status === 'pending' ? 'Looking up…' : 'Look up'} onPress={submit} /></Actions>
      {look.status === 'failed' ? <ErrorNotice error={look.error} onRetry={() => { run(look.address); }} /> : null}
      {look.status !== 'found' ? null : look.person === null
        ? <Messages live="status" items={['No one with that email has signed in or been added.']} />
        : <PeopleTable label="Lookup result" people={[look.person]} you={props.you} onOpen={props.onOpen} />}
    </Panel>
  );
}

export default function PeoplePage(): React.JSX.Element {
  const { api, me } = usePortal();
  const { phone } = useBreakpoint();
  const [kind, setKind] = useState<PersonKind | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Open>(null);
  // `refresh` never rejects; a failed one shows the shared copy with its own Try again.
  const { state, reload, refresh, refreshError } = useRefreshable(useCallback(() => fetchPeople(api, kind), [api, kind]));
  const lookup = useLookup(api);
  const { refresh: refreshLookup } = lookup;
  const focusMessage = useFocusMessage();
  const close = useCallback(() => { setOpen(null); }, []);
  const done = useCallback(() => {
    focusMessage();
    setOpen(null);
    reload();
    refreshLookup();
  }, [focusMessage, reload, refreshLookup]);
  const stale = useCallback(() => {
    void refresh();
    refreshLookup();
  }, [refresh, refreshLookup]);

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = <LoadingLine text="Loading people" minHeight={320} />;
  } else if (state.status === 'failed') {
    body = <ErrorNotice error={state.error} onRetry={reload} />;
  } else {
    const needle = query.trim().toLowerCase();
    const shown = state.data.people.filter((person) => needle === ''
      || person.email.toLowerCase().includes(needle)
      || (person.org?.name.toLowerCase().includes(needle) ?? false));
    body = (
      <Stack gap={16}>
        {refreshError === null ? null : <ErrorNotice error={refreshError} onRetry={() => { void refresh(); }} />}
        {state.data.truncated ? <Messages live="status" items={['Showing the first 1,000 people. Use the search or the lookup.']} /> : null}
        {shown.length === 0
          ? <EmptyState text="No one matches." />
          : <PeopleTable label="Everyone" people={shown} you={me.user.id} onOpen={setOpen} />}
        <Small>Townwise staff can’t be viewed as, signed out or deleted from here. Two-step applies to staff rows only.</Small>
      </Stack>
    );
  }

  return (
    <Page title="People" lead="Everyone Townwise has a record for: staff, members, invited emails and requesters.">
      <Stack gap={32}>
        <View style={phone ? styles.filtersStacked : styles.filters}>
          <View style={styles.filter}>
            <Select
              label="Kind"
              value={kind ?? ''}
              onChange={(value) => { setKind(PERSON_KINDS.find((candidate) => candidate === value) ?? null); }}
              items={[{ value: '', label: 'All kinds' }, ...PERSON_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }))]}
            />
          </View>
          <View style={styles.filter}>
            <FormField label="Search email or organization" value={query} onChangeText={setQuery} autoCorrect={false} />
          </View>
        </View>
        <LookupPanel lookup={lookup} you={me.user.id} onOpen={setOpen} />
        {body}
      </Stack>
      {open?.kind === 'signOut' ? <SignOutDialog email={open.email} userId={open.userId} onDone={done} onStale={stale} onClose={close} /> : null}
      {open?.kind === 'delete' ? <DeleteDialog person={open.person} onDone={done} onStale={stale} onClose={close} /> : null}
      {open?.kind === 'view' ? <ViewAsDialog target={open.target} onClose={close} /> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', columnGap: 20, alignItems: 'flex-start' },
  filtersStacked: { gap: 20 },
  filter: { flex: 1, minWidth: 0, maxWidth: 360 },
  actions: { gap: 4 },
});
