import { useCallback } from 'react';
import { View } from 'react-native';

import { useAuth } from '../../../../../src/auth/AuthProvider';
import { COPY } from '../../../../../src/portal/errors';
import { useAction } from '../../../../../src/portal/hooks';
import { usePortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { Actions, Button } from '../../../../../src/portal/ui/Button';
import { ErrorNotice } from '../../../../../src/portal/ui/feedback';
import { Stack } from '../../../../../src/portal/ui/layout';

// P8. Staff sign in again (spec 16.2, F9, D2), for staff_reauth_required: a session from before two-step sign-in
// was on, or more than 60 minutes old. Sign in again is the kit's logout, after which the gate opens /sign-in,
// where the next sign-in passes a code.

const REASON = {
  session_before_codes: 'This session started before two-step sign-in was on.',
  session_too_old: 'Staff sessions need a fresh sign-in with your code every 60 minutes.',
} as const;

export default function StaffSignInAgainPage(): React.JSX.Element {
  const auth = useAuth();
  const { me } = usePortal();
  const signOut = useAction(useCallback(() => auth.signOut(), [auth]));
  if (me.access.state !== 'staff_reauth_required') return <View />;
  return (
    <Page gate eyebrow="Townwise staff" title="Sign in again to use the staff console" lead={REASON[me.access.reason]}>
      <Stack>
        <Actions><Button label="Sign in again" disabled={signOut.pending} onPress={signOut.run} /></Actions>
        {signOut.error === null ? null : <ErrorNotice message={COPY.signOutFailed} />}
      </Stack>
    </Page>
  );
}
