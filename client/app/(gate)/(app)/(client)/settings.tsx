import { useCallback, useState } from 'react';
import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { roleLabel } from '../../../../src/portal/format';
import { personEmail } from '../../../../src/portal/gate';
import { useLoad } from '../../../../src/portal/hooks';
import { usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { fetchStaffActivity, type StaffActivity } from '../../../../src/portal/settings/api';
import { SETTINGS_COPY, SETTINGS_READ_ONLY_ID } from '../../../../src/portal/settings/copy';
import { LeaveSection } from '../../../../src/portal/settings/LeaveSection';
import { OrgNameForm } from '../../../../src/portal/settings/OrgNameForm';
import { SignOutSection } from '../../../../src/portal/settings/SignOutSection';
import { StaffActivityTable } from '../../../../src/portal/settings/StaffActivityTable';
import { Page } from '../../../../src/portal/shell/Page';
import { LinkButton } from '../../../../src/portal/ui/Button';
import { DefinitionList } from '../../../../src/portal/ui/DataTable';
import { ErrorNotice, LoadingLine, Notice, ReadOnlyLine } from '../../../../src/portal/ui/feedback';
import { Columns, Section } from '../../../../src/portal/ui/layout';
import { inlineTarget, Small } from '../../../../src/portal/ui/text';
import { theme } from '../../../../src/theme';

// P18. Settings (spec 16.3, F7, D9; the OrgSettings board), for anyone with a seat: the account, the link to
// two-step settings (/settings/security), Leave and Sign out. Org admins also rename the organization and read
// its Townwise staff activity (GET /api/org/staff-activity), which the page loads before it shows. Under view-as
// every write is disabled, two-step settings too (they would be the staff member's own), with one read-only line.

const NO_EVENTS: StaffActivity[] = [];

export default function SettingsPage(): React.JSX.Element {
  const { me, api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const access = me.access.state === 'member' ? me.access : null;
  const admin = access?.role === 'org_admin';
  const { state, reload } = useLoad(useCallback(() => (admin ? fetchStaffActivity(api) : Promise.resolve(NO_EVENTS)), [api, admin]));
  const [saved, setSaved] = useState(false);
  const onSaved = useCallback(() => { setSaved(true); }, []);
  const onEdit = useCallback(() => { setSaved(false); }, []);

  if (access === null) return <View />;
  const org = access.org.name;
  const email = personEmail(me);
  if (admin && state.status !== 'ready') {
    return (
      <Page eyebrow={org} title="Settings">
        {state.status === 'loading'
          ? <LoadingLine text={SETTINGS_COPY.loading} minHeight={400} />
          : <ErrorNotice error={state.error} onRetry={reload} />}
      </Page>
    );
  }
  const events = state.status === 'ready' ? state.data : NO_EVENTS;

  return (
    <Page eyebrow={org} title="Settings">
      {saved ? <View style={styles.top}><Notice text={SETTINGS_COPY.saved} /></View> : null}
      {readOnly ? <View style={styles.top}><ReadOnlyLine text={line} nativeID={SETTINGS_READ_ONLY_ID} /></View> : null}
      <Section first>
        <Columns
          main={(
            <Section first kicker="Account" title="Your account">
              <DefinitionList
                items={[
                  { term: 'Email', value: email },
                  { term: 'Organization', value: org },
                  { term: 'Role', value: roleLabel(access.role) },
                ]}
              />
            </Section>
          )}
          side={(
            <Section first kicker="Sign-in" title="Two-step sign-in">
              <Small>{SETTINGS_COPY.twoStep}</Small>
              <LinkButton
                href="/settings/security"
                label="Two-step sign-in settings"
                {...(readOnly ? { disabled: true, describedBy: SETTINGS_READ_ONLY_ID } : {})}
              />
            </Section>
          )}
        />
      </Section>
      {admin ? (
        <Section>
          <Columns
            main={<OrgNameForm name={org} onSaved={onSaved} onEdit={onEdit} />}
            side={(
              <Small>
                {'Locations have their own pages. Add one from '}
                <Link href="/dashboard" style={styles.link}>Locations</Link>
                {'. Rename one or change its town from Location settings on that location’s page.'}
              </Small>
            )}
          />
        </Section>
      ) : null}
      {admin ? (
        <Section kicker="Staff activity" title="Townwise staff activity">
          <Small style={styles.measure}>{SETTINGS_COPY.staffIntro}</Small>
          <StaffActivityTable org={org} events={events} />
        </Section>
      ) : null}
      <LeaveSection org={org} admin={admin} />
      <SignOutSection email={email} />
    </Page>
  );
}

const styles = StyleSheet.create({
  top: { marginBottom: theme.space[8] },
  link: { ...inlineTarget, color: theme.color.white, textDecorationLine: 'underline', textDecorationColor: theme.color.line },
  measure: { maxWidth: 680 },
});
