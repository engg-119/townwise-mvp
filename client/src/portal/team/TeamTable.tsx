import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { formatDate, roleLabel } from '../format';
import { useAction } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import type { Role } from '../schemas';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EmptyState, ErrorNotice, Notice } from '../ui/feedback';
import { Stack } from '../ui/layout';
import { TEAM_READ_ONLY_ID } from './AddPeople';
import { changeRole, removeMember, type MemberView } from './api';
import { removedLine, TEAM_COPY, uninviteBody, uninvitedLine } from './copy';

// The team table (spec P17, F6; the Members board): Email (with “You” or “Added by Townwise staff” under it),
// Role, Status and Since, then the row's actions: Make admin or Make member, and Remove (Remove invitation for an
// invitation), which asks first. Your own row has no actions; you leave from Settings. Each outcome prints above
// the table: Saved., Removed {email}., the last-admin and not-available lines, or the shared error with Try again.

/** What the last row action left to say. */
type Outcome =
  | { kind: 'notice'; text: string }
  | { kind: 'refused'; text: string }
  | { kind: 'failed'; error: unknown; retry: () => void };

export type TeamUpdate = (change: (members: MemberView[]) => MemberView[]) => void;

function since(member: MemberView): string {
  return member.status === 'active'
    ? `Joined ${formatDate(member.joinedAt ?? member.invitedAt)}`
    : `Invited ${formatDate(member.invitedAt)}`;
}

function EmailCell(props: { member: MemberView }): React.JSX.Element {
  const { member } = props;
  return (
    <View style={styles.who}>
      <Text style={styles.email}>{member.email}</Text>
      {member.isYou ? <Text style={styles.note}>You</Text> : null}
      {member.addedByStaff ? <Text style={styles.note}>Added by Townwise staff</Text> : null}
    </View>
  );
}

function OutcomeLine(props: { outcome: Outcome }): React.JSX.Element {
  const { outcome } = props;
  if (outcome.kind === 'notice') return <Notice text={outcome.text} />;
  if (outcome.kind === 'refused') return <ErrorNotice message={outcome.text} />;
  return <ErrorNotice error={outcome.error} onRetry={outcome.retry} />;
}

export function TeamTable(props: { org: string; members: readonly MemberView[]; update: TeamUpdate }): React.JSX.Element {
  const { api } = usePortal();
  const { readOnly } = useReadOnly();
  const { update } = props;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const [removeError, setRemoveError] = useState<unknown>(null);

  /** 409 last_admin and 404 have their own lines; a 404 row is gone, so it leaves the table. */
  const refusal = useCallback((error: unknown, member: MemberView): Outcome | null => {
    if (hasCode(error, 409, 'last_admin')) return { kind: 'refused', text: TEAM_COPY.lastAdmin };
    if (hasCode(error, 404, 'not_found')) {
      update((members) => members.filter((row) => row.id !== member.id));
      return { kind: 'refused', text: TEAM_COPY.notFound };
    }
    return null;
  }, [update]);

  const role = useAction(useCallback(async (member: MemberView, next: Role, again: () => void) => {
    setOutcome(null);
    try {
      const changed = await changeRole(api, member.id, next);
      update((members) => members.map((row) => (row.id === changed.id ? changed : row)));
      setOutcome({ kind: 'notice', text: TEAM_COPY.saved });
    } catch (error) {
      setOutcome(refusal(error, member) ?? { kind: 'failed', error, retry: again });
    }
  }, [api, update, refusal]));

  const remove = useAction(useCallback(async (member: MemberView) => {
    setRemoveError(null);
    try {
      await removeMember(api, member.id);
    } catch (error) {
      const refused = refusal(error, member);
      // Anything else stays in the dialog with the shared copy, so Remove can be pressed again.
      if (refused === null) { setRemoveError(error); return; }
      setRemoving(null);
      setOutcome(refused);
      return;
    }
    update((members) => members.filter((row) => row.id !== member.id));
    setRemoving(null);
    setOutcome({ kind: 'notice', text: member.status === 'invited' ? uninvitedLine(member.email) : removedLine(member.email) });
  }, [api, update, refusal]));

  function changeTo(member: MemberView): void {
    const next: Role = member.role === 'org_admin' ? 'member' : 'org_admin';
    const again = (): void => { role.run(member, next, again); };
    again();
  }

  function ask(member: MemberView): void {
    setOutcome(null);
    setRemoveError(null);
    setRemoving(member);
  }

  const ro = readOnly ? { disabled: true, describedBy: TEAM_READ_ONLY_ID } : {};
  function actions(member: MemberView): React.ReactNode {
    if (member.isYou) return null;
    const roleAction = member.role === 'org_admin' ? 'Make member' : 'Make admin';
    const removeAction = member.status === 'invited' ? 'Remove invitation' : 'Remove';
    return (
      <View style={styles.actions}>
        <Button
          variant="link"
          label={roleAction}
          accessibilityLabel={`${roleAction}, ${member.email}`}
          onPress={() => { changeTo(member); }}
          {...ro}
        />
        <Button
          variant="outline"
          label={removeAction}
          accessibilityLabel={`${removeAction}, ${member.email}`}
          onPress={() => { ask(member); }}
          {...ro}
        />
      </View>
    );
  }

  const others = props.members.filter((member) => !member.isYou);
  const invitation = removing?.status === 'invited';
  const email = removing?.email ?? '';

  return (
    <Stack>
      {outcome === null ? null : <OutcomeLine outcome={outcome} />}
      {others.length === 0 ? <EmptyState text={TEAM_COPY.empty} /> : (
        <DataTable
          label="Team members and invited addresses"
          columns={[
            { key: 'email', label: 'Email', flex: 1.6 },
            { key: 'role', label: 'Role', flex: 0.7 },
            { key: 'status', label: 'Status', flex: 0.7 },
            { key: 'since', label: 'Since' },
            { key: 'actions', label: 'Actions', flex: 1.4, hiddenLabel: true },
          ]}
          rows={props.members.map((member) => ({
            key: member.id,
            cells: {
              email: <EmailCell member={member} />,
              role: roleLabel(member.role),
              status: member.status === 'active' ? 'Active' : 'Invited',
              since: since(member),
              actions: actions(member),
            },
          }))}
        />
      )}
      <ConfirmDialog
        visible={removing !== null}
        title={invitation ? `Remove the invitation for ${email}?` : `Remove ${email}?`}
        body={invitation ? uninviteBody(props.org) : TEAM_COPY.removeBody}
        confirmLabel={invitation ? 'Remove invitation' : 'Remove'}
        pendingLabel="Removing…"
        pending={remove.pending}
        error={removeError}
        onConfirm={() => { if (removing !== null) remove.run(removing); }}
        onCancel={() => { setRemoving(null); }}
      />
    </Stack>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  who: { gap: 2, minWidth: 0 },
  email: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.white },
  note: { ...theme.type.small, color: c.text2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 4 },
});
