import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { hasCode } from '../errors';
import { formatDate, roleLabel } from '../format';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import type { Role } from '../schemas';
import { Actions, Button } from '../ui/Button';
import { DataTable, EMAIL_FLEX } from '../ui/DataTable';
import { Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Panel, Stack } from '../ui/layout';
import { Select } from '../ui/Select';
import { Heading, Small } from '../ui/text';
import { addOrgMembers, changeOrgMemberRole, removeOrgMember } from './api';
import { Dialog, type Problem } from './Dialog';
import { CellLines, RowActions } from './parts';
import { problemOf } from './problems';
import type { AddResult, Member, StaffOrg } from './schemas';
import type { ViewAsTarget } from './ViewAsDialog';
import { ADD_COPY } from './words';

// P21's Team (spec 16.4, F5, F6): P17's table and add form for any organization, through
// /api/admin/orgs/:orgId/members. Every change is a staff action its admins see (D9), and the rows staff add
// carry “Added by Townwise staff”. Active members get View as, which finds the person by email (MemberView has no
// user id). The last admin can't be demoted or removed (409 last_admin). An add that answers 404 found the
// organization deleted, which the page shows as its own 404 state (`onGone`).

const MAX_EMAILS = 20;

/** Addresses one per line or separated by commas (or spaces, or semicolons), blanks dropped. */
export function splitEmails(text: string): string[] {
  return text.split(/[\s,;]+/).filter((part) => part !== '');
}

function teamRefusal(orgName: string) {
  return (error: unknown): string | null => {
    if (hasCode(error, 409, 'last_admin')) return `${orgName} needs at least one admin. Make someone else an admin first.`;
    if (hasCode(error, 409, 'member_limit')) return `${orgName} has reached 200 people.`;
    if (hasCode(error, 404, 'not_found')) return 'That person isn’t on this team anymore.';
    return null;
  };
}

function RemoveDialog(props: { org: StaffOrg; member: Member; onRemoved: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { org, member, onRemoved } = props;
  const { api } = usePortal();
  const remove = useAction(useCallback(async () => {
    await removeOrgMember(api, org.id, member.id);
    await onRemoved();
  }, [api, org.id, member.id, onRemoved]));
  const invited = member.status === 'invited';
  return (
    <Dialog
      title={invited ? `Remove the invitation for ${member.email}?` : `Remove ${member.email}?`}
      body={invited ? `They can’t join ${org.name} with it anymore.` : 'They lose access on their next visit. Their notes and uploads stay.'}
      confirmLabel={invited ? 'Remove invitation' : 'Remove'}
      pendingLabel="Removing…"
      pending={remove.pending}
      problem={problemOf(remove.error, teamRefusal(org.name))}
      onConfirm={remove.run}
      onCancel={props.onClose}
    />
  );
}

export function OrgTeam(props: {
  org: StaffOrg;
  members: readonly Member[];
  /**
   * Reads the organization again after a change. It never rejects: the page shows a failed read on its own. False
   * when that read found the organization deleted: the page shows its 404 state, so the change isn't reported.
   */
  onChanged: () => Promise<boolean>;
  onSaved: () => void;
  onViewAs: (target: ViewAsTarget) => void;
  /** The organization is gone (a write answered 404). */
  onGone: () => void;
}): React.JSX.Element {
  const { org, onChanged, onSaved, onGone } = props;
  const { api } = usePortal();
  const [removing, setRemoving] = useState<Member | null>(null);
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [field, setField] = useState<string | null>(null);
  const [results, setResults] = useState<readonly AddResult[] | null>(null);

  const changeRole = useAction(useCallback(async (member: Member, next: Role) => {
    await changeOrgMemberRole(api, org.id, member.id, next);
    if (await onChanged()) onSaved();
  }, [api, org.id, onChanged, onSaved]));

  const add = useAction(useCallback(async (list: string[], as: Role) => {
    let answer: { results: AddResult[] };
    try {
      answer = await addOrgMembers(api, org.id, { emails: list, role: as });
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) {
        onGone();
        return;
      }
      throw error;
    }
    setResults(answer.results);
    setEmails('');
    await onChanged();
  }, [api, org.id, onChanged, onGone]));

  const removed = useCallback(async () => {
    setRemoving(null);
    if (await onChanged()) onSaved();
  }, [onChanged, onSaved]);

  function submit(): void {
    const list = splitEmails(emails);
    if (list.length === 0) {
      setField('Enter at least one email address.');
      return;
    }
    if (list.length > MAX_EMAILS) {
      setField(`Add up to ${String(MAX_EMAILS)} addresses at a time.`);
      return;
    }
    setField(null);
    setResults(null);
    add.run(list, role);
  }

  const rowProblem: Problem | null = problemOf(changeRole.error, teamRefusal(org.name));
  const addProblem: Problem | null = problemOf(add.error, teamRefusal(org.name));

  return (
    <Stack gap={20}>
      {rowProblem === null ? null : <Messages live="alert" items={[rowProblem.text]} />}
      {props.members.length === 0 ? null : (
        <DataTable
          label="Team"
          columns={[
            { key: 'email', label: 'Email', flex: EMAIL_FLEX },
            { key: 'role', label: 'Role', flex: 0.7 },
            { key: 'status', label: 'Status', flex: 0.7 },
            { key: 'since', label: 'Since' },
            { key: 'actions', label: 'Actions', hiddenLabel: true, flex: 2 },
          ]}
          rows={props.members.map((member) => {
            const active = member.status === 'active';
            const next: Role = member.role === 'org_admin' ? 'member' : 'org_admin';
            return {
              key: member.id,
              cells: {
                email: <CellLines main={member.email} note={member.addedByStaff ? 'Added by Townwise staff' : null} white />,
                role: roleLabel(member.role),
                status: active ? 'Active' : 'Invited',
                since: active && member.joinedAt !== null ? `Joined ${formatDate(member.joinedAt)}` : `Invited ${formatDate(member.invitedAt)}`,
                actions: (
                  <RowActions>
                    {active ? (
                      <Button
                        variant="link"
                        label="View as"
                        accessibilityLabel={`View as ${member.email}`}
                        onPress={() => { props.onViewAs({ email: member.email, userId: null, orgName: org.name }); }}
                      />
                    ) : null}
                    {active ? (
                      <Button
                        variant="link"
                        label={next === 'org_admin' ? 'Make admin' : 'Make member'}
                        accessibilityLabel={next === 'org_admin' ? `Make ${member.email} an admin` : `Make ${member.email} a member`}
                        disabled={changeRole.pending}
                        onPress={() => { changeRole.run(member, next); }}
                      />
                    ) : null}
                    <Button
                      variant="outline"
                      label={active ? 'Remove' : 'Remove invitation'}
                      accessibilityLabel={active ? `Remove ${member.email}` : `Remove the invitation for ${member.email}`}
                      onPress={() => { setRemoving(member); }}
                    />
                  </RowActions>
                ),
              },
            };
          })}
        />
      )}
      <Panel label="Add people">
        <Heading level={3}>Add people</Heading>
        <Small>Addresses you add here show as added by Townwise staff. Don’t add your own addresses.</Small>
        <FormField
          label="Email addresses"
          helper="One per line or separated by commas, up to 20."
          value={emails}
          onChangeText={setEmails}
          multiline
          autoCorrect={false}
          keyboardType="email-address"
          messages={field === null ? [] : [field]}
        />
        <View style={styles.role}>
          <Select
            label="Role"
            value={role}
            onChange={(value) => { setRole(value === 'org_admin' ? 'org_admin' : 'member'); }}
            items={[{ value: 'member', label: 'Member' }, { value: 'org_admin', label: 'Admin' }]}
          />
        </View>
        {addProblem === null ? null : <Messages live="alert" items={[addProblem.text]} />}
        <Actions>
          <Button label={add.pending ? 'Adding…' : 'Add'} disabled={add.pending} onPress={submit} />
        </Actions>
        {results === null ? null : (
          <Messages live="status" items={results.map((result) => `${result.email}: ${ADD_COPY[result.outcome]}`)} />
        )}
        <Small>
          Each person signs in with Continue with Google using the exact address added here. Townwise accepts Gmail addresses and Google Workspace accounts. We don’t send invitations yet.
        </Small>
      </Panel>
      {removing === null ? null : <RemoveDialog org={org} member={removing} onRemoved={removed} onClose={() => { setRemoving(null); }} />}
    </Stack>
  );
}

const styles = StyleSheet.create({
  role: { maxWidth: 280 },
});
