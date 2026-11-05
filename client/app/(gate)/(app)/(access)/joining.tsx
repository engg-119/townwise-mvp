import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { declineInvite, joinInvite } from '../../../../src/portal/api';
import { hasCode } from '../../../../src/portal/errors';
import { formatDate, plural, roleLabel, townLabel } from '../../../../src/portal/format';
import { inviterOf, NumberedList, personEmail, SideHeading } from '../../../../src/portal/gate';
import { useAction, useBreakpoint } from '../../../../src/portal/hooks';
import { usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { Page } from '../../../../src/portal/shell/Page';
import type { AccessRequest, Invitation, MeResponse } from '../../../../src/portal/schemas';
import { Actions, Button } from '../../../../src/portal/ui/Button';
import { DefinitionList } from '../../../../src/portal/ui/DataTable';
import { ErrorNotice, Notice, ReadOnlyLine } from '../../../../src/portal/ui/feedback';
import { Columns, Pair, Panel } from '../../../../src/portal/ui/layout';
import { Eyebrow, Heading, Mono, Small } from '../../../../src/portal/ui/text';
import { theme } from '../../../../src/theme';

// P6. Joining (spec 16.2, F1, F2b; the Joining board), for `invited`.
// - One invitation and no pending request, as the page opens: join at once (POST /api/me/join), showing
//   “Joining {org}…”, then Locations with the one-time notice naming who added them (lead default, D3).
// - With a pending request (F2b), or two or more invitations, nothing joins until a press: Join on one, or
//   Not my team (POST /api/me/decline) on any. Join withdraws the pending request; Not my team keeps it.
// - 409 no_invite or already_in_org re-read the access and route. Under view-as, Join and Not my team are disabled
//   and nothing joins on its own.

const CLIENT_PATHS = /^\/(dashboard|locations\/)/;

interface Last { kind: 'join' | 'decline'; invitation: Invitation }

function RequestPanel(props: { request: AccessRequest }): React.JSX.Element {
  const { request } = props;
  return (
    <Panel>
      <View style={styles.panelHead}><Eyebrow>Your request</Eyebrow><Heading>{request.orgName}</Heading></View>
      <DefinitionList
        items={[
          { term: 'Your role', value: 'Admin, once approved' },
          { term: 'Town', value: townLabel(request.town) },
          { term: 'Sent', value: formatDate(request.createdAt) },
        ]}
      />
    </Panel>
  );
}

export default function JoiningPage(): React.JSX.Element {
  const { me, api, applyMe, refreshMe, showNotice } = usePortal();
  const { readOnly, line } = useReadOnly();
  const { phone } = useBreakpoint();
  const [declined, setDeclined] = useState<string | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const access = me.access.state === 'invited' ? me.access : null;
  // Decided once, as the page opens: after a Not my team here, or a changed invitation, what is left waits for a press.
  const [auto, setAuto] = useState(() => access !== null && access.invitations.length === 1 && access.pendingRequest === null && !readOnly);
  const email = personEmail(me);

  const afterConflict = useCallback(async (error: unknown): Promise<void> => {
    if (hasCode(error, 409, 'no_invite') || hasCode(error, 409, 'already_in_org')) {
      setAuto(false);
      await refreshMe();
      return;
    }
    throw error;
  }, [refreshMe]);

  const act = useAction(useCallback(async (next: Last) => {
    setLast(next);
    setDeclined(null);
    let answer: MeResponse;
    try {
      answer = next.kind === 'join' ? await joinInvite(api, next.invitation.inviteId) : await declineInvite(api, next.invitation.inviteId);
    } catch (error) {
      await afterConflict(error);
      return;
    }
    if (next.kind === 'join' && answer.access.state === 'member') {
      const org = answer.access.org.name;
      showNotice(
        { text: `You joined ${org}. ${inviterOf(next.invitation)} added ${personEmail(answer)}. Not your team?`, link: { label: `Leave ${org}`, href: '/settings' } },
        CLIENT_PATHS,
      );
    }
    if (next.kind === 'decline' && answer.access.state === 'invited') setDeclined(`Removed the invitation from ${next.invitation.orgName}.`);
    applyMe(answer);
  }, [api, applyMe, afterConflict, showNotice]));

  const started = useRef(false);
  const first = access?.invitations[0];
  const run = act.run;
  useEffect(() => {
    if (!auto || started.current || first === undefined) return;
    started.current = true;
    run({ kind: 'join', invitation: first });
  }, [auto, first, run]);

  if (access === null) return <View />;
  const { invitations, pendingRequest } = access;
  const pending = act.pending;
  const disabled = readOnly || pending;
  const roProps = readOnly ? { describedBy: 'joining-ro' } : {};
  const error = act.error === null ? null : (
    <ErrorNotice error={act.error} {...(last === null ? {} : { onRetry: () => { act.run(last); } })} />
  );
  const notice = declined === null ? null : <View style={styles.notice}><Notice text={declined} /></View>;

  if (auto && first !== undefined) {
    return (
      <Page gate eyebrow="Your team" title={`Joining ${first.orgName}…`} lead={`${inviterOf(first)} added ${email}.`}>
        {error}
      </Page>
    );
  }

  if (invitations.length === 1 && first !== undefined) {
    const org = first.orgName;
    const lead = pendingRequest === null
      ? `${inviterOf(first)} added ${email} to ${org}.`
      : `${inviterOf(first)} added ${email} to ${org}. Your request for ${pendingRequest.orgName} is still with our team. If you join ${org}, we withdraw that request.`;
    const side = pendingRequest === null ? undefined : (
      <View>
        <SideHeading>What each choice does</SideHeading>
        <NumberedList
          items={[
            `Join: you join ${org}’s team as a ${roleLabel(first.role)} and see its locations. We withdraw your request for ${pendingRequest.orgName}.`,
            `Not my team: we remove this invitation. Your request for ${pendingRequest.orgName} stays with our team, and you’re back to waiting.`,
          ]}
        />
      </View>
    );
    return (
      <Page
        gate
        eyebrow="Your team"
        title={`Join ${org}?`}
        lead={lead}
        leadActions={(
          <View style={styles.leadActions}>
            <ReadOnlyLine text={line} nativeID="joining-ro" />
            <Actions>
              <Button label={`Join ${org}`} disabled={disabled} {...roProps} onPress={() => { act.run({ kind: 'join', invitation: first }); }} />
              <Button variant="link" label="Not my team" disabled={disabled} {...roProps} onPress={() => { act.run({ kind: 'decline', invitation: first }); }} />
            </Actions>
            {error}
          </View>
        )}
        {...(side === undefined ? {} : { side })}
      >
        {notice}
        <Columns
          main={(
            <Pair>
              <Panel>
                <View style={styles.panelHead}><Eyebrow>Invitation</Eyebrow><Heading>{org}</Heading></View>
                <DefinitionList items={[{ term: 'Your role', value: roleLabel(first.role) }, { term: 'Added by', value: inviterOf(first) }]} />
              </Panel>
              {pendingRequest === null ? null : <RequestPanel request={pendingRequest} />}
            </Pair>
          )}
        />
      </Page>
    );
  }

  const lead = `${plural(invitations.length, 'organization', 'organizations')} added ${email}. You can belong to one. Choose the team you work with.${
    pendingRequest === null ? '' : ` Joining one withdraws your request for ${pendingRequest.orgName}.`}`;
  return (
    <Page gate eyebrow="Your team" title="Choose your team" lead={lead}>
      {notice}
      <Columns
        main={(
          <View style={styles.choose}>
            <ReadOnlyLine text={line} nativeID="joining-ro" />
            <View role="list" aria-label="Invitations" style={styles.list}>
              {invitations.map((invitation) => (
                <View key={invitation.inviteId} role="listitem" style={[styles.row, phone ? styles.rowPhone : null]}>
                  <View style={styles.rowText}>
                    <View style={styles.rowName}>
                      <Text style={styles.org}>{invitation.orgName}</Text>
                      <Mono>{`as ${roleLabel(invitation.role)}`}</Mono>
                    </View>
                    <Small>{`Added by ${inviterOf(invitation)}`}</Small>
                  </View>
                  <Actions>
                    <Button
                      variant="outline"
                      label="Join"
                      accessibilityLabel={`Join ${invitation.orgName}`}
                      disabled={disabled}
                      {...roProps}
                      onPress={() => { act.run({ kind: 'join', invitation }); }}
                    />
                    <Button
                      variant="link"
                      label="Not my team"
                      accessibilityLabel={`Not my team: ${invitation.orgName}`}
                      disabled={disabled}
                      {...roProps}
                      onPress={() => { act.run({ kind: 'decline', invitation }); }}
                    />
                  </Actions>
                </View>
              ))}
            </View>
            {error}
          </View>
        )}
      />
    </Page>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  panelHead: { gap: 8 },
  leadActions: { gap: 12, marginTop: 8 },
  notice: { marginBottom: 32 },
  choose: { gap: 16 },
  list: { borderTopWidth: 1, borderTopColor: c.border },
  row: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 24, rowGap: 8,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  rowPhone: { flexDirection: 'column', alignItems: 'flex-start' },
  rowText: { gap: 4, flexShrink: 1, minWidth: 0 },
  rowName: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4 },
  org: { ...theme.type.body, fontWeight: 600, color: c.white },
});
