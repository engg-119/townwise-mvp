import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../../../../src/auth/AuthProvider';
import { COPY } from '../../../../src/portal/errors';
import { formatCount, formatDate, townLabel } from '../../../../src/portal/format';
import { NumberedList, personEmail, SideHeading } from '../../../../src/portal/gate';
import { useAction } from '../../../../src/portal/hooks';
import { usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { Page } from '../../../../src/portal/shell/Page';
import { TownProfile } from '../../../../src/portal/town/TownProfile';
import { Actions, Button } from '../../../../src/portal/ui/Button';
import { DefinitionList } from '../../../../src/portal/ui/DataTable';
import { ErrorNotice, Notice } from '../../../../src/portal/ui/feedback';
import { Columns, Panel, Section } from '../../../../src/portal/ui/layout';
import { Eyebrow, Heading, Small } from '../../../../src/portal/ui/text';

// P4. Waiting for approval (spec 16.2, F2; the Pending board). Only for a pending request. Check again re-reads
// GET /api/me: any new access opens its own page; no change shows the still-waiting notice. The town profile
// renders from bundled data, so it stays when Townwise can't be reached.

const STILL_WAITING = 'Still waiting. Your organization will appear here once it’s approved.';

export default function WaitingPage(): React.JSX.Element {
  const auth = useAuth();
  const { me, refreshMe } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [still, setStill] = useState(false);
  const check = useAction(useCallback(async () => {
    setStill(false);
    const next = await refreshMe();
    if (next.access.state === 'pending') setStill(true);
  }, [refreshMe]));
  const signOut = useAction(useCallback(() => auth.signOut(), [auth]));
  if (me.access.state !== 'pending') return <View />;
  const { request } = me.access;
  const town = townLabel(request.town);
  const email = personEmail(me);

  const actions = (
    <Actions>
      <Button variant="outline" label="Check again" disabled={check.pending} onPress={check.run} />
      <Button
        variant="link"
        label="Sign out"
        disabled={readOnly}
        {...(readOnly ? { describedBy: 'waiting-ro' } : {})}
        onPress={signOut.run}
      />
    </Actions>
  );
  const side = (
    <View>
      <SideHeading>What happens next</SideHeading>
      <NumberedList
        items={[
          'Someone on our team reviews your request.',
          'We’ll email you when you’re approved.',
          `Once you’re approved, Townwise sets up ${request.orgName}, with you as its admin and its first location in ${town}. Then you upload your sales history and see your town.`,
        ]}
      />
    </View>
  );

  return (
    <Page
      gate
      eyebrow={`Request sent ${formatDate(request.createdAt)}`}
      title="Your request is in"
      lead="Someone on the Townwise team reviews every new organization by hand. We’ll email you when you’re approved."
      leadActions={(
        <View style={styles.leadActions}>
          {actions}
          {readOnly ? <Small nativeID="waiting-ro">{line}</Small> : null}
        </View>
      )}
      side={side}
    >
      {still ? <View style={styles.notice}><Notice text={STILL_WAITING} /></View> : null}
      {check.error === null ? null : <View style={styles.notice}><ErrorNotice error={check.error} onRetry={check.run} /></View>}
      {signOut.error === null ? null : <View style={styles.notice}><ErrorNotice message={COPY.signOutFailed} /></View>}
      <Section first>
        <Columns
          main={(
            <Panel>
              <View style={styles.panelHead}>
                <Eyebrow>Your request</Eyebrow>
                <Heading>What you sent</Heading>
              </View>
              <DefinitionList
                items={[
                  { term: 'Organization', value: request.orgName },
                  { term: 'Your name', value: request.contactName },
                  { term: 'Your role', value: request.contactRole },
                  { term: 'Town', value: town },
                  { term: 'Locations', value: formatCount(request.locationCount) },
                  ...(request.note === null ? [] : [{ term: 'Note', value: request.note }]),
                ]}
              />
            </Panel>
          )}
          side={(
            <Small>
              {`Expecting to join a teammate’s organization instead? Ask their admin to add ${email}. The next time you open Townwise, you can join it with one press.`}
            </Small>
          )}
        />
      </Section>
      <Section>
        <TownProfile town={request.town} heading={`While you wait: ${town}`} />
      </Section>
    </Page>
  );
}

const styles = StyleSheet.create({
  leadActions: { gap: 12, marginTop: 8 },
  notice: { marginBottom: 32 },
  panelHead: { gap: 8 },
});
