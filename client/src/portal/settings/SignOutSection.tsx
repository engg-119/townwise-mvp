import { useCallback } from 'react';

import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { COPY, errorCopy } from '../errors';
import { useAction } from '../hooks';
import { useReadOnly } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { Section } from '../ui/layout';
import { Small } from '../ui/text';
import { signOutEverywhere } from './api';
import { everywhereHelp, SETTINGS_READ_ONLY_ID } from './copy';

// Sign out (spec P18): “Sign out” and “Sign out on every device”, both text links. Every device is the kit's
// POST /auth/logout-all through the auth client, then this device's own sign-out. Under view-as both are disabled,
// as in the top bar: End view-as is the way out.

const EVERYWHERE_HELP_ID = 'settings-everywhere-help';

/** A sign-out that didn't reach the server keeps the session; any other refusal gets the shared copy. */
function everywhereCopy(error: unknown): string {
  return error instanceof ApiError && error.kind === 'http' ? errorCopy(error) : COPY.signOutFailed;
}

export function SignOutSection(props: { email: string }): React.JSX.Element {
  const auth = useAuth();
  const { readOnly } = useReadOnly();
  const signOut = useAction(useCallback(() => auth.signOut(), [auth]));
  const everywhere = useAction(useCallback(() => signOutEverywhere(auth), [auth]));
  const disabled = readOnly ? { disabled: true } : {};

  return (
    <Section kicker="Sessions" title="Sign out">
      <Small nativeID={EVERYWHERE_HELP_ID}>{everywhereHelp(props.email)}</Small>
      <Actions>
        <Button
          variant="link"
          label="Sign out"
          onPress={signOut.run}
          {...disabled}
          {...(readOnly ? { describedBy: SETTINGS_READ_ONLY_ID } : {})}
        />
        <Button
          variant="link"
          label="Sign out on every device"
          onPress={everywhere.run}
          {...disabled}
          describedBy={readOnly ? `${EVERYWHERE_HELP_ID} ${SETTINGS_READ_ONLY_ID}` : EVERYWHERE_HELP_ID}
        />
      </Actions>
      {signOut.error === null ? null : <ErrorNotice message={COPY.signOutFailed} onRetry={signOut.run} />}
      {everywhere.error === null ? null : <ErrorNotice message={everywhereCopy(everywhere.error)} onRetry={everywhere.run} />}
    </Section>
  );
}
