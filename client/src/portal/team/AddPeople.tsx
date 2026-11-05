import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { useAction } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import type { Role } from '../schemas';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/layout';
import { Select } from '../ui/Select';
import { Heading, Small } from '../ui/text';
import { addMembers, type AddResult, type MemberView } from './api';
import { addPeopleIntro, OUTCOME_COPY, parseEmails, TEAM_COPY } from './copy';

// The Add people panel (spec P17, F5): a textarea of up to 20 addresses, a Role select (Member by default), and
// the page's primary, Add. POST /api/org/members answers one outcome per address, listed under the form, and the
// updated team. Addresses that came back invalid stay in the field to fix. Under view-as every control is
// disabled, with the read-only line the team table's actions also point to.

/** The one read-only line on Team, shared with the table's row actions (the Members board). */
export const TEAM_READ_ONLY_ID = 'team-ro';

const ROLE_ITEMS = [{ value: 'member', label: 'Member' }, { value: 'org_admin', label: 'Admin' }];

function AddResults(props: { results: readonly AddResult[] }): React.JSX.Element {
  return (
    <View role="status" aria-label="Results of adding addresses" style={styles.results}>
      {props.results.map((result, index) => (
        <View key={`${String(index)}-${result.email}`} style={styles.result}>
          <Text style={styles.resultEmail}>{result.email}</Text>
          <Text style={styles.resultText}>{OUTCOME_COPY[result.outcome]}</Text>
        </View>
      ))}
    </View>
  );
}

export function AddPeople(props: { org: string; onAdded: (members: MemberView[]) => void }): React.JSX.Element {
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const { onAdded } = props;
  const [text, setText] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<AddResult[] | null>(null);
  const [full, setFull] = useState(false);
  const ro = readOnly ? { readOnly: true, readOnlyId: TEAM_READ_ONLY_ID } : {};

  const add = useAction(useCallback(async (emails: string[], chosen: Role) => {
    try {
      const answer = await addMembers(api, emails, chosen);
      setResults(answer.results);
      setText(answer.results.filter((result) => result.outcome === 'invalid').map((result) => result.email).join('\n'));
      onAdded(answer.members);
    } catch (error) {
      if (hasCode(error, 409, 'member_limit')) { setFull(true); return; }
      throw error;
    }
  }, [api, onAdded]));

  function submit(): void {
    if (readOnly) return;
    const parsed = parseEmails(text);
    setResults(null);
    setFull(false);
    if ('message' in parsed) { setMessage(parsed.message); return; }
    setMessage(null);
    add.run(parsed.emails, role);
  }

  return (
    <Panel label="Add people">
      <Heading>Add people</Heading>
      <Small>{addPeopleIntro(props.org)}</Small>
      <ReadOnlyLine text={line} nativeID={TEAM_READ_ONLY_ID} />
      <FormField
        label="Email addresses"
        helper={TEAM_COPY.emailsHelper}
        value={text}
        onChangeText={setText}
        multiline
        keyboardType="email-address"
        autoComplete="off"
        autoCorrect={false}
        messages={message === null ? [] : [message]}
        {...ro}
      />
      <Select
        label="Role"
        helper={TEAM_COPY.roleHelper}
        value={role}
        onChange={(value) => { setRole(value === 'org_admin' ? 'org_admin' : 'member'); }}
        items={ROLE_ITEMS}
        {...ro}
      />
      {full ? <ErrorNotice message={TEAM_COPY.memberLimit} /> : null}
      {add.error === null ? null : <ErrorNotice error={add.error} onRetry={submit} />}
      <Actions>
        <Button label="Add" disabled={readOnly || add.pending} {...(readOnly ? { describedBy: TEAM_READ_ONLY_ID } : {})} onPress={submit} />
      </Actions>
      {results === null ? null : <AddResults results={results} />}
    </Panel>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  results: { borderTopWidth: 1, borderTopColor: c.border },
  result: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border, gap: 2 },
  resultEmail: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.white },
  resultText: { ...theme.type.sub, color: c.white },
});
