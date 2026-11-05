import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { CONTACT_EMAIL, CONTACT_HREF } from '../../../../src/portal/contact';
import { formatDate } from '../../../../src/portal/format';
import { personEmail, QuestionsLine, SignedInLine } from '../../../../src/portal/gate';
import { usePortal } from '../../../../src/portal/PortalProvider';
import { Page } from '../../../../src/portal/shell/Page';
import type { Access } from '../../../../src/portal/schemas';
import { Actions, LinkButton } from '../../../../src/portal/ui/Button';
import { Columns, Panel, Stack } from '../../../../src/portal/ui/layout';
import { Body, inlineTarget, Lead } from '../../../../src/portal/ui/text';
import { theme } from '../../../../src/theme';

// P5. No access (spec 16.2, F4, F7; the NoAccess board): a request that wasn't approved, removed by an admin,
// left, or an organization staff paused. The page has no primary: each action is an outline button or a text
// link. Request access is open from here by choice, for rejected and removed.

type Variant = Extract<Access, { state: 'rejected' | 'removed' | 'org_suspended' }>;

function Rejected(props: { access: Extract<Variant, { state: 'rejected' }> }): React.JSX.Element {
  const { request } = props.access;
  return (
    <Page
      gate
      eyebrow="No access"
      title="We can’t give you access yet"
      lead={`We reviewed your request for ${request.orgName} on ${formatDate(request.decidedAt ?? request.createdAt)} and didn’t approve it.`}
    >
      <Columns
        main={(
          <Stack>
            {request.decisionMessage === null ? null : (
              <Panel><Body>{`Message from the Townwise team: “${request.decisionMessage}”`}</Body></Panel>
            )}
            <Body>If something has changed, you can send a new request.</Body>
            <Actions><LinkButton variant="outline" href="/request-access" label="Send a new request" /></Actions>
            <QuestionsLine />
            <SignedInLine />
          </Stack>
        )}
      />
    </Page>
  );
}

function Removed(props: { access: Extract<Variant, { state: 'removed' }>; email: string }): React.JSX.Element {
  const { org, byYou } = props.access;
  const title = byYou ? `You left ${org.name}` : `You no longer have access to ${org.name}`;
  const lead = byYou
    ? `If you left by mistake, ask an admin there to add ${props.email} again.`
    : `${props.email} isn’t on ${org.name}’s team anymore. If that’s a mistake, ask an admin there to add you again.`;
  return (
    <Page gate eyebrow="No access" title={title} lead={lead}>
      <Columns
        main={(
          <Stack>
            <Actions><LinkButton href="/request-access" label="Request access for a different organization" /></Actions>
            <QuestionsLine />
            <SignedInLine />
          </Stack>
        )}
      />
    </Page>
  );
}

function Paused(props: { access: Extract<Variant, { state: 'org_suspended' }> }): React.JSX.Element {
  const { org } = props.access;
  return (
    <Page
      gate
      eyebrow="No access"
      title={`Access to ${org.name} is paused`}
      lead={(
        <Lead>
          {`The Townwise team has paused access for ${org.name}. Your organization’s data is kept. Questions: `}
          <Link href={CONTACT_HREF} style={styles.link}>{CONTACT_EMAIL}</Link>
          .
        </Lead>
      )}
    >
      <Columns main={<SignedInLine />} />
    </Page>
  );
}

export default function NoAccessPage(): React.JSX.Element {
  const { me } = usePortal();
  const { access } = me;
  if (access.state === 'rejected') return <Rejected access={access} />;
  if (access.state === 'removed') return <Removed access={access} email={personEmail(me)} />;
  if (access.state === 'org_suspended') return <Paused access={access} />;
  return <View />;
}

const styles = StyleSheet.create({
  link: { ...inlineTarget, color: theme.color.white, textDecorationLine: 'underline', textDecorationColor: theme.color.line },
});
