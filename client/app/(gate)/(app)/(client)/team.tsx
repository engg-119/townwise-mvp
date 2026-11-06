import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useLoad } from '../../../../src/portal/hooks';
import { usePortal } from '../../../../src/portal/PortalProvider';
import { Page } from '../../../../src/portal/shell/Page';
import { AddPeople } from '../../../../src/portal/team/AddPeople';
import { fetchMembers, type MemberView } from '../../../../src/portal/team/api';
import { TEAM_COPY } from '../../../../src/portal/team/copy';
import { TeamTable, type TeamUpdate } from '../../../../src/portal/team/TeamTable';
import { ErrorNotice, LoadingLine } from '../../../../src/portal/ui/feedback';
import { Columns, Section, Stack } from '../../../../src/portal/ui/layout';
import { Mono, Small } from '../../../../src/portal/ui/text';
import { theme } from '../../../../src/theme';

// P17. Team (spec 16.3, F5, F6; the Members board), for org admins: add teammates' addresses with a role, change
// roles, remove people and invitations. The add form never waits for the list; the list loads in its own section
// (GET /api/org/members) and every write's answer updates it in place. Under view-as (only when the target is an
// org admin, routing.ts) every write is disabled.

const STEPS = [
  { title: 'Their address shows as Invited.', text: 'It’s on the list below, with the role you picked.' },
  { title: 'You tell them.', text: 'Townwise doesn’t email invitations. Send them townwise.tech and the address you added.' },
  {
    title: 'They continue with Google.',
    text: 'The first time they sign in with that address, they join, and Townwise shows them who added them. Their row turns Active.',
  },
];

function HowJoining(): React.JSX.Element {
  return (
    <Stack gap={theme.space[5]}>
      <Section first kicker="How joining works" title="After you add someone">
        <View role="list" style={styles.steps}>
          {STEPS.map((step, index) => (
            <View key={step.title} role="listitem" style={styles.step}>
              <Mono tone="text3" style={styles.counter}>{String(index + 1).padStart(2, '0')}</Mono>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>{step.title}</Text>
                <Small>{step.text}</Small>
              </View>
            </View>
          ))}
        </View>
      </Section>
      <Small>Signed in with a different Google account? They see Request access instead. Ask which address they use, and add that one.</Small>
    </Stack>
  );
}

export default function TeamPage(): React.JSX.Element {
  const { me, api } = usePortal();
  const { state, reload } = useLoad(useCallback(() => fetchMembers(api), [api]));
  // The list as the last write left it; null until a write answers, so the loaded list shows.
  const [team, setTeam] = useState<MemberView[] | null>(null);
  const loaded = state.status === 'ready' ? state.data : null;
  const update = useCallback<TeamUpdate>((change) => {
    setTeam((current) => change(current ?? loaded ?? []));
  }, [loaded]);
  const [added, setAdded] = useState(0);
  const onAdded = useCallback((members: MemberView[]) => { setTeam(members); setAdded((count) => count + 1); }, []);
  const retry = useCallback(() => { setTeam(null); reload(); }, [reload]);

  const access = me.access.state === 'member' ? me.access : null;
  if (access === null) return <View />;
  const org = access.org.name;
  const members = team ?? loaded;

  let list: React.ReactNode;
  if (members !== null) list = <TeamTable org={org} members={members} update={update} addedCount={added} />;
  else if (state.status === 'failed') list = <ErrorNotice error={state.error} onRetry={retry} />;
  else list = <LoadingLine text={TEAM_COPY.loading} />;

  return (
    <Page eyebrow={org} title="Team" lead={TEAM_COPY.lead}>
      <Section first>
        <Columns main={<AddPeople org={org} onAdded={onAdded} />} side={<HowJoining />} />
      </Section>
      <Section kicker="Members" title="Who can sign in">
        <Small>Active people have joined. Invited addresses are waiting for that person to continue with Google for the first time.</Small>
        <Small>
          Admins manage the team, the locations and the organization name, and can delete sales data. Members see every location,
          upload new days of sales history and write notes.
        </Small>
        {list}
      </Section>
    </Page>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  steps: { borderTopWidth: 1, borderTopColor: c.border },
  step: { flexDirection: 'row', columnGap: theme.space[2], paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  counter: { width: 28, lineHeight: 20 },
  stepBody: { flex: 1, minWidth: 0, gap: 2 },
  stepTitle: { ...theme.type.ui, color: c.white },
});
