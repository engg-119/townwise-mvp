import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { roleLabel } from '../../../../src/portal/format';
import { personEmail } from '../../../../src/portal/gate';
import { useAction, useLoad } from '../../../../src/portal/hooks';
import { useOrg, usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { NameField } from '../../../../src/portal/profile/NameField';
import { fetchStaffActivity, type StaffActivity, type StaffActivityPage } from '../../../../src/portal/settings/api';
import { SETTINGS_COPY, SETTINGS_READ_ONLY_ID } from '../../../../src/portal/settings/copy';
import { LeaveSection } from '../../../../src/portal/settings/LeaveSection';
import { LocationsMap } from '../../../../src/portal/settings/LocationsMap';
import { OrgNameForm } from '../../../../src/portal/settings/OrgNameForm';
import { SignOutSection } from '../../../../src/portal/settings/SignOutSection';
import { StaffActivityTable } from '../../../../src/portal/settings/StaffActivityTable';
import { Page } from '../../../../src/portal/shell/Page';
import { SettingsSkeleton } from '../../../../src/portal/skeleton';
import { Actions, Button, LinkButton } from '../../../../src/portal/ui/Button';
import { DefinitionList } from '../../../../src/portal/ui/DataTable';
import { ErrorNotice, Notice, ReadOnlyLine } from '../../../../src/portal/ui/feedback';
import { Columns, Section, Stack } from '../../../../src/portal/ui/layout';
import { Small } from '../../../../src/portal/ui/text';
import { theme } from '../../../../src/theme';

// P18. Settings (spec 16.3, F7, D9; the OrgSettings board), for anyone with a seat: the account, the link to
// two-step settings (/settings/security), Leave and Sign out. Org admins also rename the organization, get Add location
// (/locations/new), and read its Townwise staff activity (GET /api/org/staff-activity), which the page loads before it shows, 50 events at a
// time, with Show older for the rest. Under view-as every write is disabled, two-step settings too (they would be
// the staff member's own), with one read-only line. D47: under the organization's name, one map of every location
// with a lettered pin and a legend (settings/LocationsMap.tsx), for anyone with a seat, once GET /api/org answers; the
// rest of the page never waits for it.

const NO_EVENTS: StaffActivityPage = { events: [], nextBefore: null };

export default function SettingsPage(): React.JSX.Element {
  const { me, api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const orgLoad = useOrg().state;
  const access = me.access.state === 'member' ? me.access : null;
  const admin = access?.role === 'org_admin';
  const { state, reload } = useLoad(useCallback(() => (admin ? fetchStaffActivity(api) : Promise.resolve(NO_EVENTS)), [api, admin]));
  // Older pages, kept only for the first page they follow, so a reload starts again from the newest.
  const [older, setOlder] = useState<{ after: StaffActivityPage; events: StaffActivity[]; nextBefore: string | null } | null>(null);
  const first = state.status === 'ready' ? state.data : NO_EVENTS;
  const extra = older?.after === first ? older : null;
  // The last page loaded says whether there is another.
  const nextBefore = extra !== null ? extra.nextBefore : first.nextBefore;
  const showOlder = useAction(useCallback(async () => {
    if (nextBefore === null) return;
    const page = await fetchStaffActivity(api, nextBefore);
    setOlder((previous) => ({
      after: first, events: [...(previous?.after === first ? previous.events : []), ...page.events], nextBefore: page.nextBefore,
    }));
  }, [api, first, nextBefore]));
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
          ? <SettingsSkeleton label={SETTINGS_COPY.loading} />
          : <ErrorNotice error={state.error} onRetry={reload} />}
      </Page>
    );
  }
  const events = [...first.events, ...(extra?.events ?? [])];

  return (
    <Page eyebrow={org} title="Settings">
      {saved ? <Notice text={SETTINGS_COPY.saved} style={styles.top} /> : null}
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
              <NameField onSaved={onSaved} onEdit={onEdit} />
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
              <Stack>
                <Small>Locations have their own pages. Rename one or change its town from Location settings, under More.</Small>
                {/* Straight to Add location: with one location, Locations opens that location's Home (P9). */}
                <Actions>
                  <LinkButton
                    variant="outline"
                    href="/locations/new"
                    label="Add location"
                    {...(readOnly ? { disabled: true, describedBy: SETTINGS_READ_ONLY_ID } : {})}
                  />
                </Actions>
              </Stack>
            )}
          />
        </Section>
      ) : null}
      {orgLoad.status === 'ready' ? <LocationsMap org={orgLoad.data} admin={admin} readOnly={readOnly} /> : null}
      {admin ? (
        <Section kicker="Staff activity" title="Townwise staff activity">
          <Small style={styles.measure}>{SETTINGS_COPY.staffIntro}</Small>
          <StaffActivityTable org={org} events={events} />
          {showOlder.error === null ? null : <ErrorNotice error={showOlder.error} onRetry={showOlder.run} />}
          {nextBefore === null ? null : (
            <Actions>
              <Button
                variant="link"
                label={showOlder.pending ? SETTINGS_COPY.loadingOlder : SETTINGS_COPY.showOlder}
                disabled={showOlder.pending}
                onPress={showOlder.run}
              />
            </Actions>
          )}
        </Section>
      ) : null}
      {me.openAsAdmin == null ? <LeaveSection org={org} admin={admin} /> : null}
      <SignOutSection email={email} />
    </Page>
  );
}

const styles = StyleSheet.create({
  top: { marginBottom: theme.space[8] },
  measure: { maxWidth: 680 },
});
